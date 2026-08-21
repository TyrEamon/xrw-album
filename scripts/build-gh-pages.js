import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "dist-gh-pages");
const repoName = process.env.GITHUB_PAGES_BASE ?? "xrw-album";
const normalizedRepoName = repoName.replace(/^\/+|\/+$/g, "");
const basePath = normalizedRepoName ? `/${normalizedRepoName}` : "";
const snapshotDir = process.env.SNAPSHOT_DATA_DIR
  ? path.resolve(rootDir, process.env.SNAPSHOT_DATA_DIR)
  : "";
const githubImageBase = String(process.env.GIMG_PUBLIC_BASE || "").replace(/\/+$/g, "");

function rewriteGitHubImageUrl(value) {
  if (!githubImageBase || typeof value !== "string" || value === "") return value;
  try {
    const source = new URL(value);
    if (source.hostname.toLowerCase() !== "telegra.ph" || !source.pathname.startsWith("/file/")) return value;
    return `${githubImageBase}/telegraph${source.pathname}`;
  } catch {
    return value;
  }
}

function rewriteGalleryImages(gallery) {
  return {
    ...gallery,
    cover: rewriteGitHubImageUrl(gallery.cover),
    photos: Array.isArray(gallery.photos)
      ? gallery.photos.map((photo) => ({ ...photo, url: rewriteGitHubImageUrl(photo.url) }))
      : gallery.photos
  };
}

