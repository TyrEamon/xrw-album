import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/index.js";

function d1With(row) {
  return {
    prepare() {
      return {
        bind(publicKey) {
          assert.equal(publicKey, "veil-4630907");
          return { first: async () => row };
        }
      };
    }
  };
}

test("returns 404 without a D1 tg_files mapping", async () => {
  let upstreamCalls = 0;
  const response = await handleRequest(
    new Request("https://cimg.example.com/file/veil-4630907"),
    { TG_BOT_TOKEN: "bot-token", DB: d1With(null) },
    async () => { upstreamCalls += 1; return new Response(); }
  );
  assert.equal(response.status, 404);
  assert.equal(upstreamCalls, 0);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("streams the D1-mapped Telegram file", async () => {
  const requests = [];
  const response = await handleRequest(
    new Request("https://cimg.example.com/file/veil-4630907"),
    {
      TG_BOT_TOKEN: "bot-token",
      DB: d1With({ file_id: "telegram-file-id", file_unique_id: "unique-id", content_type: "image/jpeg" })
    },
    async (input, init = {}) => {
      requests.push({ input: String(input), init });
      if (requests.length === 1) return Response.json({ ok: true, result: { file_path: "documents/photo.jpg" } });
      return new Response("image-bytes", { headers: { "Content-Type": "application/octet-stream" } });
    }
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "image-bytes");
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(response.headers.get("ETag"), '"unique-id"');
  assert.equal(requests.length, 2);
});

test("a cache hit skips both D1 and Telegram", async () => {
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async () => new Response("cached-image", { headers: { "Content-Type": "image/jpeg" } }),
      put: async () => { throw new Error("must not write a cache hit"); }
    }
  };
  try {
    const response = await handleRequest(
      new Request("https://cimg.example.com/file/veil-4630907"),
      {
        DB: { prepare() { throw new Error("must not query D1 on a cache hit"); } }
      },
      async () => { throw new Error("must not fetch a cache hit"); }
    );
    assert.equal(await response.text(), "cached-image");
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
