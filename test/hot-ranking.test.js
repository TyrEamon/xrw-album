import test from "node:test";
import assert from "node:assert/strict";
import { rankHotAlbums } from "../public/hot-ranking.js";

test("ranks every album with views and randomizes only zero-view tail", () => {
  const albums = [
    { id: "z", views: 0 },
    { id: "b", views: 2 },
    { id: "a", views: 5 },
    { id: "d", views: 1 },
    { id: "c", views: undefined }
  ];
  const shuffled = [];
  const result = rankHotAlbums(albums, "seed", (tail, seed) => {
    shuffled.push({ tail: tail.map((item) => item.id), seed });
    return [...tail].reverse();
  });
  assert.deepEqual(result.slice(0, 3).map((item) => item.id), ["a", "b", "d"]);
  assert.deepEqual(result.slice(3).map((item) => item.id), ["c", "z"]);
  assert.deepEqual(shuffled, [{ tail: ["z", "c"], seed: "hot-tail:seed" }]);
  assert.equal(new Set(result.map((item) => item.id)).size, albums.length);
});