async function copyFile(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function copyDir(source, target) {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

function photoShardKey(id) {
  if (id.startsWith("veil-")) {
    const galleryId = Number(id.slice("veil-".length));
    if (Number.isFinite(galleryId)) return `veil-${Math.floor(galleryId / 25).toString().padStart(5, "0")}`;
  }
  return id.slice(0, 3);
}

async function loadSnapshotGalleries() {
  if (!snapshotDir) return [];
  try {
    const files = (await fs.readdir(snapshotDir)).filter((file) => file.endsWith(".json")).sort();
    const galleries = new Map();
    for (const file of files) {
      const batch = JSON.parse(await fs.readFile(path.join(snapshotDir, file), "utf8"));
      if (!Array.isArray(batch.galleries)) throw new Error(`Invalid snapshot batch: ${file}`);
      for (const gallery of batch.galleries) {
        if (!gallery?.id || !Array.isArray(gallery.photos) || gallery.photos.length !== gallery.count) {
          throw new Error(`Invalid snapshot gallery in ${file}: ${gallery?.id || "unknown"}`);
        }
        galleries.set(gallery.id, rewriteGalleryImages(gallery));
      }
    }
    return [...galleries.values()].sort((left, right) => left.source_gallery_id - right.source_gallery_id);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writePhotoShards(snapshotGalleries) {
  const photosDir = path.join(rootDir, "data/photos");
  const shardDir = path.join(outDir, "data/photo-shards");
  const files = await fs.readdir(photosDir);
  const shards = new Map();

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    const shard = photoShardKey(id);
    if (!shards.has(shard)) shards.set(shard, {});
    const gallery = JSON.parse(await fs.readFile(path.join(photosDir, file), "utf8"));
    shards.get(shard)[id] = rewriteGalleryImages(gallery);
  }

  for (const gallery of snapshotGalleries) {
    const shard = photoShardKey(gallery.id);
    if (!shards.has(shard)) shards.set(shard, {});
    shards.get(shard)[gallery.id] = {
      id: gallery.id,
      title: gallery.title,
      count: gallery.count,
      cover: gallery.cover,
      photos: gallery.photos
    };
  }

  await fs.mkdir(shardDir, { recursive: true });
  for (const [shard, details] of shards) {
    await fs.writeFile(path.join(shardDir, `${shard}.json`), `${JSON.stringify(details)}\n`);
  }
  return {
    albumDetailCount: [...shards.values()].reduce((count, shard) => count + Object.keys(shard).length, 0),
    shardCount: shards.size
  };
}

function countUniqueSnapshotTags(snapshotGalleries) {
  const unique = new Set();
  for (const gallery of snapshotGalleries) {
    if (!Array.isArray(gallery.tags)) continue;
    for (const tag of gallery.tags) {
      const name = String(tag || "").trim();
      if (name) unique.add(name.toLocaleLowerCase());
    }
  }
  return unique.size;
}

async function writeAlbumsAndManifest(snapshotGalleries) {
  const baseAlbums = JSON.parse(await fs.readFile(path.join(rootDir, "data/albums.json"), "utf8"));
  const albums = new Map(baseAlbums.map((album) => [album.id, {
    ...album,
    cover: rewriteGitHubImageUrl(album.cover)
  }]));
  for (const gallery of snapshotGalleries) {
    albums.set(gallery.id, {
      id: gallery.id,
      title: gallery.title,
      count: gallery.count,
      cover: gallery.cover,
      href: gallery.href || `/album/${gallery.id}`
    });
  }
  const combined = [...albums.values()].map((album, order) => ({ ...album, order }));
  const baseManifest = JSON.parse(await fs.readFile(path.join(rootDir, "data/manifest.json"), "utf8"));
  const manifest = {
    ...baseManifest,
    builtAt: new Date().toISOString(),
    albumCount: combined.length,
    photoCount: combined.reduce((count, album) => count + album.count, 0),
    maxPhotosPerAlbum: combined.reduce((maximum, album) => Math.max(maximum, album.count), 0),
    snapshotAlbumCount: snapshotGalleries.length,
    tagCount: countUniqueSnapshotTags(snapshotGalleries)
  };
  await fs.writeFile(path.join(outDir, "data/albums.json"), `${JSON.stringify(combined)}\n`);
  await fs.writeFile(path.join(outDir, "data/manifest.json"), `${JSON.stringify(manifest)}\n`);
}

function pagesIndex(html) {
  const config = `
    <script>
      window.__XRW_BASE_PATH = ${JSON.stringify(basePath)};
      window.__XRW_STATIC_DATA_BASE = ${JSON.stringify(`${basePath}/data`)};
    </script>`;

  return html
    .replace('href="/favicon.svg?v=1"', `href="${basePath}/favicon.svg?v=1"`)
    .replace('href="/lib/fancybox.css?v=20260821-1"', `href="${basePath}/lib/fancybox.css?v=20260821-1"`)
    .replace('href="/styles.css?v=20260821-8"', `href="${basePath}/styles.css?v=20260821-8"`)
    .replace('src="/lib/fancybox.umd.js?v=20260821-1"', `src="${basePath}/lib/fancybox.umd.js?v=20260821-1"`)
    .replace('src="/app.js?v=20260821-8"', `src="${basePath}/app.js?v=20260821-8"`)
    .replace("  </head>", `${config}\n  </head>`);
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  await copyDir(path.join(rootDir, "public"), outDir);
  await fs.mkdir(path.join(outDir, "data"), { recursive: true });
  const snapshotGalleries = await loadSnapshotGalleries();
  await writeAlbumsAndManifest(snapshotGalleries);
  const shardStats = await writePhotoShards(snapshotGalleries);

  const indexPath = path.join(outDir, "index.html");
  const html = await fs.readFile(indexPath, "utf8");
  const rendered = pagesIndex(html);
  await fs.writeFile(indexPath, rendered);
  await fs.writeFile(path.join(outDir, "404.html"), rendered);
  await fs.writeFile(path.join(outDir, ".nojekyll"), "");

  console.log(`Built GitHub Pages static site at ${path.relative(rootDir, outDir)}`);
  console.log(`Base path: ${basePath}`);
  console.log(`Album details: ${shardStats.albumDetailCount}`);
  console.log(`Photo detail shards: ${shardStats.shardCount}`);
  console.log(`Snapshot albums: ${snapshotGalleries.length}`);
  console.log(`Unique tags: ${countUniqueSnapshotTags(snapshotGalleries)}`);
  console.log(`GitHub image proxy: ${githubImageBase || "disabled"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
