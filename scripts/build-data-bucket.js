import fs from "node:fs/promises";
import path from "node:path";
import { applySnapshotBatch, comparePublishedAt } from "./snapshot-order.js";

const snapshotDir = path.resolve(process.env.BUCKET_SNAPSHOT_DATA_DIR || "batches");
const outDir = path.resolve(process.env.BUCKET_OUT_DIR || "public/data");
const bucketId = String(process.env.BUCKET_ID || "external").trim();

// A bucket is a mirror of the same galleries main already serves, so by default it
// re-publishes the entire catalog and the site downloads it for nothing. These
// settings let a bucket publish only its share: either the part main does not have
// (BUCKET_EXCLUDE_IDS_FILE) or one id range of the shard scheme (BUCKET_MIN/MAX).
const excludeSource = String(process.env.BUCKET_EXCLUDE_IDS_FILE || "").trim();
const minGalleryId = parseOptionalNumber(process.env.BUCKET_MIN_GALLERY_ID, "BUCKET_MIN_GALLERY_ID");
const maxGalleryId = parseOptionalNumber(process.env.BUCKET_MAX_GALLERY_ID, "BUCKET_MAX_GALLERY_ID");
const shardIndex = parseOptionalNumber(process.env.BUCKET_SHARD, "BUCKET_SHARD");
const publishCatalog = /^(1|true|yes)$/i.test(String(process.env.BUCKET_PUBLISH_CATALOG || "").trim());

function parseOptionalNumber(value, name) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${name}: ${value}`);
  return number;
}

// Only "veil-<n>" ids carry a comparable number. The legacy build-data.js ids are
// "<base36 index>-<hash>" and cannot be range partitioned, so a ranged bucket drops them.
function galleryShardId(id) {
  if (!id.startsWith("veil-")) return null;
  const value = Number(id.slice("veil-".length));
  return Number.isFinite(value) ? value : null;
}

async function loadExcludedIds() {
  if (!excludeSource) return new Set();
  const raw = /^https?:\/\//i.test(excludeSource)
    ? await (async () => {
      const response = await fetch(excludeSource, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Cannot read ${excludeSource}: ${response.status}`);
      return response.json();
    })()
    : JSON.parse(await fs.readFile(path.resolve(excludeSource), "utf8"));
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.albums) ? raw.albums : [];
  return new Set(list.map((entry) => String(entry?.id ?? entry ?? "").trim()).filter(Boolean));
}

function keepGallery(gallery, excludedIds) {
  if (excludedIds.has(gallery.id)) return false;
  if (minGalleryId == null && maxGalleryId == null) return true;
  const shardId = galleryShardId(gallery.id);
  if (shardId == null) return false;
  if (minGalleryId != null && shardId < minGalleryId) return false;
  if (maxGalleryId != null && shardId > maxGalleryId) return false;
  return true;
}

function photoShardKey(id) {
  if (id.startsWith("veil-")) {
    const galleryId = Number(id.slice("veil-".length));
    if (Number.isFinite(galleryId)) return `veil-${Math.floor(galleryId / 25).toString().padStart(5, "0")}`;
  }
  return id.slice(0, 3);
}

function normalizedTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => String(tag || "").trim()).filter(Boolean))];
}

async function loadGalleries() {
  let files = [];
  try {
    files = (await fs.readdir(snapshotDir)).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const galleries = new Map();
  const removedIDs = new Set();
  const revisions = new Map();
  for (const file of files) {
    const batch = JSON.parse(await fs.readFile(path.join(snapshotDir, file), "utf8"));
    if (!Array.isArray(batch.galleries)) throw new Error(`Invalid snapshot batch: ${file}`);
    if (batch.removed_ids !== undefined && !Array.isArray(batch.removed_ids)) {
      throw new Error(`Invalid snapshot removals: ${file}`);
    }
    for (const gallery of batch.galleries) {
      if (!gallery?.id || !Array.isArray(gallery.photos) || gallery.photos.length !== gallery.count) {
        throw new Error(`Invalid snapshot gallery in ${file}: ${gallery?.id || "unknown"}`);
      }
    }
    applySnapshotBatch(batch, file, galleries, removedIDs, revisions);
  }
  return [...galleries.values()].sort(comparePublishedAt);
}

async function main() {
  if (!bucketId) throw new Error("BUCKET_ID is required");
  const allGalleries = await loadGalleries();
  const excludedIds = await loadExcludedIds();
  const galleries = allGalleries.filter((gallery) => keepGallery(gallery, excludedIds));
  const skipped = allGalleries.length - galleries.length;
  const albums = [];
  const shards = new Map();
  const tags = new Set();

  for (const gallery of galleries) {
    const normalized = normalizedTags(gallery.tags);
    const coverPhoto = gallery.photos?.[0];
    for (const tag of normalized) tags.add(tag.toLocaleLowerCase());
    albums.push({
      id: gallery.id,
      title: gallery.title,
      count: gallery.count,
      cover: gallery.cover,
      ...(Number(coverPhoto?.width) > 0 && Number(coverPhoto?.height) > 0
        ? { coverWidth: Number(coverPhoto.width), coverHeight: Number(coverPhoto.height) }
        : {}),
      href: gallery.href || `/album/${gallery.id}`,
      tags: normalized,
      bucket: bucketId,
      ...(gallery.publishedAt ? { publishedAt: gallery.publishedAt } : {})
    });
    const shardKey = photoShardKey(gallery.id);
    if (!shards.has(shardKey)) shards.set(shardKey, {});
    shards.get(shardKey)[gallery.id] = {
      id: gallery.id,
      title: gallery.title,
      count: gallery.count,
      cover: gallery.cover,
      tags: normalized,
      photos: gallery.photos
    };
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outDir, "photo-shards"), { recursive: true });
  // A mirror's album catalog duplicates main's byte for byte (every field main serves is
  // identical), so publishing it costs ~2.9 MB gzipped on first load and buys nothing.
  // The client already has the full catalog from main; it only needs to know which
  // galleries this mirror serves detail shards for, which the manifest range declares.
  // Set BUCKET_PUBLISH_CATALOG=1 to restore the old self-contained behavior.
  if (publishCatalog) {
    await fs.writeFile(path.join(outDir, "albums.json"), `${JSON.stringify(albums)}\n`);
  }
  for (const [shardKey, details] of shards) {
    await fs.writeFile(path.join(outDir, "photo-shards", `${shardKey}.json`), `${JSON.stringify(details)}\n`);
  }
  await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify({
    version: 1,
    bucket: bucketId,
    ...(shardIndex != null ? { shard: shardIndex } : {}),
    ...(minGalleryId != null ? { minGalleryId } : {}),
    ...(maxGalleryId != null ? { maxGalleryId } : {}),
    ...(publishCatalog ? { catalog: "albums.json" } : {}),
    builtAt: new Date().toISOString(),
    albumCount: albums.length,
    photoCount: albums.reduce((total, album) => total + album.count, 0),
    maxPhotosPerAlbum: albums.reduce((maximum, album) => Math.max(maximum, album.count), 0),
    tagCount: tags.size
  })}\n`);
  console.log(`Built ${bucketId}: ${albums.length} albums, ${shards.size} detail shards (skipped ${skipped})${publishCatalog ? "" : ", catalog not published"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
