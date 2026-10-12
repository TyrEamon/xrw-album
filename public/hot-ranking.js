export function rankHotAlbums(albums, seed, shuffle) {
  const ranked = albums
    .filter((album) => Number(album.views) > 0)
    .sort((left, right) => Number(right.views) - Number(left.views) || String(left.id).localeCompare(String(right.id)));
  const tail = shuffle(albums.filter((album) => !(Number(album.views) > 0)), `hot-tail:${seed}`);
  return [...ranked, ...tail];
}
