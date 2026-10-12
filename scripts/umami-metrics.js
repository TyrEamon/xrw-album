export async function fetchMetricPages({ baseUrl, websiteId, headers, query, pageLimit, maxRows, fetchJson }) {
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += pageLimit) {
    const pageQuery = new URLSearchParams(query);
    pageQuery.set("limit", String(pageLimit));
    pageQuery.set("offset", String(offset));
    const page = await fetchJson(`${baseUrl}/api/websites/${websiteId}/metrics?${pageQuery}`, headers);
    if (!Array.isArray(page)) throw new Error("Umami path metrics response is not an array");
    rows.push(...page);
    if (page.length < pageLimit) return rows;
  }
  console.warn(`Umami path metrics reached UMAMI_MAX_PATH_ROWS=${maxRows}; results may be truncated`);
  return rows;
}
