import test from "node:test";
import assert from "node:assert/strict";
import { fetchMetricPages } from "./umami-metrics.js";

test("fetchMetricPages follows offsets until Umami returns a short page", async () => {
  const calls = [];
  const pages = [[{ x: "/album/a", y: 3 }, { x: "/album/b", y: 2 }], [{ x: "/album/c", y: 1 }]];
  const rows = await fetchMetricPages({
    baseUrl: "https://umami.test",
    websiteId: "site",
    headers: {},
    query: new URLSearchParams({ limit: "2" }),
    pageLimit: 2,
    maxRows: 10,
    fetchJson: async (url) => { calls.push(new URL(url)); return pages[calls.length - 1]; }
  });
  assert.deepEqual(rows.flatMap((row) => row.x), ["/album/a", "/album/b", "/album/c"]);
  assert.deepEqual(calls.map((url) => url.searchParams.get("offset")), ["0", "2"]);
});

test("fetchMetricPages warns when the configured safety cap is reached", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const rows = await fetchMetricPages({
      baseUrl: "https://umami.test",
      websiteId: "site",
      headers: {},
      query: new URLSearchParams(),
      pageLimit: 2,
      maxRows: 4,
      fetchJson: async () => [{ x: "/album/a", y: 1 }, { x: "/album/b", y: 1 }]
    });
    assert.equal(rows.length, 4);
    assert.match(warnings[0], /UMAMI_MAX_PATH_ROWS=4/);
  } finally { console.warn = originalWarn; }
});

test("fetchMetricPages rejects unexpected API payload shapes", async () => {
  await assert.rejects(() => fetchMetricPages({
    baseUrl: "https://umami.test",
    websiteId: "site",
    headers: {},
    query: new URLSearchParams(),
    pageLimit: 2,
    maxRows: 4,
    fetchJson: async () => ({ data: [] })
  }), /response is not an array/);
});
