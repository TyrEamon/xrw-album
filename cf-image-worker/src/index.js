const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const NO_STORE = "no-store";
const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-None-Match, If-Modified-Since",
  "Access-Control-Max-Age": "86400"
});

class HttpError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, fetch, ctx);
  }
};

export async function handleRequest(request, env, fetchImpl = fetch, ctx) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!["GET", "HEAD"].includes(request.method)) return errorResponse("Method not allowed", 405, { Allow: "GET, HEAD, OPTIONS" });
  if (url.pathname === "/health") return Response.json({ ok: true, service: "xrw-album-cimg" }, { headers: { ...CORS_HEADERS, "Cache-Control": NO_STORE } });
  if (!url.pathname.startsWith("/file/")) return errorResponse("Not found", 404);

  try {
    const cache = request.method === "GET" ? globalThis.caches?.default : undefined;
    const canonicalURL = new URL(url);
    canonicalURL.search = "";
    const cacheKey = new Request(canonicalURL, { method: "GET" });
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    }

    if (!env.TG_BOT_TOKEN) throw new HttpError("Telegram proxy is not configured", 503);
    const publicKey = decodeURIComponent(url.pathname.slice("/file/".length));
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(publicKey)) throw new HttpError("Invalid file key", 400);

    const file = await env.DB.prepare(`
      SELECT file_id, file_unique_id, content_type
      FROM tg_files
      WHERE public_key = ?
    `).bind(publicKey).first();
    if (!file) throw new HttpError("Not found", 404);

    const fileResponse = await fetchImpl(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ file_id: file.file_id })
    });
    if (!fileResponse.ok) throw new HttpError("Telegram getFile failed", 502);
    const result = await fileResponse.json();
    const filePath = String(result?.result?.file_path || "");
    if (!result?.ok || !validTelegramPath(filePath)) throw new HttpError("Telegram returned an invalid file path", 502);

    const upstream = await fetchImpl(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${filePath}`, {
      method: request.method,
      redirect: "follow"
    });
    if (!upstream.ok || (request.method === "GET" && !upstream.body)) throw new HttpError("Telegram file download failed", 502);
    const response = imageResponse(upstream, request.method === "HEAD", file.content_type, file.file_unique_id);
    if (cache) {
      const write = cache.put(cacheKey, response.clone());
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    }
    return response;
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(JSON.stringify({ message: "cimg request failed", status }));
    return errorResponse(status >= 500 ? "Image upstream failed" : error.message, status);
  }
}

function validTelegramPath(path) {
  return path.length >= 1 && path.length <= 512 && !path.startsWith("/") && !path.includes("..") && !path.includes("//") && /^[A-Za-z0-9_./-]+$/.test(path);
}

function imageResponse(upstream, headOnly, storedContentType, fileUniqueID) {
  const headers = new Headers(CORS_HEADERS);
  headers.set("Cache-Control", IMAGE_CACHE_CONTROL);
  headers.set("Cloudflare-CDN-Cache-Control", IMAGE_CACHE_CONTROL);
  headers.set("Content-Type", storedContentType || upstream.headers.get("Content-Type") || "image/jpeg");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  for (const name of ["Content-Length", "Last-Modified", "Accept-Ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const etag = fileUniqueID ? `\"${fileUniqueID}\"` : upstream.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  return new Response(headOnly ? null : upstream.body, { status: 200, headers });
}

function errorResponse(message, status, additionalHeaders = {}) {
  return Response.json({ ok: false, error: message }, {
    status,
    headers: { ...CORS_HEADERS, ...additionalHeaders, "Cache-Control": NO_STORE }
  });
}
