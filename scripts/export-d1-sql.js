import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const photosDir = path.join(dataDir, "photos");

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? String(Math.trunc(number)) : "0";
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function maybeReadLikes() {
  try {
    return await readJson(path.join(dataDir, "likes.json"));
  } catch {
    return { albums: {}, photos: {} };
  }
}

function insert(table, values) {
  const columns = Object.keys(values);
  const rendered = columns.map((column) => values[column]);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${rendered.join(", ")});`;
}

function upsert(table, values, conflictColumns, updateColumns = null) {
  const columns = Object.keys(values);
  const updates = updateColumns || columns.filter((column) => !conflictColumns.includes(column));
  const base = insert(table, values).slice(0, -1);
  if (updates.length === 0) {
    return `${base} ON CONFLICT(${conflictColumns.join(", ")}) DO NOTHING;`;
  }
  return `${base} ON CONFLICT(${conflictColumns.join(", ")}) DO UPDATE SET ${updates
    .map((column) => `${column} = excluded.${column}`)
    .join(", ")};`;
}

async function main() {
  const outArg = argValue("--out", "data/d1-seed.sql");
  const limitArg = argValue("--limit");
  const offsetArg = argValue("--offset", "0");
  const withTransaction = process.argv.includes("--transaction");
  const reset = process.argv.includes("--reset");
  const limit = limitArg ? Math.max(1, Number(limitArg)) : null;
  const offset = Math.max(0, Number(offsetArg) || 0);
  const outFile = path.resolve(rootDir, outArg);
  const albums = await readJson(path.join(dataDir, "albums.json"));
  const sourceManifest = await readJson(path.join(dataDir, "manifest.json"));
  const likes = await maybeReadLikes();
  const selectedAlbums = albums.slice(offset, limit ? offset + limit : undefined);

  const lines = reset ? [
    "DELETE FROM album_tags;",
    "DELETE FROM tags;",
    "DELETE FROM tg_files;",
    "DELETE FROM likes_photos;",
    "DELETE FROM likes_albums;",
    "DELETE FROM album_sources;",
    "DELETE FROM album_details;",
    "DELETE FROM albums;",
    "DELETE FROM meta;"
  ] : [];
  if (withTransaction) {
    lines.unshift("PRAGMA foreign_keys = OFF;", "BEGIN TRANSACTION;");
  }

  let runningPhotoTotal = albums.slice(0, offset)
    .reduce((total, album) => total + Number(album.count || 0), 0);
  let exportedPhotoTotal = 0;
  const exportedAt = new Date();
  const updatedAt = Math.floor(exportedAt.getTime() / 1000);
  const selectedAlbumIds = new Set(selectedAlbums.map((album) => album.id));

  for (const album of selectedAlbums) {
    const detail = await readJson(path.join(photosDir, `${album.id}.json`));
    const startOffset = runningPhotoTotal;
    const endOffset = startOffset + detail.photos.length;
    runningPhotoTotal = endOffset;
    exportedPhotoTotal += detail.photos.length;

    lines.push(upsert("albums", {
      id: sqlString(album.id),
      title: sqlString(album.title),
      title_lc: sqlString(album.title.toLocaleLowerCase()),
      count: sqlNumber(detail.photos.length),
      cover: sqlString(album.cover),
      href: sqlString(album.href),
      album_order: sqlNumber(album.order),
      start_offset: sqlNumber(startOffset),
      end_offset: sqlNumber(endOffset),
      category: sqlString(""),
      source: sqlString("linuxdo-85w"),
      source_gallery_id: sqlString(album.id),
      source_updated_at: sqlString(sourceManifest.builtAt || ""),
      publish_status: sqlString("ok"),
      storage_provider: sqlString("telegraph"),
      mirror_status: sqlString("pending"),
      updated_at: sqlNumber(updatedAt)
    }, ["id"]));

    lines.push(upsert("album_details", {
      album_id: sqlString(album.id),
      detail_json: sqlString(JSON.stringify({
        ...detail,
        count: detail.photos.length
      }))
    }, ["album_id"]));

    lines.push(upsert("album_sources", {
      source: sqlString("linuxdo-85w"),
      source_gallery_id: sqlString(album.id),
      album_id: sqlString(album.id),
      source_updated_at: sqlString(sourceManifest.builtAt || ""),
      updated_at: sqlNumber(updatedAt)
    }, ["source", "source_gallery_id"]));

    const albumLikeCount = Number(likes.albums?.[album.id] || 0);
    if (albumLikeCount > 0) {
      lines.push(upsert("likes_albums", {
        album_id: sqlString(album.id),
        count: sqlNumber(albumLikeCount)
      }, ["album_id"], []));
    }
  }

  for (const [key, count] of Object.entries(likes.photos || {})) {
    const [albumId, photoId] = key.split(":");
    if (!selectedAlbumIds.has(albumId)) continue;
    const value = Number(count || 0);
    if (value <= 0) continue;
    lines.push(upsert("likes_photos", {
      album_id: sqlString(albumId),
      photo_id: sqlNumber(photoId),
      count: sqlNumber(value)
    }, ["album_id", "photo_id"], []));
  }

  lines.push(`INSERT INTO meta (key, value)
VALUES (
  'manifest',
  json_set(
    COALESCE((SELECT value FROM meta WHERE key = 'manifest'), '{}'),
    '$.builtAt', ${sqlString(sourceManifest.builtAt || "")},
    '$.source', ${sqlString(sourceManifest.source || "")},
    '$.albumCount', (SELECT COUNT(*) FROM albums WHERE publish_status = 'ok'),
    '$.photoCount', (SELECT COALESCE(SUM(count), 0) FROM albums WHERE publish_status = 'ok'),
    '$.maxPhotosPerAlbum', (SELECT COALESCE(MAX(count), 0) FROM albums WHERE publish_status = 'ok'),
    '$.d1ExportedAt', ${sqlString(exportedAt.toISOString())},
    '$.d1SourceAlbumCount', ${sqlNumber(albums.length)},
    '$.d1Limited', json(${sqlString(JSON.stringify(Boolean(limit || offset)))})
  )
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
  if (withTransaction) {
    lines.push("COMMIT;");
    lines.push("PRAGMA foreign_keys = ON;");
  }

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, `${lines.join("\n")}\n`);
  console.log(`Wrote ${selectedAlbums.length} albums and ${exportedPhotoTotal} photos from offset ${offset} to ${path.relative(rootDir, outFile)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
