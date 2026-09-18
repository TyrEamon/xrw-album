import { parseSearch } from "../public/search.js";

export function albumSearchSql(query, tag) {
  const conditions = ["a.publish_status = 'ok'"];
  const params = [];
  for (const term of parseSearch(query, tag)) {
    const value = term.value.toLocaleLowerCase();
    if (term.field === "tag") {
      // Build the matching IDs once using the existing tag indexes, not a
      // correlated tag lookup for every album in the catalog.
      conditions.push(`a.id ${term.exclude ? "NOT IN" : "IN"} (
        SELECT search_at.album_id FROM tags search_t JOIN album_tags search_at ON search_at.tag_id = search_t.id
        WHERE search_t.name_lc = ?
      )`);
      params.push(value);
    } else {
      conditions.push(`a.title_lc ${term.exclude ? "NOT LIKE" : "LIKE"} ? ESCAPE '\\'`);
      params.push(`%${value.replace(/[\\%_]/g, "\\$&")}%`);
    }
  }
  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}
