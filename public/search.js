// Shared by GitHub Pages, the local preview and the D1 Worker.
export class SearchQueryError extends Error {}

export function parseSearch(query = "", tag = "") {
  const source = String(query).replace(/[“”]/g, '"');
  if (source.length > 512) throw new SearchQueryError("搜索内容最多 512 个字符，请精简关键词。");
  const terms = [];
  let index = 0;
  while (index < source.length) {
    if (/[\s+＋]/u.test(source[index])) { index += 1; continue; }
    const exclude = source[index] === "-";
    if (exclude) index += 1;
    const field = /^tag[:：]/i.test(source.slice(index)) ? "tag" : "title";
    if (field === "tag") index += 4;
    let value = "";
    let quoted = false;
    let phrase = false;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\" && /["\\]/.test(source[index + 1] || "")) {
        value += source[index + 1];
        index += 2;
      } else if (char === '"') {
        quoted = !quoted;
        phrase = true;
        index += 1;
      } else if (!quoted && /[\s+＋]/u.test(char)) {
        break;
      } else {
        value += char;
        index += 1;
      }
    }
    if (quoted) throw new SearchQueryError("引号还没有闭合，请补上右引号。");
    value = value.trim();
    if (!value) throw new SearchQueryError(field === "tag" ? "请在 tag: 后填写标签名称。" : "请填写要搜索或排除的关键词。");
    terms.push({ field, value, exclude, phrase });
  }
  if (String(tag).trim()) terms.push({ field: "tag", value: String(tag).trim(), exclude: false, phrase: false });
  if (terms.length > 24) throw new SearchQueryError("最多组合 24 个搜索条件，请减少关键词。");
  return terms;
}

export function matchesSearch(album, terms) {
  const title = String(album.title || "").toLocaleLowerCase();
  // Only inspect tags when a tag condition is present.
  let tags;
  return terms.every((term) => {
    const value = term.value.toLocaleLowerCase();
    let found;
    if (term.field === "tag") {
      tags ||= (Array.isArray(album.tags) ? album.tags : []).map((name) => String(name || "").trim().toLocaleLowerCase());
      found = tags.includes(value);
    } else {
      found = title.includes(value);
    }
    return term.exclude ? !found : found;
  });
}

export function quoteSearchValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function formatTermValue(term) {
  return term.phrase || /[\s+＋"\\]/u.test(term.value) || /^-|^tag[:：]/i.test(term.value)
    ? quoteSearchValue(term.value) : term.value;
}

export function searchToFields(query) {
  const fields = { all: [], phrase: "", exclude: [], tags: [] };
  for (const term of parseSearch(query)) {
    if (term.field === "tag" && !term.exclude) fields.tags.push(formatTermValue(term));
    else if (term.field === "title" && term.exclude) fields.exclude.push(formatTermValue(term));
    else if (term.field === "title" && term.phrase && !fields.phrase) fields.phrase = term.value;
    else fields.all.push(`${term.exclude ? "-" : ""}${term.field === "tag" ? "tag:" : ""}${formatTermValue(term)}`);
  }
  return { ...fields, all: fields.all.join(" "), exclude: fields.exclude.join(" "), tags: fields.tags.join(" ") };
}

export function buildSearchQuery({ all = "", phrase = "", exclude = "", tags = "" }) {
  const parts = [all.trim()];
  if (phrase.trim()) parts.push(quoteSearchValue(phrase.trim()));
  for (const term of parseSearch(exclude)) parts.push(`-${quoteSearchValue(term.value)}`);
  for (const term of parseSearch(tags)) parts.push(`tag:${quoteSearchValue(term.value)}`);
  const query = parts.filter(Boolean).join(" ");
  parseSearch(query);
  return query;
}
