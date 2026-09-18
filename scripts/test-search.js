import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { parseSearch, matchesSearch, buildSearchQuery, searchToFields, SearchQueryError } from "../public/search.js";
import worker from "../src/worker.js";
import { albumSearchSql } from "../src/search-sql.js";

// Real SQLite exercises the actual Worker SQL and bound parameters.
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
  CREATE TABLE albums (id TEXT PRIMARY KEY, title TEXT, title_lc TEXT, count INTEGER, cover TEXT, href TEXT, album_order INTEGER, publish_status TEXT);
  CREATE TABLE likes_albums (album_id TEXT PRIMARY KEY, count INTEGER);
  CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT, name_lc TEXT);
  CREATE TABLE album_tags (album_id TEXT, tag_id INTEGER, PRIMARY KEY(album_id, tag_id));
  CREATE INDEX idx_tags_name_lc ON tags(name_lc);
  CREATE INDEX idx_album_tags_tag ON album_tags(tag_id, album_id);
`);
const albums = [
  { id: "a", title: "神楽坂真冬 夏日 护士", tags: ["护士", "Bao Ji Shao Nu"] },
  { id: "b", title: "护士-神楽坂真冬-口罩", tags: ["Cosplay"] },
  { id: "c", title: "神楽坂真冬 女仆", tags: ["护士服"] },
  { id: "d", title: "护士 蠢沫沫", tags: ["护士"] },
  { id: "e", title: "Bao Ji Shao Nu Azur-Lane 100%_special C++", tags: ["Cosplay"] },
  { id: "f", title: 'NIKKE \\ archive "quoted"', tags: ["NIKKE"] },
  { id: "g", title: "Bao cute Ji Shao Nu 100X_special", tags: [] },
  { id: "hidden", title: "神楽坂真冬 护士", tags: ["护士"], hidden: true }
];
const insert = sqlite.prepare("INSERT INTO albums VALUES (?, ?, ?, 1, '', '', ?, ?)");
const insertTag = sqlite.prepare("INSERT INTO tags VALUES (?, ?, ?)");
const insertLink = sqlite.prepare("INSERT INTO album_tags VALUES (?, ?)");
const tagIds = new Map();
for (const [index, album] of albums.entries()) {
  insert.run(album.id, album.title, album.title.toLocaleLowerCase(), index, album.hidden ? "pending" : "ok");
  for (const name of album.tags) {
    if (!tagIds.has(name)) { tagIds.set(name, tagIds.size + 1); insertTag.run(tagIds.get(name), name, name.toLocaleLowerCase()); }
    insertLink.run(album.id, tagIds.get(name));
  }
}
const DB = {
  prepare(sql) {
    const stmt = sqlite.prepare(sql);
    let params = [];
    return {
      bind(...values) { params = values; return this; },
      async first() { return stmt.get(...params) || null; },
      async all() { return { results: stmt.all(...params), success: true }; }
    };
  }
};
const cases = [
  ["神楽坂真冬 护士", ["a", "b"]],
  ["护士+神楽坂真冬", ["a", "b"]],
  ["神楽坂真冬＋护士", ["a", "b"]],
  ["神楽坂真冬\t护士 -口罩", ["a"]],
  ['"神楽坂真冬 护士"', []],
  ['“Bao Ji Shao Nu”', ["e"]],
  ["Bao Ji Shao Nu", ["e", "g"]],
  ['tag:"Bao Ji Shao Nu" 护士', ["a"]],
  ["tag:护士", ["a", "d"]],
  ["护士 -tag:Cosplay", ["a", "d"]],
  ["神楽坂真冬 -tag:护士", ["b", "c"]],
  ["Azur-Lane", ["e"]],
  ["100%_special", ["e"]],
  ['"C++"', ["e"]],
  ['"\\\\ archive"', ["f"]],
  ['"\\"quoted\\""', ["f"]],
  ["' OR 1=1 --", []],
  ["护士", ["a"], "Bao Ji Shao Nu"],
  ["女仆", [], "护士"]
];
for (const [query, expected, tag = ""] of cases) {
  const staticIds = albums.filter((album) => !album.hidden && matchesSearch(album, parseSearch(query, tag))).map((album) => album.id);
  assert.deepEqual(staticIds, expected, `Pages: ${query}`);
  const url = new URL("https://example.test/api/albums");
  url.search = new URLSearchParams({ q: query, tag, limit: 8 });
  const response = await worker.fetch(new Request(url), { DB }, {});
  assert.equal(response.status, 200, query);
  const body = await response.json();
  assert.equal(body.total, expected.length, query);
  assert.deepEqual(body.albums.map((album) => album.id), expected, `Worker: ${query}`);
  // Opening and applying the form must preserve the same conditions.
  const rebuilt = buildSearchQuery(searchToFields(query));
  assert.deepEqual(albums.filter((album) => !album.hidden && matchesSearch(album, parseSearch(rebuilt, tag))).map((album) => album.id), expected, `Form round trip: ${query}`);
}
for (const query of ['"unfinished', "tag:", "-", "a".repeat(513), Array(25).fill("a").join(" ")]) {
  assert.throws(() => parseSearch(query), SearchQueryError);
  const url = new URL("https://example.test/api/albums");
  url.searchParams.set("q", query);
  const response = await worker.fetch(new Request(url), { DB }, {});
  assert.equal(response.status, 400, query);
}
const filters = buildSearchQuery({ all: "神楽坂真冬 护士", exclude: "口罩", tags: '"Bao Ji Shao Nu"' });
assert.deepEqual(albums.filter((a) => !a.hidden && matchesSearch(a, parseSearch(filters))).map((a) => a.id), ["a"]);
const tagQuery = albumSearchSql('tag:护士', '');
const plan = sqlite.prepare(`EXPLAIN QUERY PLAN SELECT a.id FROM albums a ${tagQuery.where}`).all(...tagQuery.params).map(row => row.detail).join('\n');
assert.match(plan, /idx_tags_name_lc/);
assert.match(plan, /idx_album_tags_tag/);
assert.doesNotMatch(plan, /CORRELATED/);
sqlite.close();
console.log(`Search: ${cases.length} Pages / SQLite / form cases and 5 invalid-query cases passed.`);
