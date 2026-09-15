export function applySnapshotBatch(batch, file, galleries, removedIDs, revisions, rewrite = (gallery) => gallery) {
  const parsedTime = Date.parse(batch.exported_at || "");
  const time = Number.isFinite(parsedTime) ? parsedTime : Number.NEGATIVE_INFINITY;
  const publishedAt = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : "";
  const isCurrent = (id) => {
    const previous = revisions.get(id);
    return !previous || time > previous.time || (time === previous.time && file >= previous.file);
  };

  for (const id of batch.removed_ids || []) {
    if (!isCurrent(id)) continue;
    galleries.delete(id);
    removedIDs.add(id);
    revisions.set(id, { time, file });
  }
  for (const gallery of batch.galleries) {
    if (!isCurrent(gallery.id)) continue;
    galleries.delete(gallery.id);
    removedIDs.delete(gallery.id);
    galleries.set(gallery.id, { ...rewrite(gallery), publishedAt });
    revisions.set(gallery.id, { time, file });
  }
}

export function comparePublishedAt(left, right) {
  const leftAt = left.publishedAt || "";
  const rightAt = right.publishedAt || "";
  return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : 0;
}
