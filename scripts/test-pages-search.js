import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A tiny build fixture avoids copying the full photo archive or downloading dependencies.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await fs.mkdtemp(path.join(root, ".pages-search-"));
assert.ok(fixture.startsWith(root + path.sep));
try {
  for (const dir of ["scripts", "public", "data/photos"]) await fs.mkdir(path.join(fixture, dir), { recursive: true });
  for (const file of ["scripts/build-gh-pages.js", "scripts/snapshot-order.js", "public/index.html", "public/app.js", "public/styles.css", "public/search.js"]) {
    await fs.copyFile(path.join(root, file), path.join(fixture, file));
  }
  await fs.writeFile(path.join(fixture, "data/albums.json"), "[]");
  await fs.writeFile(path.join(fixture, "data/manifest.json"), "{}");
  for (const base of ["/", "xrw-album"]) {
    execFileSync(process.execPath, [path.join(fixture, "scripts/build-gh-pages.js")], {
      cwd: fixture,
      env: { ...process.env, GITHUB_PAGES_BASE: base, SNAPSHOT_DATA_DIR: "", EXTERNAL_DATA_SOURCES: "", GIMG_PUBLIC_BASE: "", JSON_FALLBACK_BASE: "" }
    });
    const output = path.join(fixture, "dist-gh-pages");
    const html = await fs.readFile(path.join(output, "index.html"), "utf8");
    const prefix = base === "/" ? "" : "/xrw-album";
    assert.ok(html.includes(`src="${prefix}/app.js?v=20260918-1"`));
    assert.ok(html.includes(`href="${prefix}/styles.css?v=20260918-1"`));
    assert.ok(html.includes(`window.__XRW_STATIC_DATA_BASE = "${prefix}/data"`));
    assert.equal(await fs.readFile(path.join(output, "search.js"), "utf8"), await fs.readFile(path.join(root, "public/search.js"), "utf8"));
    const js = await fs.readFile(path.join(output, "app.js"), "utf8");
    assert.match(js, /from "\.\/search\.js\?v=20260918-1"/);
    assert.equal(await fs.readFile(path.join(output, "404.html"), "utf8"), html);
  }
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
console.log("Pages build: custom domain and /xrw-album/ paths include the search module and versioned assets.");
