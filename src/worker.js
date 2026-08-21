import {
  albumPayload,
  albumsPayload,
  healthPayload,
  homePayload,
  json,
  likePayload,
  notFound,
  photosPayload,
  seedFrom
} from "./shared.js";

const MAX_ADMIN_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DETAIL_BYTES = 1_850_000;
const MAX_ALBUM_PHOTOS = 4000;

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

class D1Store {
  constructor(db) {
    this.db = db;
    this.manifestCache = null;
    this.detailCache = new Map();
  }

  async manifest() {
    if (this.manifestCache) return this.manifestCache;
    const row = await this.db.prepare("SELECT value FROM meta WHERE key = 'manifest'").first();
    this.manifestCache = JSON.parse(row?.value || "{}");
    return this.manifestCache;
  }

  async albums({ query = "", tag = "", mode = "all", seed = "default", page = 1, limit = 24 }) {
    const offset = (page - 1) * limit;
    const countWhere = query
      ? "WHERE publish_status = 'ok' AND title_lc LIKE ?"
      : "WHERE publish_status = 'ok'";
    const listWhere = query
      ? "WHERE a.publish_status = 'ok' AND a.title_lc LIKE ?"
      : "WHERE a.publish_status = 'ok'";
    const params = query ? [`%${query}%`] : [];
    const totalRow = tag
      ? await this.db.prepare(`
          SELECT COUNT(DISTINCT a.id) AS total
          FROM albums a
          JOIN album_tags at ON at.album_id = a.id
          JOIN tags t ON t.id = at.tag_id
          WHERE a.publish_status = 'ok' AND t.name_lc = ?
        `).bind(tag).first()
      : await this.db.prepare(`SELECT COUNT(*) AS total FROM albums ${countWhere}`).bind(...params).first();
    const total = Number(totalRow?.total || 0);

    const order = mode === "recent"
      ? "ORDER BY a.album_order DESC"
      : mode === "random"
        ? "ORDER BY ((a.album_order * ? + ?) % 2147483647), a.album_order"
        : "ORDER BY a.album_order ASC";
    const orderParams = mode === "random" ? [1103515245, seedFrom(seed)] : [];
    const rows = tag
      ? await this.db.prepare(`
          SELECT DISTINCT a.id, a.title, a.count, a.cover, a.href, a.album_order, COALESCE(l.count, 0) AS likes
          FROM albums a
          JOIN album_tags at ON at.album_id = a.id
          JOIN tags t ON t.id = at.tag_id
          LEFT JOIN likes_albums l ON l.album_id = a.id
          WHERE a.publish_status = 'ok' AND t.name_lc = ?
          ${order}
          LIMIT ? OFFSET ?
        `).bind(tag, ...orderParams, limit, offset).all()
      : await this.db.prepare(`
          SELECT a.id, a.title, a.count, a.cover, a.href, a.album_order, COALESCE(l.count, 0) AS likes
          FROM albums a
          LEFT JOIN likes_albums l ON l.album_id = a.id
          ${listWhere}
          ${order}
          LIMIT ? OFFSET ?
        `).bind(...params, ...orderParams, limit, offset).all();

    return { total, albums: rows.results || [] };
  }

  async album(albumId) {
    return this.db.prepare(`
      SELECT a.id, a.title, a.count, a.cover, a.href, a.album_order, COALESCE(l.count, 0) AS likes
      FROM albums a
      LEFT JOIN likes_albums l ON l.album_id = a.id
      WHERE a.id = ? AND a.publish_status = 'ok'
    `).bind(albumId).first();
  }

  async albumDetail(albumId) {
    if (this.detailCache.has(albumId)) return this.detailCache.get(albumId);
    const row = await this.db
      .prepare("SELECT detail_json FROM album_details WHERE album_id = ?")
      .bind(albumId)
      .first();
    if (!row) return null;
    const detail = JSON.parse(row.detail_json);
    if (detail.photo_format === "compact-v1" && Array.isArray(detail.photos)) {
      detail.photos = detail.photos.map((photo) => ({
        id: photo[0],
        ...(photo[1] ? { source_image_id: photo[1] } : {}),
        width: photo[2],
        height: photo[3],
        url: photo[4]
      }));
    }
    this.detailCache.set(albumId, detail);
    return detail;
  }

