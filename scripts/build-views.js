// 拉取 Umami 里 /album/<id> 的访问量，写成 data/views.json 供 build-gh-pages.js 使用。
// 没配 UMAMI_SHARE_ID 时直接跳过；出错也只警告，不拦住站点构建。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputPath = process.env.UMAMI_VIEWS_FILE
  ? path.resolve(rootDir, process.env.UMAMI_VIEWS_FILE)
  : path.join(rootDir, "data/views.json");

const baseUrl = String(process.env.UMAMI_BASE_URL || "https://u.mtcacg.top").replace(/\/+$/g, "");
const shareId = String(process.env.UMAMI_SHARE_ID || "").trim();
const pathPrefix = String(process.env.UMAMI_PATH_PREFIX || "/album/").trim();
const windowDays = Math.max(1, Number(process.env.UMAMI_WINDOW_DAYS || 30));
const pathLimit = Math.max(1, Number(process.env.UMAMI_PATH_LIMIT || 1000));

function albumIdFromPath(value) {
  if (!value.startsWith(pathPrefix)) return "";
  const id = value.slice(pathPrefix.length).split(/[?#]/)[0].replace(/\/+$/g, "");
  if (!id) return "";
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function main() {
  if (!shareId) {
    console.log("UMAMI_SHARE_ID is not set, skipping album view counts");
    return;
  }

  const share = await fetchJson(`${baseUrl}/api/share/${encodeURIComponent(shareId)}`);
  const websiteId = String(share?.websiteId || "");
  const token = String(share?.token || "");
  if (!websiteId || !token) throw new Error("Umami share response is missing websiteId or token");

  const endAt = Date.now();
  const startAt = endAt - windowDays * 24 * 60 * 60 * 1000;
  const query = new URLSearchParams({
    startAt: String(startAt),
    endAt: String(endAt),
    type: "path",
    limit: String(pathLimit),
    timezone: "Asia/Shanghai"
  });
  const metrics = await fetchJson(`${baseUrl}/api/websites/${websiteId}/metrics?${query}`, {
    "x-umami-share-token": token,
    "x-umami-share-context": "1"
  });

  const views = new Map();
  for (const row of Array.isArray(metrics) ? metrics : []) {
    const id = albumIdFromPath(String(row?.x || ""));
    const count = Number(row?.y);
    if (!id || !Number.isFinite(count) || count <= 0) continue;
    views.set(id, (views.get(id) || 0) + count);
  }

  const payload = [...views.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id, count]) => ({ id, views: count }));
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Album view counts: ${payload.length} albums from the last ${windowDays} days`);
}

main().catch((error) => {
  console.warn(`Album view counts unavailable: ${error.message}`);
});
