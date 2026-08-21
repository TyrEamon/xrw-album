import assert from "node:assert/strict";

import worker from "../src/worker.js";

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async first() {
    return this.db.first(this.sql, this.params);
  }

  async run() {
    this.db.runs.push({ sql: this.sql, params: this.params });
    return { success: true };
  }
}

class PublishingD1 {
  constructor() {
    this.runs = [];
    this.batches = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements.map((statement) => ({
      sql: statement.sql,
      params: statement.params
    })));
    return statements.map(() => ({ success: true }));
  }

  async first(sql, params) {
    if (sql.includes("FROM album_sources")) return null;
    if (sql.includes("FROM albums WHERE id = ?")) return null;
    if (sql.includes("MAX(album_order)")) return { max_order: 4, max_offset: 120 };
    if (sql.includes("FROM meta WHERE key = 'manifest'")) {
      return { value: JSON.stringify({ albumCount: 5, photoCount: 120, maxPhotosPerAlbum: 40 }) };
    }
    if (sql.includes("FROM tg_files WHERE public_key = ?")) {
      return {
        file_id: "tg-file-id",
        file_unique_id: "unique-file",
        content_type: "image/jpeg"
      };
    }
    throw new Error(`Unhandled first SQL: ${sql} (${params.join(",")})`);
  }
}

function environment(db) {
  return {
    DB: db,
    ADMIN_TOKEN: "admin-secret",
    TG_BOT_TOKEN: "123456:secret",
    ASSETS: { fetch: () => new Response("asset") }
  };
}

function publishPayload() {
  return {
    id: "veil-21674",
    source: "veil",
    source_gallery_id: 21674,
    source_updated_at: "2026-04-22T20:01:21.629857+00:00",
    title: "Gallery 21674",
    category: "Cosplay",
    tags: ["Fa Tiao Shao Nu", "发条少女"],
    count: 2,
    cover: "https://album.example/file/veil-1191867",
    href: "/album/veil-21674",
    status: "ok",
    photos: [
      {
        source_image_id: 1191867,
        id: 1,
        width: 1200,
        height: 1800,
        url: "https://album.example/file/veil-1191867"
      },
      {
        source_image_id: 1191868,
        id: 2,
        width: 1200,
        height: 1608,
        url: "https://album.example/file/veil-1191868"
      }
    ],
    tg_files: [
      {
        public_key: "veil-1191867",
        url: "https://album.example/file/veil-1191867",
        file_id: "file-1",
        file_unique_id: "unique-1",
        message_id: 1,
        channel_id: "-100123",
        content_type: "image/jpeg"
      },
      {
        public_key: "veil-1191868",
        url: "https://album.example/file/veil-1191868",
        file_id: "file-2",
        file_unique_id: "unique-2",
        message_id: 2,
        channel_id: "-100123",
        content_type: "image/jpeg"
      }
    ]
  };
}

async function call(path, db, init = {}, ctx = undefined) {
  return worker.fetch(new Request(`https://album.example${path}`, init), environment(db), ctx);
}

async function testAdminPublish() {
  const unauthorized = await call("/api/admin/sync/check?id=veil-21674", new PublishingD1());
  assert.equal(unauthorized.status, 401);

  const invalidDb = new PublishingD1();
  const invalid = publishPayload();
  invalid.photos[0].width = 0;
  const invalidResponse = await call("/api/admin/sync/publish", invalidDb, {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-secret",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(invalid)
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalidDb.batches.length, 0);

  const db = new PublishingD1();
  const response = await call("/api/admin/sync/publish", db, {
    method: "POST",
    headers: {
      Authorization: "Bearer admin-secret",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(publishPayload())
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    id: "veil-21674",
    status: "ok",
    published_count: 2,
    tags: 2,
    replaced: false
  });
  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /INSERT INTO albums/);
  assert.match(sql, /INSERT INTO tg_files/);
  assert.match(sql, /INSERT INTO tags/);
  assert.match(sql, /INSERT OR IGNORE INTO album_tags/);
  assert.match(sql, /INSERT INTO meta/);
  assert.match(sql, /FROM json_each/);
  assert.ok(db.batches[0].length <= 11);
  const detailStatement = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO album_details"));
  const storedDetail = JSON.parse(detailStatement.params[1]);
  assert.equal(storedDetail.photo_format, "compact-v1");
  assert.deepEqual(storedDetail.photos[0], [1, 1191867, 1200, 1800, "/file/veil-1191867"]);
}

async function testTelegramProxy() {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cacheEntries = new Map();
  globalThis.caches = {
    default: {
      async match(request) {
        const found = cacheEntries.get(request.url);
        return found ? found.clone() : undefined;
      },
      async put(request, response) {
        cacheEntries.set(request.url, response.clone());
      }
    }
  };
  let telegramCalls = 0;
  globalThis.fetch = async (input) => {
    telegramCalls += 1;
    const url = String(input);
    if (url.endsWith("/getFile")) {
      return Response.json({ ok: true, result: { file_path: "photos/file.jpg" } });
    }
    if (url.includes("/file/bot123456:secret/photos/file.jpg")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/jpeg", "Content-Length": "3" }
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const waits = [];
    const context = { waitUntil(promise) { waits.push(promise); } };
    const first = await call("/file/veil-1191867", new PublishingD1(), {}, context);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [1, 2, 3]);
    await Promise.all(waits);
    assert.equal(telegramCalls, 2);

    const second = await call("/file/veil-1191867", new PublishingD1());
    assert.equal(second.status, 200);
    assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [1, 2, 3]);
    assert.equal(telegramCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

await testAdminPublish();
await testTelegramProxy();