  async albumTags(albumId) {
    const rows = await this.db.prepare(`
      SELECT t.name
      FROM album_tags at
      JOIN tags t ON t.id = at.tag_id
      WHERE at.album_id = ?
      ORDER BY t.name_lc, t.id
    `).bind(albumId).all();
    return (rows.results || []).map((row) => row.name).filter(Boolean);
  }

  async albumByPhotoOffset(offset) {
    return this.db.prepare(`
      SELECT id, title, count, cover, href, album_order, start_offset, end_offset
      FROM albums
      WHERE publish_status = 'ok' AND start_offset <= ? AND end_offset > ?
      LIMIT 1
    `).bind(offset, offset).first();
  }

  async addLikes(albumId, albumDelta, photoLikes) {
    const statements = [];
    if (albumDelta > 0) {
      statements.push(
        this.db.prepare(`
          INSERT INTO likes_albums (album_id, count) VALUES (?, ?)
          ON CONFLICT(album_id) DO UPDATE SET count = likes_albums.count + excluded.count
        `).bind(albumId, albumDelta)
      );
    }
    if (photoLikes.length > 0) {
      statements.push(
        this.db.prepare(`
          INSERT INTO likes_photos (album_id, photo_id, count)
          SELECT ?, json_extract(value, '$.photoId'), json_extract(value, '$.delta')
          FROM json_each(?)
          WHERE true
          ON CONFLICT(album_id, photo_id) DO UPDATE SET
            count = likes_photos.count + excluded.count
        `).bind(albumId, JSON.stringify(photoLikes))
      );
    }
    if (statements.length > 0) await this.db.batch(statements);
    const row = await this.db.prepare("SELECT count FROM likes_albums WHERE album_id = ?").bind(albumId).first();
    return Number(row?.count || 0);
  }
}

async function handleApi(request, env, url) {
  const store = new D1Store(env.DB);
  if (url.pathname.startsWith("/api/admin/sync/")) return handleAdmin(request, env, url);
  if (request.method === "GET" && url.pathname === "/api/health") return json(await healthPayload(store));
  if (request.method === "GET" && url.pathname === "/api/home") return json(await homePayload(store, url));
  if (request.method === "GET" && url.pathname === "/api/albums") return json(await albumsPayload(store, url));
  if (request.method === "GET" && url.pathname === "/api/photos") return json(await photosPayload(store, url));
  if (request.method === "GET" && url.pathname.startsWith("/api/album/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/album/".length));
    const payload = await albumPayload(store, id);
    return payload ? json(payload) : notFound();
  }
  if (request.method === "POST" && url.pathname === "/api/like") return likePayload(store, request);
  return notFound();
}

