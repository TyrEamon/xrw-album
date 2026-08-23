import fs from "node:fs/promises";
import path from "node:path";

const snapshotDir = path.resolve(process.env.BUCKET_SNAPSHOT_DATA_DIR || "batches");
const outDir = path.resolve(process.env.BUCKET_OUT_DIR || "public/data");
const bucketId = String(process.env.BUCKET_ID || "external").trim();

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
  for (const file of files) {
    const batch = JSON.parse(await fs.readFile(path.join(snapshotDir, file), "utf8"));
    if (!Array.isArray(batch.galleries)) throw new Error(`Invalid snapshot batch: ${file}`);
    for (const gallery of batch.galleries) {
      if (!gallery?.id || !Array.isArray(gallery.photos) || gallery.photos.length !== gallery.count) {
        throw new Error(`Invalid snapshot gallery in ${file}: ${gallery?.id || "unknown"}`);
      }
      galleries.set(gallery.id, gallery);
    }
  }
  return [...galleries.values()];
}

async function main() {
  if (!bucketId) throw new Error("BUCKET_ID is required");
  const galleries = await loadGalleries();
  const albums = [];
  const shards = new Map();
  const tags = new Set();

  for (const gallery of galleries) {
    const normalized = normalizedTags(gallery.tags);
    for (const tag of normalized) tags.add(tag.toLocaleLowerCase());
    albums.push({
      id: gallery.id,
      title: gallery.title,
      count: gallery.count,
      cover: gallery.cover,
      href: gallery.href || `/album/${gallery.id}`,
      tags: normalized,
      bucket: bucketId
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
  await fs.writeFile(path.join(outDir, "albums.json"), `${JSON.stringify(albums)}\n`);
  for (const [shardKey, details] of shards) {
    await fs.writeFile(path.join(outDir, "photo-shards", `${shardKey}.json`), `${JSON.stringify(details)}\n`);
  }
  await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify({
    version: 1,
    bucket: bucketId,
    builtAt: new Date().toISOString(),
    albumCount: albums.length,
    photoCount: albums.reduce((total, album) => total + album.count, 0),
    maxPhotosPerAlbum: albums.reduce((maximum, album) => Math.max(maximum, album.count), 0),
    tagCount: tags.size
  })}\n`);
  console.log(`Built ${bucketId}: ${albums.length} albums, ${shards.size} detail shards`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
