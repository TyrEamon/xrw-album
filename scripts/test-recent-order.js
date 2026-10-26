import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { applySnapshotBatch, comparePublishedAt } from "./snapshot-order.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gallery = (id, title) => ({ id, title, count: 1, cover: "cover", photos: [{ id: 1, url: "image" }] });
const galleries = new Map();
const removedIDs = new Set();
const revisions = new Map();

applySnapshotBatch({ exported_at: "2026-09-13T07:09:40Z", galleries: [gallery("beide", "new")] },
  "beide-snapshot-new.json", galleries, removedIDs, revisions);
applySnapshotBatch({ exported_at: "2026-09-03T14:32:48Z", galleries: [gallery("veil", "old"), gallery("beide", "stale")] },
  "snapshot-old.json", galleries, removedIDs, revisions);
assert.equal(galleries.get("beide").title, "new", "Older snapshot must not replace newer data");
assert.deepEqual([...galleries.values()].sort(comparePublishedAt).map((item) => item.id), ["veil", "beide"]);

applySnapshotBatch({ exported_at: "2026-09-02T00:00:00Z", galleries: [], removed_ids: ["beide"] },
  "snapshot-stale-removal.json", galleries, removedIDs, revisions);
assert.equal(removedIDs.has("beide"), false, "Older removal must not hide a newer gallery");
applySnapshotBatch({ exported_at: "2026-09-14T00:00:00Z", galleries: [], removed_ids: ["veil"] },
  "snapshot-new-removal.json", galleries, removedIDs, revisions);
assert.equal(removedIDs.has("veil"), true, "New removal must hide the gallery");

const appSource = await fs.readFile(path.join(rootDir, "public/app.js"), "utf8");
const start = appSource.indexOf("function mergeStaticCatalogAlbums(");
const end = appSource.indexOf("\nfunction staticShuffledAlbums(", start);
assert.ok(start >= 0 && end > start, "Static catalog merge function must be present");
const merge = vm.runInNewContext(`${appSource.slice(start, end)}\nmergeStaticCatalogAlbums`);
const merged = merge([
  { albums: [
    { id: "archive", title: "legacy" },
    { id: "beide", title: "new", publishedAt: "2026-09-13T07:09:40.000Z" }
  ] },
  { albums: [
    { id: "veil", title: "old", publishedAt: "2026-09-03T14:32:48.000Z" },
    { id: "beide", title: "stale copy", publishedAt: "2026-09-02T00:00:00.000Z" }
  ] }
]);
assert.deepEqual(Array.from(merged, (item) => item.id), ["archive", "veil", "beide"]);
assert.equal(merged.at(-1).title, "new", "Latest published gallery must lead the recent list");

const tempDir = await fs.mkdtemp(path.join(rootDir, ".recent-order-"));
if (!path.resolve(tempDir).startsWith(`${rootDir}${path.sep}`)) throw new Error("Test directory is outside the workspace");
try {
  const batches = path.join(tempDir, "batches");
  const output = path.join(tempDir, "output");
  await fs.mkdir(batches);
  await fs.writeFile(path.join(batches, "beide-snapshot-new.json"), JSON.stringify({
    exported_at: "2026-09-13T07:09:40Z",
    galleries: [gallery("beide", "new")]
  }));
  await fs.writeFile(path.join(batches, "snapshot-old.json"), JSON.stringify({
    exported_at: "2026-09-03T14:32:48Z",
    galleries: [gallery("veil", "old")]
  }));
  execFileSync(process.execPath, [path.join(rootDir, "scripts/build-data-bucket.js")], {
    cwd: rootDir,
    env: {
      ...process.env,
      BUCKET_ID: "test",
      BUCKET_SNAPSHOT_DATA_DIR: batches,
      BUCKET_OUT_DIR: output,
      // A mirror no longer publishes a duplicate catalog by default, but the ordering
      // assertions below are about the catalog itself, so ask for it explicitly.
      BUCKET_PUBLISH_CATALOG: "1"
    }
  });
  const built = JSON.parse(await fs.readFile(path.join(output, "albums.json"), "utf8"));
  assert.deepEqual(built.map((item) => item.id), ["veil", "beide"]);
  assert.equal(built[1].publishedAt, "2026-09-13T07:09:40.000Z");

  // Default build: shards only, range declared in the manifest, no catalog to download.
  // Range partitioning only understands "veil-<n>" ids, so use those here.
  const leanBatches = path.join(tempDir, "batches-lean");
  await fs.mkdir(leanBatches);
  await fs.writeFile(path.join(leanBatches, "lean.json"), JSON.stringify({
    exported_at: "2026-09-13T07:09:40Z",
    galleries: [gallery("veil-7", "in range"), gallery("veil-40000", "out of range")]
  }));
  const leanOut = path.join(tempDir, "output-lean");
  execFileSync(process.execPath, [path.join(rootDir, "scripts/build-data-bucket.js")], {
    cwd: rootDir,
    env: {
      ...process.env,
      BUCKET_ID: "test",
      BUCKET_SNAPSHOT_DATA_DIR: leanBatches,
      BUCKET_OUT_DIR: leanOut,
      BUCKET_MIN_GALLERY_ID: "1",
      BUCKET_MAX_GALLERY_ID: "33720"
    }
  });
  await assert.rejects(fs.access(path.join(leanOut, "albums.json")), "A mirror must not publish a duplicate catalog");
  const leanManifest = JSON.parse(await fs.readFile(path.join(leanOut, "manifest.json"), "utf8"));
  assert.equal(leanManifest.catalog, undefined, "Manifest must not advertise a catalog it does not ship");
  assert.equal(leanManifest.minGalleryId, 1);
  assert.equal(leanManifest.maxGalleryId, 33720);
  assert.equal(leanManifest.albumCount, 1, "Range must keep only in-range galleries");
  const leanShards = await fs.readdir(path.join(leanOut, "photo-shards"));
  assert.equal(leanShards.length, 1, "Mirror must still publish detail shards");
  const leanShard = JSON.parse(await fs.readFile(path.join(leanOut, "photo-shards", leanShards[0]), "utf8"));
  assert.deepEqual(Object.keys(leanShard), ["veil-7"], "Shard must carry the in-range gallery only");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("Recent ordering, duplicate revisions, and removals passed");