async function handleAdmin(request, env, url) {
  if (!await isAuthorized(request, env.ADMIN_TOKEN)) {
    return json({ ok: false, error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/sync/check") {
    const id = url.searchParams.get("id") || "";
    if (!validIdentifier(id)) throw new ApiError("Invalid album id");
    return json(await checkPublishedAlbum(env.DB, id));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/sync/publish") {
    const payload = validatePublishPayload(await readLimitedJson(request, MAX_ADMIN_BODY_BYTES));
    return json({ ok: true, ...await publishAlbum(env.DB, payload) });
  }
  return notFound();
}

async function checkPublishedAlbum(db, id) {
  const row = await db.prepare(`
    SELECT a.publish_status, a.source_updated_at, a.count, a.storage_provider,
           a.mirror_status, d.detail_json
    FROM albums a
    LEFT JOIN album_details d ON d.album_id = a.id
    WHERE a.id = ?
  `).bind(id).first();
  if (!row) {
    return {
      ok: true,
      status: "missing",
      source_updated_at: "",
      expected_count: 0,
      published_count: 0
    };
  }
  let publishedCount = 0;
  try {
    const detail = JSON.parse(row.detail_json || "{}");
    publishedCount = Array.isArray(detail.photos) ? detail.photos.length : 0;
  } catch {
    publishedCount = 0;
  }
  return {
    ok: true,
    status: row.publish_status,
    source_updated_at: row.source_updated_at,
    expected_count: Number(row.count || 0),
    published_count: publishedCount,
    storage_provider: row.storage_provider,
    mirror_status: row.mirror_status
  };
}

async function publishAlbum(db, payload) {
  const sourceRow = await db.prepare(
    "SELECT album_id FROM album_sources WHERE source = ? AND source_gallery_id = ?"
  ).bind(payload.source, payload.sourceGalleryId).first();
  if (sourceRow && sourceRow.album_id !== payload.id) {
    throw new ApiError("Source gallery already belongs to another album", 409);
  }

  const existing = await db.prepare(`
    SELECT id, source, source_gallery_id, album_order, start_offset, end_offset, count
    FROM albums WHERE id = ?
  `).bind(payload.id).first();
  if (existing && existing.source_gallery_id && (
    existing.source !== payload.source || existing.source_gallery_id !== payload.sourceGalleryId
  )) {
    throw new ApiError("Album id already belongs to another source gallery", 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const updatedAt = new Date().toISOString();
  const storedCover = new URL(payload.cover).pathname;
  const detailJson = JSON.stringify({
    id: payload.id,
    title: payload.title,
    category: payload.category,
    count: payload.count,
    cover: storedCover,
    href: payload.href,
    photo_format: "compact-v1",
    photos: payload.photos.map((photo) => [
      photo.id,
      photo.source_image_id || 0,
      photo.width,
      photo.height,
      new URL(photo.url).pathname
    ])
  });
  if (new TextEncoder().encode(detailJson).byteLength > MAX_DETAIL_BYTES) {
    throw new ApiError("Album detail is too large for one D1 row", 413);
  }

  const statements = [
    db.prepare(`
      UPDATE albums
      SET start_offset = start_offset + (? - (SELECT count FROM albums WHERE id = ?)),
          end_offset = end_offset + (? - (SELECT count FROM albums WHERE id = ?))
      WHERE album_order > (SELECT album_order FROM albums WHERE id = ?)
        AND ? <> (SELECT count FROM albums WHERE id = ?)
    `).bind(
      payload.count, payload.id, payload.count, payload.id,
      payload.id, payload.count, payload.id
    ),
    db.prepare(`
      INSERT INTO albums (
        id, title, title_lc, count, cover, href, album_order, start_offset, end_offset,
        category, source, source_gallery_id, source_updated_at, publish_status,
        storage_provider, mirror_status, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?,
             COALESCE(MAX(album_order), -1) + 1,
             COALESCE(MAX(end_offset), 0),
             COALESCE(MAX(end_offset), 0) + ?,
             ?, ?, ?, ?, 'ok', 'telegram', 'ok', ?
      FROM albums
      WHERE true
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, title_lc = excluded.title_lc, count = excluded.count,
        cover = excluded.cover, href = excluded.href,
        album_order = albums.album_order,
        start_offset = albums.start_offset,
        end_offset = albums.start_offset + excluded.count,
        category = excluded.category, source = excluded.source,
        source_gallery_id = excluded.source_gallery_id,
        source_updated_at = excluded.source_updated_at,
        publish_status = excluded.publish_status,
        storage_provider = excluded.storage_provider,
        mirror_status = excluded.mirror_status, updated_at = excluded.updated_at
    `).bind(
      payload.id, payload.title, payload.title.toLocaleLowerCase(), payload.count,
      storedCover, payload.href, payload.count, payload.category,
      payload.source, payload.sourceGalleryId, payload.sourceUpdatedAt, now
    ),
    db.prepare(`
      INSERT INTO album_details (album_id, detail_json) VALUES (?, ?)
      ON CONFLICT(album_id) DO UPDATE SET detail_json = excluded.detail_json
    `).bind(payload.id, detailJson),
    db.prepare(`
      INSERT INTO album_sources (source, source_gallery_id, album_id, source_updated_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, source_gallery_id) DO UPDATE SET
        album_id = excluded.album_id,
        source_updated_at = excluded.source_updated_at,
        updated_at = excluded.updated_at
    `).bind(payload.source, payload.sourceGalleryId, payload.id, payload.sourceUpdatedAt, now),
    db.prepare("DELETE FROM album_tags WHERE album_id = ?").bind(payload.id)
  ];

  statements.push(db.prepare(`
      INSERT INTO tg_files (
        public_key, file_id, file_unique_id, message_id, content_type, updated_at
      )
      SELECT
        json_extract(value, '$.publicKey'),
        json_extract(value, '$.fileId'),
        json_extract(value, '$.fileUniqueId'),
        json_extract(value, '$.messageId'),
        json_extract(value, '$.contentType'),
        ?
      FROM json_each(?)
      WHERE true
      ON CONFLICT(public_key) DO UPDATE SET
        file_id = excluded.file_id,
        file_unique_id = excluded.file_unique_id, message_id = excluded.message_id,
        content_type = excluded.content_type,
        updated_at = excluded.updated_at
    `).bind(now, JSON.stringify(payload.tgFiles)));

  const tagRows = payload.tags.map((name) => ({ name, nameLc: name.toLocaleLowerCase() }));
  statements.push(
    db.prepare(`
      INSERT INTO tags (source, name, name_lc, updated_at)
      SELECT ?, json_extract(value, '$.name'), json_extract(value, '$.nameLc'), ?
      FROM json_each(?)
      WHERE true
      ON CONFLICT(source, name) DO UPDATE SET
        name_lc = excluded.name_lc, updated_at = excluded.updated_at
    `).bind(payload.source, now, JSON.stringify(tagRows)),
    db.prepare(`
      INSERT OR IGNORE INTO album_tags (album_id, tag_id)
      SELECT ?, tags.id
      FROM tags
      JOIN json_each(?) AS incoming
        ON tags.name = json_extract(incoming.value, '$.name')
      WHERE tags.source = ?
    `).bind(payload.id, JSON.stringify(tagRows), payload.source)
  );
  statements.push(db.prepare(`
    INSERT INTO meta (key, value)
    VALUES (
      'manifest',
      json_set(
        COALESCE((SELECT value FROM meta WHERE key = 'manifest'), '{}'),
        '$.albumCount', (SELECT COUNT(*) FROM albums WHERE publish_status = 'ok'),
        '$.photoCount', (SELECT COALESCE(SUM(count), 0) FROM albums WHERE publish_status = 'ok'),
        '$.maxPhotosPerAlbum', (SELECT COALESCE(MAX(count), 0) FROM albums WHERE publish_status = 'ok'),
        '$.updatedAt', ?
      )
    )
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(updatedAt));

  await db.batch(statements);
  return {
    id: payload.id,
    status: "ok",
    published_count: payload.count,
    tags: payload.tags.length,
    replaced: Boolean(existing)
  };
}

function validatePublishPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("Invalid publish payload");
  const id = boundedString(raw.id, "id", 160);
  const source = boundedString(raw.source, "source", 40);
  const sourceGalleryId = boundedString(raw.source_gallery_id, "source_gallery_id", 160);
  if (!validIdentifier(id) || !validIdentifier(source) || !validIdentifier(sourceGalleryId)) {
    throw new ApiError("Invalid id or source identifier");
  }
  if (raw.status !== "ok") throw new ApiError("Only complete albums can be published");
  const count = Number(raw.count);
  if (!Number.isInteger(count) || count <= 0 || count > MAX_ALBUM_PHOTOS) {
    throw new ApiError(`count must be between 1 and ${MAX_ALBUM_PHOTOS}`);
  }
  if (!Array.isArray(raw.photos) || raw.photos.length !== count) {
    throw new ApiError("photos length does not match count");
  }
  if (!Array.isArray(raw.tg_files) || raw.tg_files.length !== count) {
    throw new ApiError("tg_files length does not match count");
  }

  const publicKeys = new Set();
  const urls = new Set();
  const photos = raw.photos.map((photo, index) => {
    if (!photo || typeof photo !== "object") throw new ApiError(`Invalid photo at ${index + 1}`);
    const photoId = Number(photo.id);
    const width = Number(photo.width);
    const height = Number(photo.height);
    const url = httpsUrl(photo.url, `photos[${index}].url`);
    if (photoId !== index + 1) throw new ApiError("Photo ids must be consecutive from 1");
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new ApiError(`Photo ${photoId} is missing width or height`);
    }
    const sourceImageId = Number(photo.source_image_id);
    if (source === "veil" && (!Number.isSafeInteger(sourceImageId) || sourceImageId <= 0)) {
      throw new ApiError(`Photo ${photoId} is missing source_image_id`);
    }
    return {
      id: photoId,
      ...(Number.isSafeInteger(sourceImageId) && sourceImageId > 0 ? { source_image_id: sourceImageId } : {}),
      width,
      height,
      url
    };
  });
  const tgFiles = raw.tg_files.map((file, index) => {
    if (!file || typeof file !== "object") throw new ApiError(`Invalid tg_file at ${index + 1}`);
    const publicKey = boundedString(file.public_key, `tg_files[${index}].public_key`, 200);
    const url = httpsUrl(file.url, `tg_files[${index}].url`);
    const fileId = boundedString(file.file_id, `tg_files[${index}].file_id`, 1024);
    if (!validIdentifier(publicKey)) throw new ApiError(`Invalid Telegram public key at ${index + 1}`);
    if (url !== photos[index].url) throw new ApiError(`Telegram URL mismatch at photo ${index + 1}`);
    if (new URL(url).pathname !== `/file/${publicKey}`) {
      throw new ApiError(`Telegram public key mismatch at photo ${index + 1}`);
    }
    if (source === "veil" && publicKey !== `veil-${photos[index].source_image_id}`) {
      throw new ApiError(`Veil public key mismatch at photo ${index + 1}`);
    }
    if (publicKeys.has(publicKey) || urls.has(url)) throw new ApiError("Duplicate Telegram file mapping");
    publicKeys.add(publicKey);
    urls.add(url);
    return {
      publicKey,
      url,
      fileId,
      fileUniqueId: optionalString(file.file_unique_id, 1024),
      messageId: nonNegativeInteger(file.message_id),
      channelId: optionalString(file.channel_id, 160),
      contentType: imageContentType(file.content_type)
    };
  });
  const tags = [...new Set((Array.isArray(raw.tags) ? raw.tags : [])
    .map((tag) => String(tag || "").trim())
    .filter(Boolean)
    .map((tag) => tag.slice(0, 200)))].slice(0, 200);
  const cover = httpsUrl(raw.cover, "cover");
  if (cover !== photos[0].url) throw new ApiError("cover must match the first photo URL");
  const imageOrigin = new URL(cover).origin;
  if (photos.some((photo) => new URL(photo.url).origin !== imageOrigin)) {
    throw new ApiError("All photo URLs must use the same origin");
  }
  const sourceUpdatedAt = optionalString(raw.source_updated_at, 100);
  if (source === "veil" && !sourceUpdatedAt) throw new ApiError("Veil albums require source_updated_at");
  return {
    id,
    source,
    sourceGalleryId,
    sourceUpdatedAt,
    title: boundedString(raw.title, "title", 500),
    category: optionalString(raw.category, 160),
    count,
    cover,
    href: albumHref(raw.href, id),
    photos,
    tgFiles,
    tags
  };
}

async function handleTelegramFile(request, env, url, ctx) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
  }
  const publicKey = decodeURIComponent(url.pathname.slice("/file/".length));
  if (!validIdentifier(publicKey)) return notFound();
  const cache = globalThis.caches?.default;
  const canonicalUrl = new URL(url);
  canonicalUrl.search = "";
  const cacheKey = new Request(canonicalUrl.toString(), { method: "GET" });
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) return request.method === "HEAD" ? headResponse(cached) : cached;

  if (!env.TG_BOT_TOKEN) throw new ApiError("Telegram file service is not configured", 503);
  const file = await env.DB.prepare(`
    SELECT file_id, file_unique_id, content_type FROM tg_files WHERE public_key = ?
  `).bind(publicKey).first();
  if (!file) return notFound();
  const getFileResponse = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ file_id: file.file_id })
  });
  if (!getFileResponse.ok) throw new ApiError("Telegram getFile failed", 502);
  const getFileResult = await getFileResponse.json();
  const filePath = String(getFileResult?.result?.file_path || "");
  if (!getFileResult?.ok || !filePath || filePath.includes("..")) {
    throw new ApiError("Telegram returned an invalid file path", 502);
  }
  const upstream = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${filePath}`);
  if (!upstream.ok || !upstream.body) throw new ApiError("Telegram file download failed", 502);
  const headers = new Headers({
    "Content-Type": file.content_type || upstream.headers.get("Content-Type") || "image/jpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff"
  });
  const contentLength = upstream.headers.get("Content-Length");
  if (contentLength) headers.set("Content-Length", contentLength);
  if (file.file_unique_id) headers.set("ETag", `"${file.file_unique_id}"`);
  const response = new Response(upstream.body, { status: 200, headers });
  if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return request.method === "HEAD" ? headResponse(response) : response;
}

function headResponse(response) {
  return new Response(null, { status: response.status, headers: response.headers });
}

async function isAuthorized(request, expected) {
  if (!expected) return false;
  const header = request.headers.get("Authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(left, right);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function readLimitedJson(request, maximum) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maximum) throw new ApiError("Request body is too large", 413);
  if (!request.body) throw new ApiError("Missing request body");
  const reader = request.body.getReader();
  const parts = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new ApiError("Request body is too large", 413);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("Invalid request body");
  }
}

function boundedString(value, field, maximum) {
  const result = String(value ?? "").trim();
  if (!result || result.length > maximum) throw new ApiError(`Invalid ${field}`);
  return result;
}

function optionalString(value, maximum) {
  return String(value ?? "").trim().slice(0, maximum);
}

function validIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(value);
}

function httpsUrl(value, field) {
  const result = boundedString(value, field, 2048);
  let parsed;
  try {
    parsed = new URL(result);
  } catch {
    throw new ApiError(`Invalid ${field}`);
  }
  if (parsed.protocol !== "https:") throw new ApiError(`${field} must use https`);
  return parsed.toString();
}

function albumHref(value, id) {
  const result = boundedString(value, "href", 240);
  if (result !== `/album/${id}`) throw new ApiError("href must match the album id");
  return result;
}

function nonNegativeInteger(value) {
  const result = Number(value || 0);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}

function imageContentType(value) {
  const result = optionalString(value, 100).toLocaleLowerCase();
  return /^image\/[a-z0-9.+-]+$/.test(result) ? result : "image/jpeg";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/file/")) return await handleTelegramFile(request, env, url, ctx);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (!["GET", "HEAD"].includes(request.method)) {
        return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      console.error(JSON.stringify({
        level: "error",
        message: error instanceof Error ? error.message : String(error),
        method: request.method,
        pathname: url.pathname,
        status
      }));
      return json({
        ok: false,
        error: status >= 500 ? "Internal server error" : error.message
      }, status);
    }
  }
};
