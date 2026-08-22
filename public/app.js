const app = document.querySelector("#app");
const imageSizeCache = new Map();
const pendingLikes = new Map();

const PAGE_SIZE = 32;
const PHOTO_PAGE_SIZE = 72;
const TAG_PAGE_SIZE = 300;
const PHOTO_ROWS_PER_PAGE = 8;
const DETAIL_ROWS_PER_PAGE = 8;
const DETAIL_SIZE_KEY = "xrw-album-detail-size";
const DETAIL_VIEW_KEY = "xrw-album-detail-view";
const PREFETCH_DELAY = 120;
const ALBUM_PAGE_RENDER_MARGIN = 900;
const PHOTO_PAGE_RENDER_MARGIN = 650;
const DETAIL_PAGE_RENDER_MARGIN = 650;
const IMAGE_SIZE_CACHE_LIMIT = 1600;
const MAX_RENDERED_ALBUM_PAGES = 2;
const MAX_RENDERED_PHOTO_PAGES = 2;
const MAX_RENDERED_DETAIL_PAGES = 2;
const STATIC_DATA_BASE = window.__XRW_STATIC_DATA_BASE || "";
const BASE_PATH = normalizeBasePath(window.__XRW_BASE_PATH || "");

let homeManifest = null;
let smoothScroll = null;
let activeTab = "photos";
let infiniteObserver = null;
let searchTimer = null;
let searchPage = 1;
let searchQuery = "";
let searchTag = "";
let tagDirectoryState = null;
let currentAlbum = null;
let lightboxIndex = null;
let detailImageScale = readDetailImageScale();
let detailViewMode = readDetailViewMode();
let tabs = createTabsState();
let albumSyncFrame = null;
let photoSyncFrame = null;
let photoResizeTimer = null;
let photoRelayoutTimer = null;
let detailSyncFrame = null;
let detailResizeTimer = null;
let detailRelayoutTimer = null;
let lastAutoLoadAt = 0;

const staticData = {
  manifest: null,
  albums: null,
  details: new Map(),
  shards: new Map(),
  photoOffsets: new Map(),
  photoOrders: new Map(),
  randomAlbums: new Map(),
  tags: null,
  likes: readStaticLikes()
};

function normalizeBasePath(value) {
  const path = String(value || "").replace(/\/+$/, "");
  return path === "/" ? "" : path;
}

function appPathname() {
  const pathname = location.pathname || "/";
  if (BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`))) {
    return pathname.slice(BASE_PATH.length) || "/";
  }
  return pathname;
}

function appUrl(path) {
  if (!BASE_PATH || /^https?:\/\//i.test(path)) return path;
  return `${BASE_PATH}${path === "/" ? "" : path}`;
}

function dataUrl(path) {
  const base = STATIC_DATA_BASE || `${BASE_PATH || ""}/data`;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function readStaticLikes() {
  try {
    return JSON.parse(localStorage.getItem("xrw-album-static-likes") || '{"albums":{},"photos":{}}');
  } catch {
    return { albums: {}, photos: {} };
  }
}

function saveStaticLikes() {
  try {
    localStorage.setItem("xrw-album-static-likes", JSON.stringify(staticData.likes));
  } catch {
    // Static GitHub Pages builds keep likes local when storage is available.
  }
}

function createTabsState() {
  return {
    photos: {
      photos: [],
      pages: [],
      page: 0,
      total: 0,
      hasMore: true,
      loading: false,
      prefetch: null,
      prefetching: false,
      prefetchKey: "",
      prefetchPromise: null,
      mode: "random",
      seed: String(Date.now()),
      photoLayoutKey: ""
    },
    albums: {
      albums: [],
      pages: [],
      page: 0,
      total: 0,
      hasMore: true,
      loading: false,
      prefetch: null,
      prefetching: false,
      prefetchKey: "",
      prefetchPromise: null,
      seed: "albums",
      order: "desc"
    },
    recent: {
      albums: [],
      pages: [],
      page: 0,
      total: 0,
      hasMore: true,
      loading: false,
      prefetch: null,
      prefetching: false,
      prefetchKey: "",
      prefetchPromise: null,
      seed: "recent"
    },
    random: {
      albums: [],
      pages: [],
      page: 0,
      total: 0,
      hasMore: true,
      loading: false,
      prefetch: null,
      prefetching: false,
      prefetchKey: "",
      prefetchPromise: null,
      seed: String(Date.now())
    }
  };
}

// Lucide Icons v1.33.0, ISC License. Only the icons used by this page are embedded.
function lucideIcon(name, paths) {
  return `<svg class="lucide lucide-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const icons = {
  moon: lucideIcon("moon", '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>'),
  sun: lucideIcon("sun", '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
  search: lucideIcon("search", '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>'),
  refresh: lucideIcon("refresh-cw", '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>'),
  arrow: lucideIcon("arrow-up-right", '<path d="M7 7h10v10M7 17 17 7"/>'),
  back: lucideIcon("chevron-left", '<path d="m15 18-6-6 6-6"/>'),
  heart: lucideIcon("heart", '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/>'),
  up: lucideIcon("arrow-up", '<path d="m5 12 7-7 7 7M12 19V5"/>'),
  sort: lucideIcon("arrow-up-down", '<path d="m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16"/>')
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeImageUrl(value) {
  return String(value || "")
    .replace("https://telegra.phhttps://legra.ph/file/", "https://telegra.ph/file/")
    .replace("https://telegra.phhttps//legra.ph/file/", "https://telegra.ph/file/");
}

function seedFrom(value) {
  const input = String(value || Date.now());
  let seed = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    seed ^= input.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

function random(seed) {
  let state = seed || 1;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function sample(source, count, seedValue) {
  const result = [];
  const used = new Set();
  const rand = random(seedFrom(seedValue));
  const limit = Math.min(count, source.length);

  while (result.length < limit) {
    const index = Math.floor(rand() * source.length);
    if (used.has(index)) continue;
    used.add(index);
    result.push(source[index]);
  }

  return result;
}

async function getJson(url, options) {
  if (STATIC_DATA_BASE && String(url).startsWith("/api/")) {
    return staticGetJson(url, options);
  }

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    ...options
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function staticGetJson(url, options = {}) {
  const requestUrl = new URL(url, location.origin);
  const path = requestUrl.pathname;

  if ((options.method || "GET").toUpperCase() === "POST" && path === "/api/like") {
    return staticLikeResponse(options);
  }

  if (path === "/api/health") {
    const manifest = await staticManifest();
    return {
      ok: true,
      albumCount: manifest.albumCount,
      photoCount: manifest.photoCount,
      tagCount: Number(manifest.tagCount) || 0,
      builtAt: manifest.builtAt
    };
  }

  if (path === "/api/home") {
    const manifest = await staticManifest();
    const albums = await staticAlbums();
    const seed = requestUrl.searchParams.get("seed") || Date.now();
    const recentSeed = requestUrl.searchParams.get("recentSeed");
    const recentAlbums = [...albums].reverse();
    return {
      ok: true,
      manifest,
      recentAlbums: (recentSeed ? sample(recentAlbums, 16, recentSeed) : recentAlbums.slice(0, 16)).map(withStaticLike),
      albums: sample(albums, 16, seed).map(withStaticLike)
    };
  }

  if (path === "/api/albums") {
    return staticAlbumsResponse(requestUrl);
  }

  if (path === "/api/tags") {
    return staticTagsResponse(requestUrl);
  }

  if (path === "/api/photos") {
    return staticPhotosResponse(requestUrl);
  }

  if (path.startsWith("/api/album/")) {
    const id = decodeURIComponent(path.slice("/api/album/".length));
    const albums = await staticAlbums();
    const album = albums.find((item) => item.id === id);
    if (!album) throw new Error("Not found");
    const detail = await staticAlbumDetail(id);
    return {
      ok: true,
      album: withStaticLike(album),
      tags: normalizeTags(detail.tags || album.tags),
      photos: detail.photos.map((photo) => ({
        ...photo,
        url: normalizeImageUrl(photo.url)
      })),
      likeCount: staticData.likes.albums[id] || 0
    };
  }

  throw new Error(`Static route not found: ${path}`);
}

async function fetchStaticJson(path) {
  const response = await fetch(dataUrl(path), {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Static data failed: ${response.status}`);
  return response.json();
}

async function staticManifest() {
  if (!staticData.manifest) {
    staticData.manifest = await fetchStaticJson("manifest.json");
  }
  return staticData.manifest;
}

async function staticAlbums() {
  if (!staticData.albums) {
    staticData.albums = await fetchStaticJson("albums.json");
  }
  return staticData.albums;
}

async function staticAlbumDetail(id) {
  if (!staticData.details.has(id)) {
    const shardKey = photoShardKey(id);
    if (!staticData.shards.has(shardKey)) {
      staticData.shards.set(shardKey, await fetchStaticJson(`photo-shards/${encodeURIComponent(shardKey)}.json`));
    }
    const detail = staticData.shards.get(shardKey)?.[id];
    if (!detail) throw new Error(`Static album detail not found: ${id}`);
    staticData.details.set(id, detail);
  }
  return staticData.details.get(id);
}

function photoShardKey(id) {
  if (id.startsWith("veil-")) {
    const galleryId = Number(id.slice("veil-".length));
    if (Number.isFinite(galleryId)) return `veil-${Math.floor(galleryId / 25).toString().padStart(5, "0")}`;
  }
  return id.slice(0, 3);
}

function withStaticLike(album) {
  return {
    ...album,
    cover: normalizeImageUrl(album.cover),
    likes: staticData.likes.albums[album.id] || 0
  };
}

function staticShuffledAlbums(albums, seedValue) {
  const key = String(seedValue || "default");
  if (staticData.randomAlbums.has(key)) return staticData.randomAlbums.get(key);

  const result = [...albums];
  const rand = random(seedFrom(key));
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rand() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  staticData.randomAlbums.set(key, result);
  while (staticData.randomAlbums.size > 8) {
    staticData.randomAlbums.delete(staticData.randomAlbums.keys().next().value);
  }
  return result;
}

async function staticAlbumsResponse(requestUrl) {
  const albums = await staticAlbums();
  const query = (requestUrl.searchParams.get("q") || "").trim().toLocaleLowerCase();
  const tag = (requestUrl.searchParams.get("tag") || "").trim().toLocaleLowerCase();
  const mode = requestUrl.searchParams.get("mode") || "all";
  const seed = requestUrl.searchParams.get("seed") || "default";
  const page = Math.max(1, Number(requestUrl.searchParams.get("page") || 1));
  const limit = Math.min(48, Math.max(8, Number(requestUrl.searchParams.get("limit") || 24)));
  const matched = tag
    ? albums.filter((album) => normalizeTags(album.tags).some((name) => name.toLocaleLowerCase() === tag))
    : query
      ? albums.filter((album) => album.title.toLocaleLowerCase().includes(query))
    : mode === "recent"
      ? [...albums].reverse()
      : mode === "random"
        ? staticShuffledAlbums(albums, seed)
        : albums;
  const start = (page - 1) * limit;

  return {
    ok: true,
    mode,
    seed,
    page,
    limit,
    total: matched.length,
    albums: matched.slice(start, start + limit).map(withStaticLike)
  };
}

async function staticPhotoOffsets(mode = "sequence", seedValue = "photos") {
  const key = mode === "random" ? `random:${seedValue}` : "sequence";
  if (staticData.photoOffsets.has(key)) return staticData.photoOffsets.get(key);

  const albums = await staticAlbums();
  const orderedAlbums = mode === "random"
    ? staticShuffledAlbums(albums, `photos:${seedValue}`)
    : [...albums].reverse();
  let running = 0;
  const offsets = orderedAlbums.map((album) => {
    const entry = {
      album,
      start: running,
      end: running + album.count
    };
    running = entry.end;
    return entry;
  });
  staticData.photoOffsets.set(key, offsets);
  while (staticData.photoOffsets.size > 8) {
    staticData.photoOffsets.delete(staticData.photoOffsets.keys().next().value);
  }
  return offsets;
}

function staticPhotoOffsetEntry(offsets, offset) {
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = offsets[middle];
    if (offset < entry.start) {
      high = middle - 1;
    } else if (offset >= entry.end) {
      low = middle + 1;
    } else {
      return entry;
    }
  }

  return null;
}

function staticRandomPhotoIndex(albumId, count, localIndex, seedValue) {
  if (count <= 1) return 0;
  const key = `${seedValue}:${albumId}:${count}`;
  if (!staticData.photoOrders.has(key)) {
    const order = Array.from({ length: count }, (_, index) => index);
    const rand = random(seedFrom(`photos:${seedValue}:${albumId}`));
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(rand() * (index + 1));
      [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
    }
    staticData.photoOrders.set(key, order);
    while (staticData.photoOrders.size > 256) {
      staticData.photoOrders.delete(staticData.photoOrders.keys().next().value);
    }
  }
  return staticData.photoOrders.get(key)[localIndex] ?? localIndex;
}

async function staticPhotoFromOffset(offset, mode = "sequence", seedValue = "photos") {
  const offsets = await staticPhotoOffsets(mode, seedValue);
  const entry = staticPhotoOffsetEntry(offsets, offset);
  if (!entry) return null;
  const detail = await staticAlbumDetail(entry.album.id);
  const localIndex = offset - entry.start;
  const photoIndex = mode === "random"
    ? staticRandomPhotoIndex(entry.album.id, detail.photos.length, localIndex, seedValue)
    : localIndex;
  const photo = detail.photos[photoIndex];
  if (!photo) return null;
  return {
    id: `${entry.album.id}-${photo.id}`,
    albumId: entry.album.id,
    albumTitle: entry.album.title,
    albumHref: entry.album.href,
    photoId: photo.id,
    url: normalizeImageUrl(photo.url),
    width: Number(photo.width) || undefined,
    height: Number(photo.height) || undefined
  };
}

async function staticPhotosResponse(requestUrl) {
  const manifest = await staticManifest();
  const requestedMode = requestUrl.searchParams.get("mode");
  const mode = requestedMode === "random" ? "random" : "sequence";
  const seed = requestUrl.searchParams.get("seed") || "photos";
  const page = Math.max(1, Number(requestUrl.searchParams.get("page") || 1));
  const limit = Math.min(120, Math.max(24, Number(requestUrl.searchParams.get("limit") || 72)));
  const total = manifest.photoCount || 0;
  const start = (page - 1) * limit;
  const end = Math.min(start + limit, total);
  const photos = [];

  for (let position = start; position < end; position += 1) {
    const photo = await staticPhotoFromOffset(position, mode, seed);
    if (photo) photos.push(photo);
  }

  return {
    ok: true,
    mode,
    seed,
    page,
    limit,
    total,
    photos
  };
}

async function staticLikeResponse(options) {
  let body = {};
  try {
    body = JSON.parse(options.body || "{}");
  } catch {
    throw new Error("Invalid request body");
  }

  const albumId = String(body.albumId || "");
  const albumDelta = Math.min(25, Math.max(0, Number(body.albumDelta || 0)));
  staticData.likes.albums[albumId] = (staticData.likes.albums[albumId] || 0) + albumDelta;

  if (Array.isArray(body.likes)) {
    for (const like of body.likes.slice(0, 100)) {
      const photoId = Number(like.photoId);
      const delta = Math.min(25, Math.max(0, Number(like.delta || 0)));
      if (!Number.isFinite(photoId) || delta <= 0) continue;
      const key = `${albumId}:${photoId}`;
      staticData.likes.photos[key] = (staticData.likes.photos[key] || 0) + delta;
    }
  }

  saveStaticLikes();
  return {
    ok: true,
    count: staticData.likes.albums[albumId] || 0
  };
}

function formatCount(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function rememberImageSize(key, size) {
  if (!key || imageSizeCache.has(key)) return false;
  imageSizeCache.set(key, size);
  while (imageSizeCache.size > IMAGE_SIZE_CACHE_LIMIT) {
    imageSizeCache.delete(imageSizeCache.keys().next().value);
  }
  return true;
}

function readDetailImageScale() {
  let stored = 100;
  try {
    stored = Number(localStorage.getItem(DETAIL_SIZE_KEY) || 100);
  } catch {
    stored = 100;
  }
  return Number.isFinite(stored) ? Math.min(300, Math.max(100, stored)) : 100;
}

function setDetailImageScale(value) {
  detailImageScale = Math.min(300, Math.max(100, Number(value) || 100));
  try {
    localStorage.setItem(DETAIL_SIZE_KEY, String(detailImageScale));
  } catch {
    // Storage can be blocked in private or restricted browser contexts.
  }
}

function readDetailViewMode() {
  try {
    return localStorage.getItem(DETAIL_VIEW_KEY) === "gallery" ? "gallery" : "single";
  } catch {
    return "single";
  }
}

function setDetailViewMode(value) {
  detailViewMode = value === "single" ? "single" : "gallery";
  try {
    localStorage.setItem(DETAIL_VIEW_KEY, detailViewMode);
  } catch {
    // The selected mode still applies for the current page when storage is unavailable.
  }
}

function setTheme(nextTheme) {
  document.documentElement.setAttribute("data-theme", nextTheme);
  try {
    localStorage.setItem("theme", nextTheme);
  } catch {
    // Theme still applies for the current page when storage is unavailable.
  }
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.innerHTML = nextTheme === "dark" ? icons.sun : icons.moon;
    button.setAttribute("aria-label", nextTheme === "dark" ? "切换到亮色模式" : "切换到暗色模式");
    button.setAttribute("title", nextTheme === "dark" ? "切换到亮色模式" : "切换到暗色模式");
  });
}

function currentTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem("theme");
  } catch {
    stored = null;
  }
  if (stored === "light" || stored === "dark") return stored;
  return "dark";
}

function initSmoothScroll() {
  if (smoothScroll || typeof window.Lenis !== "function") return;
  smoothScroll = new window.Lenis({
    autoRaf: true,
    autoResize: true,
    smoothWheel: true,
    syncTouch: false,
    duration: 1.2,
    anchors: true,
    stopInertiaOnNavigate: true,
    respectReducedMotion: true,
    prevent: (node) => node.classList?.contains("fancybox__container") === true
  });
}

function scrollPageToTop(immediate = false) {
  if (smoothScroll) {
    smoothScroll.scrollTo(0, { immediate, force: true });
    return;
  }
  window.scrollTo({ top: 0, behavior: immediate ? "auto" : "smooth" });
}

function themeButton() {
  return `<button type="button" class="theme-toggle" data-theme-toggle aria-label="切换主题">${currentTheme() === "dark" ? icons.sun : icons.moon}</button>`;
}

function bindThemeButtons(root = document) {
  root.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      setTheme(currentTheme() === "dark" ? "light" : "dark");
    });
  });
  setTheme(currentTheme());
}

function lazyImage(src, alt, eager = false, size = null) {
  const priority = eager ? "high" : "low";
  const width = Number(size?.width);
  const height = Number(size?.height);
  const dimensions = width > 0 && height > 0
    ? ` width="${Math.round(width)}" height="${Math.round(height)}"`
    : "";
  return `<img src="${escapeHtml(src)}" data-src-key="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${dimensions} referrerpolicy="no-referrer" decoding="async" fetchpriority="${priority}" ${eager ? 'loading="eager"' : 'loading="lazy"'}>`;
}

function markLoadedImages(root = document, onSize) {
  root.querySelectorAll("img").forEach((image) => {
    const done = () => {
      const key = image.dataset.srcKey || image.currentSrc || image.src;
      const changed = image.naturalWidth > 0 && image.naturalHeight > 0
        ? rememberImageSize(key, {
            width: image.naturalWidth,
            height: image.naturalHeight
          })
        : false;
      image.classList.add("loaded");
      if (changed && onSize) onSize();
    };
    const failed = () => {
      image.classList.add("loaded", "broken");
      image.alt = image.alt || "图片加载失败";
    };
    if (image.complete && image.naturalWidth > 0) done();
    if (image.dataset.loadBound === "true") return;
    image.dataset.loadBound = "true";
    image.addEventListener("load", done, { once: true });
    image.addEventListener("error", failed, { once: true });
  });
}

function pageItemCount(page) {
  if (page.rows) return page.rows.reduce((total, row) => total + row.length, 0);
  return page.photos?.length || page.albums?.length || 0;
}

function tabLoadedCount(state) {
  if (state === tabs.photos) return state.photos.length;
  if (state.pages) return state.pages.reduce((total, page) => total + pageItemCount(page), 0);
  return state.photos?.length ?? state.albums?.length ?? 0;
}

function albumCard(album, index, eager = index < 8) {
  return `
    <button type="button" class="album-card" data-album-id="${escapeHtml(album.id)}" style="animation-delay:${Math.min(index * 38, 600)}ms">
      <span class="album-cover">
        ${album.cover ? lazyImage(album.cover, album.title, eager) : ""}
        <span class="album-overlay">
          <span class="album-overlay-title">${escapeHtml(album.title)}</span>
          <span class="album-overlay-count">${formatCount(album.count)} 张</span>
        </span>
        <span class="hover-arrow" aria-hidden="true">${icons.arrow}</span>
      </span>
    </button>
  `;
}

function headerTemplate(manifest) {
  const hasAlbumCount = manifest.albumCount !== null
    && manifest.albumCount !== undefined
    && Number.isFinite(Number(manifest.albumCount));
  const isTagsPage = appPathname() === "/tags";
  return `
    <header class="home-header">
      <div class="brand" aria-label="绮影志 VELVET ARCHIVE">
        <span class="brand-mark"></span>
        <span class="brand-title">绮影志</span>
        <span class="brand-sub">VELVET ARCHIVE</span>
      </div>
      ${isTagsPage ? '<span class="header-center-spacer" aria-hidden="true"></span>' : `
        <label class="search-box">
          ${icons.search}
          <input class="search-input" name="q" type="search" placeholder="搜索图集" value="${escapeHtml(searchTag || searchQuery)}" autocomplete="off">
        </label>
      `}
      <div class="header-actions">
        <button type="button" class="tag-directory-link ${appPathname() === "/tags" ? "active" : ""}" data-tags-page>
          <span>标签</span>
          ${Number(manifest.tagCount) ? `<span class="tag-directory-count">${formatCount(manifest.tagCount)}</span>` : ""}
        </button>
        <span class="archive-count">${hasAlbumCount ? formatCount(manifest.albumCount) : "--"} Sets</span>
        ${themeButton()}
      </div>
    </header>
  `;
}

function heroStat(en, cn, value) {
  const hasValue = value !== null && value !== undefined && Number.isFinite(Number(value));
  const target = hasValue ? Math.max(0, Number(value)) : 0;
  return `
    <div class="hero-stat" role="listitem">
      <span class="hero-stat-en">${en}</span>
      <span class="hero-stat-cn">${cn}</span>
      <span class="hero-stat-num"${hasValue ? ` data-count-up="${target}" aria-label="${formatCount(target)}"` : ""} aria-live="off">--</span>
    </div>
  `;
}

function tagMatchesGroup(name, group) {
  if (!group) return true;
  const first = String(name || "").trim().charAt(0).toLocaleUpperCase();
  if (group === "0-9") return /^[0-9]$/.test(first);
  if (group === "other") return !/^[A-Z0-9]$/.test(first);
  return first === group;
}

async function staticTagIndex() {
  if (staticData.tags) return staticData.tags;
  const albums = await staticAlbums();
  const counts = new Map();
  for (const album of albums) {
    const seen = new Set();
    for (const tag of normalizeTags(album.tags)) {
      const key = tag.toLocaleLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { name: tag, count: 1 });
    }
  }
  staticData.tags = [...counts.values()];
  return staticData.tags;
}

async function staticTagsResponse(requestUrl) {
  const query = (requestUrl.searchParams.get("q") || "").trim().toLocaleLowerCase();
  const requestedGroup = (requestUrl.searchParams.get("group") || "").trim().toLocaleUpperCase();
  const group = requestedGroup === "0-9" || requestedGroup === "OTHER"
    ? requestedGroup.toLocaleLowerCase()
    : /^[A-Z]$/.test(requestedGroup) ? requestedGroup : "";
  const sort = requestUrl.searchParams.get("sort") === "name" ? "name" : "count";
  const page = Math.max(1, Number(requestUrl.searchParams.get("page") || 1));
  const limit = Math.min(600, Math.max(50, Number(requestUrl.searchParams.get("limit") || TAG_PAGE_SIZE)));
  const tags = await staticTagIndex();
  const matched = tags
    .filter((tag) => (!query || tag.name.toLocaleLowerCase().includes(query)) && tagMatchesGroup(tag.name, group))
    .sort(sort === "name"
      ? (left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      : (left, right) => right.count - left.count || left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const start = (page - 1) * limit;
  return {
    ok: true,
    page,
    limit,
    total: matched.length,
    tags: matched.slice(start, start + limit)
  };
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((tag) => String(tag || "").trim())
    .filter(Boolean))];
}

function animateHeroStats(root) {
  const counters = root.querySelectorAll("[data-count-up]");
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  counters.forEach((counter) => {
    const target = Number(counter.dataset.countUp);
    const finish = () => {
      counter.textContent = formatCount(target);
      counter.classList.remove("is-counting");
      counter.classList.add("is-counted");
    };

    if (!Number.isFinite(target) || reduceMotion) {
      finish();
      return;
    }

    const duration = 800;
    requestAnimationFrame(() => {
      requestAnimationFrame((startedAt) => {
        counter.classList.add("is-counting");
        const tick = (now) => {
          if (!counter.isConnected) return;
          const progress = Math.min((now - startedAt) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 4);
          counter.textContent = formatCount(Math.round(target * eased));
          if (progress < 1) requestAnimationFrame(tick);
          else finish();
        };
        requestAnimationFrame(tick);
      });
    });
  });
}

function heroTemplate(manifest) {
  const tagPending = manifest.tagCount === null || manifest.tagCount === undefined;
  const tagCount = tagPending ? null : Number(manifest.tagCount) || 0;
  return `
    <section class="home-hero" aria-label="档案概览">
      <div class="hero-stats" role="list">
        ${heroStat("Collections", "图集", manifest.albumCount)}
        ${heroStat("Photos", "照片", manifest.photoCount)}
        ${tagPending || tagCount ? heroStat("Tags", "标签", tagCount) : ""}
      </div>
      <div class="hero-brand">
        <h2 class="hero-velvet">Velvet</h2>
        <p class="hero-tagline-en">COSPLAY · PORTRAIT · BOUDOIR</p>
        <p class="hero-tagline-cn">光影成集，留一点旖旎</p>
      </div>
    </section>
  `;
}

function resetPhotosState(mode = tabs.photos.mode || "sequence") {
  tabs.photos = {
    photos: [],
    pages: [],
    page: 0,
    total: homeManifest?.photoCount || tabs.photos.total || 0,
    hasMore: true,
    loading: false,
    prefetch: null,
    prefetching: false,
    prefetchKey: "",
    prefetchPromise: null,
    mode,
    seed: mode === "random" ? String(Date.now()) : "photos",
    photoLayoutKey: ""
  };
}

function updatePhotoOrderButtons() {
  app.querySelectorAll("[data-photo-mode]").forEach((button) => {
    const selected = button.dataset.photoMode === tabs.photos.mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function tabButtonTemplate(tab, title, sub) {
  const selected = activeTab === tab;
  const state = tabs[tab];
  return `
    <button
      type="button"
      class="home-tab ${selected ? "active" : ""}"
      data-tab="${tab}"
      role="tab"
      aria-selected="${selected}"
    >
      <span class="home-tab-title">${title}</span>
      <span class="home-tab-sub">${sub}</span>
      <span class="home-tab-count">${state.total ? formatCount(state.total) : ""}</span>
    </button>
  `;
}

function homeTemplate(data) {
  return `
    <div class="page-enter">
      ${headerTemplate(data.manifest)}
      ${heroTemplate(data.manifest)}
      <main class="home-body">
        <div id="search-results" class="search-results" hidden></div>
        <div id="home-tabs">
          <section class="home-tabs-section" aria-label="图库">
            <div class="tabs-head">
              <div class="home-tabs" role="tablist" aria-label="图库分类">
                ${tabButtonTemplate("photos", "全部图片", "All Photos")}
                ${tabButtonTemplate("albums", "全部图集", "All Collections")}
                ${tabButtonTemplate("recent", "最近更新", "Telegraph Archive")}
                ${tabButtonTemplate("random", "随机漫游", "Original Archive")}
              </div>
              <div class="tab-tools">
                <button type="button" class="refresh-btn album-order-btn ${activeTab === "albums" ? "" : "is-hidden"}" data-album-order aria-label="切换图集排序方向">
                  ${icons.sort}
                  <span data-album-order-label>${tabs.albums.order === "asc" ? "最早" : "最新"}</span>
                </button>
                <div class="photo-order-control ${activeTab === "photos" ? "" : "is-hidden"}" data-photo-order-control role="group" aria-label="全部图片排序">
                  <button type="button" class="photo-order-btn ${tabs.photos.mode === "sequence" ? "active" : ""}" data-photo-mode="sequence" aria-pressed="${tabs.photos.mode === "sequence"}">顺序</button>
                  <button type="button" class="photo-order-btn ${tabs.photos.mode === "random" ? "active" : ""}" data-photo-mode="random" aria-pressed="${tabs.photos.mode === "random"}">随机</button>
                </div>
                <label class="detail-size-control photo-size-control ${activeTab === "photos" ? "" : "is-hidden"}" data-photo-size>
                  <span class="detail-size-label">显示大小</span>
                  <input type="range" min="100" max="300" step="10" value="${detailImageScale}" data-home-size-slider aria-label="调整全部图片显示大小">
                  <span class="detail-size-value" data-home-size-value>${detailImageScale}%</span>
                </label>
                <button type="button" class="refresh-btn tab-refresh ${activeTab === "random" ? "" : "is-hidden"}" data-random-refresh>
                  ${icons.refresh}
                  <span>换一批</span>
                </button>
              </div>
            </div>
            <div class="tab-panel" role="tabpanel">
              <div data-tab-grid></div>
              <div class="infinite-status" data-tab-status></div>
              <div class="infinite-sentinel" data-infinite-sentinel aria-hidden="true"></div>
            </div>
          </section>
          <section class="home-footer">
            <div class="appreciate">
              <span class="appreciate-label">Archive</span>
              <span class="appreciate-title">从 ${formatCount(data.manifest.photoCount)} 张图片里，慢慢翻。</span>
            </div>
          </section>
        </div>
      </main>
      ${backToTopButton()}
    </div>
  `;
}

function pendingHomeTemplate() {
  const pendingManifest = { albumCount: null, photoCount: null, tagCount: null };
  return `
    <div class="page-enter" aria-busy="true">
      ${headerTemplate(pendingManifest)}
      ${heroTemplate(pendingManifest)}
      <main class="home-body">
        <div class="detail-loading">
          <span class="detail-loading-dot"></span>
          <span class="detail-loading-dot"></span>
          <span class="detail-loading-dot"></span>
        </div>
      </main>
    </div>
  `;
}

function backToTopButton() {
  return `<button type="button" class="back-to-top" data-back-to-top aria-label="回到顶部" title="回到顶部">${icons.up}</button>`;
}

function bindBackToTop() {
  app.querySelector("[data-back-to-top]")?.addEventListener("click", () => {
    scrollPageToTop();
  });
  syncBackToTop();
}

function syncBackToTop() {
  app.querySelector("[data-back-to-top]")?.classList.toggle("is-visible", window.scrollY > Math.max(500, window.innerHeight * 0.75));
}

function bindAlbumCards(root = document) {
  root.querySelectorAll("[data-album-id]").forEach((card) => {
    if (card.dataset.bound === "true") return;
    card.dataset.bound = "true";
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-album-id");
      navigate(`/album/${encodeURIComponent(id)}`);
    });
  });
}

function loading() {
  app.innerHTML = `
    <div class="detail-loading">
      <span class="detail-loading-dot"></span>
      <span class="detail-loading-dot"></span>
      <span class="detail-loading-dot"></span>
    </div>
  `;
}

function errorPanel(error) {
  const isHome = appPathname() === "/";
  app.innerHTML = `
    <div class="error-panel">
      <h1>加载失败</h1>
      <p>${escapeHtml(error.message === "Failed to fetch" ? "网络请求中断，请重试" : error.message || error)}</p>
      <button class="more-btn" type="button" data-back>${isHome ? "重新加载" : "返回"}</button>
    </div>
  `;
  app.querySelector("[data-back]").addEventListener("click", () => {
    if (isHome) route().catch(errorPanel);
    else navigate("/");
  });
}

async function renderHome() {
  searchTag = (new URLSearchParams(location.search).get("tag") || "").trim();
  if (searchTag) searchQuery = "";
  if (!homeManifest) {
    app.innerHTML = pendingHomeTemplate();
    bindThemeButtons(app);
    const health = await getJson("/api/health");
    homeManifest = {
      albumCount: health.albumCount,
      photoCount: health.photoCount,
      tagCount: Number(health.tagCount) || 0,
      builtAt: health.builtAt
    };
  }
  tabs.photos.total ||= homeManifest.photoCount;
  tabs.recent.total ||= homeManifest.albumCount;
  tabs.random.total ||= homeManifest.albumCount;
  app.innerHTML = homeTemplate({ manifest: homeManifest });
  animateHeroStats(app);
  bindThemeButtons(app);
  bindBackToTop();
  bindHomeControls();
  if (searchQuery || searchTag) {
    await runSearch(1);
  } else {
    await showActiveTab();
  }
}

function tagGroupButtons(activeGroup) {
  const groups = [
    { value: "", label: "全部" },
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({ value: letter, label: letter })),
    { value: "0-9", label: "0-9" },
    { value: "other", label: "其他" }
  ];
  return groups.map((group) => `
    <button type="button" class="tag-letter ${activeGroup === group.value ? "active" : ""}" data-tag-group="${group.value}" aria-pressed="${activeGroup === group.value}">${group.label}</button>
  `).join("");
}

function tagsPageTemplate(manifest, state) {
  return `
    <div class="page-enter">
      ${headerTemplate(manifest)}
      <main class="tags-directory">
        <div class="tags-page-top">
          <button class="back-link" type="button" data-tags-home>
            <span class="arrow">${icons.back}</span>
            返回图库
          </button>
        </div>
        <section class="tags-intro">
          <p class="section-kicker">Index</p>
          <h1 class="tags-title">全部标签</h1>
          <p class="tags-summary" data-tags-summary>共 ${formatCount(manifest.tagCount || 0)} 个标签</p>
        </section>
        <section class="tags-controls" aria-label="标签筛选">
          <label class="tag-search-box">
            ${icons.search}
            <input type="search" value="${escapeHtml(state.query)}" placeholder="搜索标签名称…" autocomplete="off" data-tag-search>
          </label>
          <label class="tag-sort-control">
            <span>排序</span>
            <select data-tag-sort aria-label="标签排序方式">
              <option value="count" ${state.sort === "count" ? "selected" : ""}>按图集数排序</option>
              <option value="name" ${state.sort === "name" ? "selected" : ""}>按名称排序</option>
            </select>
          </label>
        </section>
        <nav class="tag-alphabet" aria-label="按首字母筛选">
          ${tagGroupButtons(state.group)}
        </nav>
        <section class="tag-cloud" data-tag-cloud aria-live="polite"></section>
        <div class="tag-directory-status" data-tag-directory-status></div>
      </main>
      ${backToTopButton()}
    </div>
  `;
}

function tagCloudItem(tag) {
  const count = Number(tag.count) || 0;
  const size = count >= 1000 ? "xl" : count >= 250 ? "lg" : count >= 50 ? "md" : "sm";
  return `
    <button type="button" class="tag-cloud-item size-${size}" data-tag-name="${escapeHtml(tag.name)}">
      <span>${escapeHtml(tag.name)}</span><sup>${formatCount(count)}</sup>
    </button>
  `;
}

function bindTagCloudButtons(root = app) {
  root.querySelectorAll("[data-tag-name]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const tag = button.dataset.tagName;
      if (tag) navigate(`/?tag=${encodeURIComponent(tag)}`);
    });
  });
}

function syncTagDirectoryUrl() {
  if (!tagDirectoryState) return;
  const params = new URLSearchParams();
  if (tagDirectoryState.query) params.set("q", tagDirectoryState.query);
  if (tagDirectoryState.sort !== "count") params.set("sort", tagDirectoryState.sort);
  if (tagDirectoryState.group) params.set("group", tagDirectoryState.group);
  const query = params.toString();
  history.replaceState({}, "", appUrl(`/tags${query ? `?${query}` : ""}`));
}

function renderTagDirectoryStatus() {
  const status = app.querySelector("[data-tag-directory-status]");
  const summary = app.querySelector("[data-tags-summary]");
  if (!status || !tagDirectoryState) return;
  const shown = tagDirectoryState.tags.length;
  if (summary) {
    summary.textContent = `共 ${formatCount(tagDirectoryState.total)} 个标签 · 当前显示 ${formatCount(shown)} 个`;
  }
  if (tagDirectoryState.loading) {
    status.innerHTML = '<span class="tag-loading-label">正在整理标签…</span>';
  } else if (!shown) {
    status.innerHTML = '<span class="end-label">没有匹配的标签</span>';
  } else if (tagDirectoryState.hasMore) {
    status.innerHTML = '<button type="button" class="more-btn" data-more-tags>继续加载</button>';
    status.querySelector("[data-more-tags]")?.addEventListener("click", () => loadTagDirectory(false).catch(errorPanel));
  } else {
    status.innerHTML = '<span class="end-label">已经显示全部标签</span>';
  }
}

async function loadTagDirectory(reset = false) {
  if (!tagDirectoryState || tagDirectoryState.loading) return;
  if (reset) {
    tagDirectoryState.page = 0;
    tagDirectoryState.total = 0;
    tagDirectoryState.tags = [];
    tagDirectoryState.hasMore = true;
    const cloud = app.querySelector("[data-tag-cloud]");
    if (cloud) cloud.innerHTML = "";
  }
  if (!tagDirectoryState.hasMore) return;

  tagDirectoryState.loading = true;
  renderTagDirectoryStatus();
  const nextPage = tagDirectoryState.page + 1;
  const params = new URLSearchParams({
    page: String(nextPage),
    limit: String(TAG_PAGE_SIZE),
    sort: tagDirectoryState.sort
  });
  if (tagDirectoryState.query) params.set("q", tagDirectoryState.query);
  if (tagDirectoryState.group) params.set("group", tagDirectoryState.group);
  const data = await getJson(`/api/tags?${params.toString()}`);
  tagDirectoryState.page = data.page;
  tagDirectoryState.total = data.total;
  tagDirectoryState.tags.push(...data.tags);
  tagDirectoryState.hasMore = data.page * data.limit < data.total;
  tagDirectoryState.loading = false;

  const cloud = app.querySelector("[data-tag-cloud]");
  if (cloud) cloud.insertAdjacentHTML("beforeend", data.tags.map(tagCloudItem).join(""));
  bindTagCloudButtons(cloud || app);
  renderTagDirectoryStatus();
}

async function renderTagsPage() {
  if (!homeManifest) {
    const health = await getJson("/api/health");
    homeManifest = {
      albumCount: health.albumCount,
      photoCount: health.photoCount,
      tagCount: Number(health.tagCount) || 0,
      builtAt: health.builtAt
    };
  }
  const params = new URLSearchParams(location.search);
  const requestedGroup = (params.get("group") || "").trim();
  tagDirectoryState = {
    query: (params.get("q") || "").trim(),
    sort: params.get("sort") === "name" ? "name" : "count",
    group: requestedGroup === "0-9" || requestedGroup === "other" || /^[A-Z]$/.test(requestedGroup) ? requestedGroup : "",
    tags: [],
    page: 0,
    total: Number(homeManifest.tagCount) || 0,
    hasMore: true,
    loading: false
  };
  app.innerHTML = tagsPageTemplate(homeManifest, tagDirectoryState);
  bindThemeButtons(app);
  bindBackToTop();
  app.querySelector("[data-tags-home]")?.addEventListener("click", () => navigate("/"));
  app.querySelector("[data-tags-page]")?.addEventListener("click", () => scrollPageToTop());

  const input = app.querySelector("[data-tag-search]");
  input?.addEventListener("input", () => {
    tagDirectoryState.query = input.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      syncTagDirectoryUrl();
      loadTagDirectory(true).catch(errorPanel);
    }, 220);
  });
  app.querySelector("[data-tag-sort]")?.addEventListener("change", (event) => {
    tagDirectoryState.sort = event.currentTarget.value === "name" ? "name" : "count";
    syncTagDirectoryUrl();
    loadTagDirectory(true).catch(errorPanel);
  });
  app.querySelectorAll("[data-tag-group]").forEach((button) => {
    button.addEventListener("click", () => {
      tagDirectoryState.group = button.dataset.tagGroup || "";
      app.querySelectorAll("[data-tag-group]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      syncTagDirectoryUrl();
      loadTagDirectory(true).catch(errorPanel);
    });
  });
  await loadTagDirectory(true);
}

function bindHomeControls() {
  app.querySelector("[data-tags-page]")?.addEventListener("click", () => navigate("/tags"));
  app.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      activeTab = button.dataset.tab;
      app.querySelectorAll("[data-tab]").forEach((tabButton) => {
        const selected = tabButton.dataset.tab === activeTab;
        tabButton.classList.toggle("active", selected);
        tabButton.setAttribute("aria-selected", String(selected));
      });
      app.querySelector("[data-random-refresh]")?.classList.toggle("is-hidden", activeTab !== "random");
      app.querySelector("[data-photo-size]")?.classList.toggle("is-hidden", activeTab !== "photos");
      app.querySelector("[data-photo-order-control]")?.classList.toggle("is-hidden", activeTab !== "photos");
      app.querySelector("[data-album-order]")?.classList.toggle("is-hidden", activeTab !== "albums");
      if (!searchQuery && !searchTag) {
        scrollPageToTop(true);
        await showActiveTab();
      }
    });
  });

  app.querySelector("[data-random-refresh]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.classList.add("spinning");
    tabs.random = {
      albums: [],
      pages: [],
      page: 0,
      total: 0,
      hasMore: true,
      loading: false,
      prefetch: null,
      prefetching: false,
      prefetchKey: "",
      prefetchPromise: null,
      seed: String(Date.now())
    };
    activeTab = "random";
    await showActiveTab();
    setTimeout(() => button.classList.remove("spinning"), 700);
  });

  app.querySelector("[data-album-order]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const nextOrder = tabs.albums.order === "asc" ? "desc" : "asc";
    tabs.albums = {
      albums: [],
      pages: [],
      page: 0,
      total: 0,
      hasMore: true,
      loading: false,
      prefetch: null,
      prefetching: false,
      prefetchKey: "",
      prefetchPromise: null,
      seed: "albums",
      order: nextOrder
    };
    const label = button.querySelector("[data-album-order-label]");
    if (label) label.textContent = nextOrder === "asc" ? "最早" : "最新";
    activeTab = "albums";
    scrollPageToTop(true);
    await showActiveTab();
  });

  app.querySelectorAll("[data-photo-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextMode = button.dataset.photoMode === "random" ? "random" : "sequence";
      if (tabs.photos.mode === nextMode && nextMode !== "random") return;

      activeTab = "photos";
      resetPhotosState(nextMode);
      updatePhotoOrderButtons();
      app.querySelectorAll("[data-tab]").forEach((tabButton) => {
        const selected = tabButton.dataset.tab === activeTab;
        tabButton.classList.toggle("active", selected);
        tabButton.setAttribute("aria-selected", String(selected));
      });
      scrollPageToTop(true);
      await showActiveTab();
    });
  });

  const homeSizeSlider = app.querySelector("[data-home-size-slider]");
  homeSizeSlider?.addEventListener("input", () => {
    setDetailImageScale(homeSizeSlider.value);
    app.querySelectorAll("[data-home-size-value], [data-size-value]").forEach((node) => {
      node.textContent = `${detailImageScale}%`;
    });
    if (activeTab === "photos" && !searchQuery && !searchTag) renderTabGrid({ force: true });
  });

  const input = app.querySelector(".search-input");
  input.addEventListener("input", () => {
    if (searchTag) {
      searchTag = "";
      history.replaceState({}, "", appUrl("/"));
    }
    searchQuery = input.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (searchQuery) await runSearch(1);
      else await showActiveTab();
    }, 220);
  });
}

async function showActiveTab() {
  const results = app.querySelector("#search-results");
  const tabsContainer = app.querySelector("#home-tabs");
  if (results) {
    results.hidden = true;
    results.innerHTML = "";
  }
  if (tabsContainer) tabsContainer.hidden = false;
  renderTabGrid();
  const state = tabs[activeTab];
  if (!tabLoadedCount(state) && state.hasMore) {
    await loadMoreActiveTab();
  }
  setupInfiniteScroll();
}

function renderTabGrid(options = {}) {
  const state = tabs[activeTab];
  const grid = app.querySelector("[data-tab-grid]");
  if (!grid) return;

  if (activeTab === "photos") {
    renderPhotoTabGrid(options);
    renderInfiniteStatus();
    return;
  }

  renderAlbumTabGrid(activeTab, options);
  renderInfiniteStatus();
}

function albumPageShell(entry) {
  const height = entry.height || (!entry.rendered ? estimateAlbumPageHeight(entry) : 0);
  const minHeight = height ? ` style="min-height:${Math.round(height)}px"` : "";
  return `<section class="album-page albums-grid ${entry.rendered ? "" : "is-placeholder"}" data-album-page="${entry.page}"${minHeight}></section>`;
}

function albumPageNearViewport(element) {
  const rect = element.getBoundingClientRect();
  return rect.bottom > -ALBUM_PAGE_RENDER_MARGIN && rect.top < window.innerHeight + ALBUM_PAGE_RENDER_MARGIN;
}

function albumGridMetrics(width) {
  const columns = width <= 520 ? 1 : width <= 760 ? 2 : width <= 1100 ? 3 : 4;
  const rowGap = width <= 520 ? 36 : width <= 760 ? 40 : Math.min(80, Math.max(44, width * 0.06));
  const columnGap = width <= 760 ? 16 : Math.min(40, Math.max(18, width * 0.03));
  return { columns, rowGap, columnGap };
}

function estimateAlbumPageHeight(entry) {
  const grid = app.querySelector("[data-tab-grid]");
  const width = grid?.clientWidth || Math.max(320, window.innerWidth - 32);
  const { columns, rowGap, columnGap } = albumGridMetrics(width);
  const rows = Math.ceil(entry.albums.length / columns);
  if (!rows) return 0;
  const cardWidth = (width - (columns - 1) * columnGap) / columns;
  const cardHeight = cardWidth * 4 / 3;
  return rows * cardHeight + (rows - 1) * rowGap;
}

function renderAlbumPage(entry) {
  const grid = app.querySelector("[data-tab-grid]");
  const page = grid?.querySelector(`[data-album-page="${entry.page}"]`);
  if (!grid || !page || entry.rendered) return;

  page.classList.remove("is-placeholder");
  page.style.minHeight = "";
  page.innerHTML = entry.albums
    .map((album, index) => albumCard(album, index, entry.page === 1 && index < 8))
    .join("");
  entry.rendered = true;
  bindAlbumCards(page);
  markLoadedImages(page);
  requestAnimationFrame(() => {
    entry.height = page.offsetHeight || entry.height;
    requestAlbumPageSync();
  });
}

function unrenderAlbumPage(entry) {
  const page = app.querySelector(`[data-album-page="${entry.page}"]`);
  if (!page || !entry.rendered) return;

  entry.height = page.offsetHeight || entry.height || estimateAlbumPageHeight(entry);
  page.innerHTML = "";
  page.style.minHeight = `${Math.max(1, Math.round(entry.height))}px`;
  page.classList.add("is-placeholder");
  entry.rendered = false;
}

function syncVisibleAlbumPages(options = {}) {
  if (appPathname() !== "/" || activeTab === "photos" || searchQuery || searchTag) return;
  const state = tabs[activeTab];
  const grid = app.querySelector("[data-tab-grid]");
  if (!state?.pages || !grid) return;

  const candidates = state.pages
    .map((entry) => {
      const page = grid.querySelector(`[data-album-page="${entry.page}"]`);
      return page && albumPageNearViewport(page)
        ? { entry, distance: viewportDistance(page) }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_RENDERED_ALBUM_PAGES);
  const allowed = new Set(candidates.map((candidate) => candidate.entry.page));

  state.pages.forEach((entry) => {
    const page = grid.querySelector(`[data-album-page="${entry.page}"]`);
    if (!page) return;
    if (allowed.has(entry.page)) {
      renderAlbumPage(entry, options);
    } else {
      unrenderAlbumPage(entry);
    }
  });
}

function requestAlbumPageSync(options = {}) {
  if (albumSyncFrame) return;
  albumSyncFrame = requestAnimationFrame(() => {
    albumSyncFrame = null;
    syncVisibleAlbumPages(options);
  });
}

function appendAlbumPage(tab, data) {
  const state = tabs[tab];
  const existing = state.pages.find((entry) => entry.page === data.page);
  if (existing) return;

  const entry = {
    page: data.page,
    albums: data.albums,
    height: 0,
    rendered: false
  };
  state.pages.push(entry);
  state.albums.push(...data.albums);
  if (appPathname() !== "/" || activeTab !== tab || searchQuery || searchTag) return;

  const grid = app.querySelector("[data-tab-grid]");
  if (!grid) return;

  renderAlbumTabGrid(tab, { force: true });
}

function albumPageSignature(tab) {
  const state = tabs[tab];
  return `${tab}:${state.seed}:${state.pages.map((entry) => entry.page).join(",")}`;
}

function renderAlbumTabGrid(tab, options = {}) {
  const state = tabs[tab];
  const grid = app.querySelector("[data-tab-grid]");
  if (!state || !grid) return;
  if (appPathname() !== "/" || activeTab !== tab || searchQuery || searchTag) return;

  const wasAlbumGrid = grid.dataset.gridKind === `albums:${tab}`;
  grid.className = "album-pages";
  grid.dataset.gridKind = `albums:${tab}`;
  delete grid.dataset.photoPages;
  const signature = albumPageSignature(tab);
  if (options.force || !wasAlbumGrid || grid.dataset.albumPages !== signature || grid.querySelector(".photo-page")) {
    grid.dataset.albumPages = signature;
    state.pages.forEach((entry) => {
      entry.rendered = false;
    });
    grid.innerHTML = state.pages.map(albumPageShell).join("");
  }
  syncVisibleAlbumPages(options);
}

function photoItem(photo, index, eager = false) {
  return `
    <button
      type="button"
      class="jr-item photo-tab-item"
      data-album-id="${escapeHtml(photo.albumId)}"
      title="${escapeHtml(photo.albumTitle)}"
      style="width:${photo.displayWidth}px;height:${photo.displayHeight}px"
    >
      ${lazyImage(photo.url, photo.albumTitle, eager, photo)}
    </button>
  `;
}

function photoPageShell(entry) {
  const height = entry.height || (!entry.rendered ? estimatePhotoPageHeight(entry) : 0);
  const minHeight = height ? ` style="min-height:${Math.round(height)}px"` : "";
  return `<section class="photo-page ${entry.rendered ? "" : "is-placeholder"}" data-photo-page="${entry.page}"${minHeight}></section>`;
}

function photoPageNearViewport(element) {
  const rect = element.getBoundingClientRect();
  return rect.bottom > -PHOTO_PAGE_RENDER_MARGIN && rect.top < window.innerHeight + PHOTO_PAGE_RENDER_MARGIN;
}

function viewportDistance(element) {
  const rect = element.getBoundingClientRect();
  if (rect.bottom < 0) return Math.abs(rect.bottom);
  if (rect.top > window.innerHeight) return rect.top - window.innerHeight;
  return 0;
}

function photoLayoutConfig(grid) {
  const width = grid?.clientWidth || Math.max(320, window.innerWidth - 32);
  const baseHeight = width < 600 ? 150 : width < 1000 ? 210 : 260;
  const targetHeight = Math.round(baseHeight * detailImageScale / 100);
  const gap = width < 600 ? 5 : 8;
  return {
    width,
    targetHeight,
    gap,
    key: `${Math.round(width)}:${targetHeight}:${gap}`
  };
}

function rowFilledWidth(row, gap) {
  if (!row.length) return 0;
  return row.reduce((total, item) => total + item.displayWidth, 0) + (row.length - 1) * gap;
}

function createPhotoPages(photos, config, previousPages = [], holdLastPartialRow = false) {
  const indexedPhotos = photos.map((photo, index) => ({
    ...photo,
    sourceIndex: index
  }));
  const rows = rowLayoutRows(indexedPhotos, config.width, config.targetHeight, config.gap);
  const lastRow = rows[rows.length - 1];
  if (holdLastPartialRow && lastRow && rowFilledWidth(lastRow, config.gap) < config.width - 1) {
    rows.pop();
  }
  const pages = [];
  for (let index = 0; index < rows.length; index += PHOTO_ROWS_PER_PAGE) {
    const pageNumber = pages.length + 1;
    const previous = previousPages.find((entry) => entry.page === pageNumber);
    pages.push({
      page: pageNumber,
      rows: rows.slice(index, index + PHOTO_ROWS_PER_PAGE),
      height: previous?.height || 0,
      rendered: false
    });
  }
  return pages;
}

function estimatePhotoPageHeight(entry) {
  const grid = app.querySelector("[data-tab-grid]");
  const { gap } = photoLayoutConfig(grid);
  return entry.rows.reduce((height, row, index) => {
    const rowHeight = row[0]?.displayHeight || 0;
    return height + rowHeight + (index ? gap : 0);
  }, 0);
}

function renderPhotoPage(entry, options = {}) {
  const grid = app.querySelector("[data-tab-grid]");
  const page = grid?.querySelector(`[data-photo-page="${entry.page}"]`);
  if (!grid || !page) return;

  if (!options.force && entry.rendered) return;

  const items = entry.rows.flat();
  page.classList.remove("is-placeholder");
  page.style.minHeight = "";
  page.innerHTML = items.map((photo, index) => photoItem(photo, index, entry.page === 1 && index < 6)).join("");
  entry.rendered = true;
  bindAlbumCards(page);
  markLoadedImages(page, schedulePhotoRelayout);
  requestAnimationFrame(() => {
    entry.height = page.offsetHeight || entry.height;
    requestPhotoPageSync();
  });
}

function schedulePhotoRelayout() {
  if (appPathname() !== "/" || activeTab !== "photos" || searchQuery || searchTag) return;
  clearTimeout(photoRelayoutTimer);
  photoRelayoutTimer = setTimeout(() => {
    photoRelayoutTimer = null;
    if (appPathname() !== "/" || activeTab !== "photos" || searchQuery || searchTag) return;
    renderPhotoTabGrid({ force: true });
  }, 420);
}

function unrenderPhotoPage(entry) {
  const page = app.querySelector(`[data-photo-page="${entry.page}"]`);
  if (!page || !entry.rendered) return;

  entry.height = page.offsetHeight || entry.height || estimatePhotoPageHeight(entry);
  page.innerHTML = "";
  page.style.minHeight = `${Math.max(1, Math.round(entry.height))}px`;
  page.classList.add("is-placeholder");
  entry.rendered = false;
}

function syncVisiblePhotoPages(options = {}) {
  if (appPathname() !== "/" || activeTab !== "photos" || searchQuery || searchTag) return;
  const state = tabs.photos;
  const grid = app.querySelector("[data-tab-grid]");
  if (!grid) return;

  const candidates = state.pages
    .map((entry) => {
      const page = grid.querySelector(`[data-photo-page="${entry.page}"]`);
      return page && photoPageNearViewport(page)
        ? { entry, distance: viewportDistance(page) }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_RENDERED_PHOTO_PAGES);
  const allowed = new Set(candidates.map((candidate) => candidate.entry.page));

  state.pages.forEach((entry) => {
    const page = grid.querySelector(`[data-photo-page="${entry.page}"]`);
    if (!page) return;
    if (allowed.has(entry.page)) {
      renderPhotoPage(entry, options);
    } else {
      unrenderPhotoPage(entry);
    }
  });
}

function requestPhotoPageSync(options = {}) {
  if (photoSyncFrame) return;
  photoSyncFrame = requestAnimationFrame(() => {
    photoSyncFrame = null;
    syncVisiblePhotoPages(options);
  });
}

function appendPhotoPage(data) {
  const state = tabs.photos;
  const expectedStart = (data.page - 1) * data.limit;
  if (state.photos.length > expectedStart) return;

  state.photos.push(...data.photos);
  if (appPathname() !== "/" || activeTab !== "photos" || searchQuery || searchTag) return;

  const grid = app.querySelector("[data-tab-grid]");
  if (!grid) return;

  renderPhotoTabGrid({ force: true });
}

function renderPhotoTabGrid(options = {}) {
  const state = tabs.photos;
  const grid = app.querySelector("[data-tab-grid]");
  if (!grid) return;
  if (appPathname() !== "/" || activeTab !== "photos" || searchQuery || searchTag) return;

  const config = photoLayoutConfig(grid);
  if (config.width < 100) return;
  if (options.force || state.photoLayoutKey !== config.key || !state.pages.length) {
    state.pages = createPhotoPages(state.photos, config, state.pages, state.hasMore);
    state.photoLayoutKey = config.key;
  }

  grid.className = "photo-pages photos-waterfall";
  const wasPhotoGrid = grid.dataset.gridKind === "photos";
  grid.dataset.gridKind = "photos";
  delete grid.dataset.albumPages;
  const signature = `${state.mode}:${state.seed}:${state.photoLayoutKey}:${state.photos.length}:${state.pages.length}`;
  if (options.force || !wasPhotoGrid || grid.dataset.photoPages !== signature || grid.querySelector(".album-page")) {
    grid.dataset.photoPages = signature;
    state.pages.forEach((entry) => {
      entry.rendered = false;
    });
    grid.innerHTML = state.pages.map(photoPageShell).join("");
  }
  syncVisiblePhotoPages(options);
}

function renderInfiniteStatus() {
  const status = app.querySelector("[data-tab-status]");
  if (!status) return;

  const state = tabs[activeTab];
  if (state.loading) {
    status.innerHTML = `
      <span class="detail-loading-dot"></span>
      <span class="detail-loading-dot"></span>
      <span class="detail-loading-dot"></span>
    `;
    return;
  }

  if (!state.hasMore && tabLoadedCount(state)) {
    status.innerHTML = '<span class="end-label">已经到底</span>';
    return;
  }

  status.innerHTML = '<button type="button" class="more-btn" data-load-more>继续加载</button>';
  status.querySelector("[data-load-more]")?.addEventListener("click", () => loadMoreActiveTab());
}

function setupInfiniteScroll() {
  infiniteObserver?.disconnect();
  const sentinel = app.querySelector("[data-infinite-sentinel]");
  if (!sentinel || searchQuery || searchTag || activeTab === "photos") return;

  infiniteObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      loadMoreActiveTab();
    }
  }, {
    rootMargin: "900px 0px"
  });
  infiniteObserver.observe(sentinel);
}

async function loadMoreActiveTab() {
  const tab = activeTab;
  const state = tabs[tab];
  if (state.loading || !state.hasMore) {
    renderInfiniteStatus();
    return;
  }

  state.loading = true;
  renderInfiniteStatus();
  const nextPage = state.page + 1;
  const data = await loadTabPage(tab, nextPage);
  if (!data) {
    state.loading = false;
    renderInfiniteStatus();
    return;
  }

  if (tab === "photos") {
    state.page = data.page;
    state.total = data.total;
    state.mode = data.mode || state.mode;
    state.seed = data.seed || state.seed;
    state.hasMore = data.page * data.limit < data.total;
    state.loading = false;
    appendPhotoPage(data);
    updateTabCounts();
    updatePhotoOrderButtons();

    if (activeTab !== tab || searchQuery || searchTag) return;
    renderInfiniteStatus();
    scheduleNextPagePrefetch(tab);
    return;
  }

  state.page = data.page;
  state.total = data.total;
  state.hasMore = data.page * data.limit < data.total;
  state.loading = false;

  appendAlbumPage(tab, data);
  updateTabCounts();

  if (activeTab !== tab || searchQuery || searchTag) return;
  renderInfiniteStatus();
  scheduleNextPagePrefetch(tab);
}

function tabPageRequest(tab, page) {
  const state = tabs[tab];
  if (!state) return null;

  if (tab === "photos") {
    const params = new URLSearchParams({
      mode: state.mode,
      page: String(page),
      limit: String(PHOTO_PAGE_SIZE),
      seed: state.seed
    });
    return {
      key: `photos:${state.mode}:${state.seed}:${page}:${PHOTO_PAGE_SIZE}`,
      url: `/api/photos?${params.toString()}`
    };
  }

  if (tab === "albums") {
    const mode = state.order === "asc" ? "albums" : "recent";
    const params = new URLSearchParams({
      mode,
      page: String(page),
      limit: String(PAGE_SIZE),
      seed: state.seed
    });
    return {
      key: `albums:${mode}:${page}:${PAGE_SIZE}`,
      url: `/api/albums?${params.toString()}`
    };
  }

  const params = new URLSearchParams({
    mode: tab,
    page: String(page),
    limit: String(PAGE_SIZE),
    seed: state.seed
  });
  return {
    key: `${tab}:${state.seed}:${page}:${PAGE_SIZE}`,
    url: `/api/albums?${params.toString()}`
  };
}

async function loadTabPage(tab, page) {
  const state = tabs[tab];
  const request = tabPageRequest(tab, page);
  if (!state || !request) return null;

  if (state.prefetch?.key === request.key) {
    const data = state.prefetch.data;
    state.prefetch = null;
    state.prefetchKey = "";
    return data;
  }

  if (state.prefetching && state.prefetchKey === request.key && state.prefetchPromise) {
    const data = await state.prefetchPromise;
    if (state.prefetch?.key === request.key) {
      state.prefetch = null;
      state.prefetchKey = "";
    }
    if (data) return data;
  }

  return getJson(request.url);
}

function scheduleNextPagePrefetch(tab) {
  if (searchQuery || searchTag || appPathname() !== "/") return;
  setTimeout(() => prefetchNextTabPage(tab), PREFETCH_DELAY);
}

function prefetchNextTabPage(tab) {
  const state = tabs[tab];
  if (!state || state.loading || !state.hasMore || searchQuery || searchTag) return;

  const nextPage = state.page + 1;
  const request = tabPageRequest(tab, nextPage);
  if (!request) return;
  if (state.prefetch?.key === request.key) return;
  if (state.prefetching && state.prefetchKey === request.key) return;

  state.prefetching = true;
  state.prefetchKey = request.key;
  state.prefetchPromise = getJson(request.url)
    .then((data) => {
      if (state.prefetchKey === request.key) {
        state.prefetch = { key: request.key, data };
        warmPrefetchedMedia(tab, data);
      }
      return data;
    })
    .catch((error) => {
      console.warn("Prefetch failed", error);
      return null;
    })
    .finally(() => {
      if (state.prefetchKey === request.key) {
        state.prefetching = false;
        state.prefetchPromise = null;
      }
    });
}

function warmPrefetchedMedia(tab, data) {
  if (tab === "photos" && Array.isArray(data.photos)) {
    return;
  }

  if (Array.isArray(data.albums)) {
    data.albums.slice(0, 8).forEach((album) => {
      if (!album.cover) return;
      const image = new Image();
      image.referrerPolicy = "no-referrer";
      image.src = album.cover;
    });
  }
}

function updateTabCounts() {
  app.querySelectorAll("[data-tab]").forEach((button) => {
    const tab = button.dataset.tab;
    const fallback = tab === "photos" ? homeManifest?.photoCount : homeManifest?.albumCount;
    const count = tabs[tab]?.total || fallback || 0;
    const node = button.querySelector(".home-tab-count");
    if (node) node.textContent = count ? formatCount(count) : "";
  });
}

function sentinelNearViewport() {
  const sentinel = app.querySelector("[data-infinite-sentinel]");
  if (!sentinel) return false;
  const rect = sentinel.getBoundingClientRect();
  return rect.top < window.innerHeight + 900;
}

function onHomeScroll() {
  if (appPathname().startsWith("/album/")) {
    requestDetailPageSync();
    return;
  }

  if (appPathname() !== "/" || searchQuery || searchTag) return;
  if (activeTab === "photos") requestPhotoPageSync();
  else requestAlbumPageSync();
  if (sentinelNearViewport()) {
    const now = performance.now();
    if (now - lastAutoLoadAt > 350) {
      lastAutoLoadAt = now;
      loadMoreActiveTab();
    }
  }
}

function renderHomePhotoGridOnResize() {
  if (appPathname() !== "/" || searchQuery || searchTag) return;
  clearTimeout(photoResizeTimer);
  photoResizeTimer = setTimeout(() => {
    if (activeTab === "photos") renderPhotoTabGrid({ force: true });
    else renderAlbumTabGrid(activeTab, { force: true });
  }, 120);
}

async function runSearch(page) {
  const results = app.querySelector("#search-results");
  const tabsContainer = app.querySelector("#home-tabs");
  if (!results || !tabsContainer) return;

  if (!searchQuery && !searchTag) {
    results.hidden = true;
    results.innerHTML = "";
    tabsContainer.hidden = false;
    await showActiveTab();
    return;
  }

  infiniteObserver?.disconnect();
  searchPage = page;
  tabsContainer.hidden = true;
  results.hidden = false;
  results.innerHTML = `
    <section class="home-section home-section-first">
      <div class="section-head">
        <div>
          <h2 class="section-title">${searchTag ? `标签：${escapeHtml(searchTag)}` : "搜索结果"}</h2>
          <p class="section-sub">${searchTag ? "Tagged Collections" : "Searching Archive"}</p>
        </div>
      </div>
      <div class="detail-loading">
        <span class="detail-loading-dot"></span>
        <span class="detail-loading-dot"></span>
        <span class="detail-loading-dot"></span>
      </div>
    </section>
  `;

  const filterParam = searchTag
    ? `tag=${encodeURIComponent(searchTag)}`
    : `q=${encodeURIComponent(searchQuery)}`;
  const data = await getJson(`/api/albums?${filterParam}&page=${page}&limit=24`);
  const hasMore = data.page * data.limit < data.total;
  results.innerHTML = `
    <section class="home-section home-section-first">
      <div class="section-head">
        <div>
          <h2 class="section-title">${searchTag ? `标签：${escapeHtml(searchTag)}` : "搜索结果"}</h2>
          <p class="section-sub">${formatCount(data.total)} Matches</p>
        </div>
      </div>
      ${data.albums.length ? `<div class="albums-grid">${data.albums.map(albumCard).join("")}</div>` : '<div class="empty-state">No Matches</div>'}
      ${hasMore ? '<div class="home-footer"><button type="button" class="more-btn" data-more>更多</button></div>' : ""}
    </section>
  `;
  bindAlbumCards(results);
  markLoadedImages(results);
  results.querySelector("[data-more]")?.addEventListener("click", () => appendSearch());
}

async function appendSearch() {
  const results = app.querySelector("#search-results");
  const grid = results?.querySelector(".albums-grid");
  const more = results?.querySelector("[data-more]");
  if (!grid || !more) return;

  more.textContent = "加载中";
  const nextPage = searchPage + 1;
  const filterParam = searchTag
    ? `tag=${encodeURIComponent(searchTag)}`
    : `q=${encodeURIComponent(searchQuery)}`;
  const data = await getJson(`/api/albums?${filterParam}&page=${nextPage}&limit=24`);
  searchPage = nextPage;
  grid.insertAdjacentHTML("beforeend", data.albums.map((album, index) => albumCard(album, grid.children.length + index)).join(""));
  bindAlbumCards(grid);
  markLoadedImages(grid);
  if (data.page * data.limit >= data.total) more.remove();
  else more.textContent = "更多";
}

function detailTemplate(data) {
  const album = data.album;
  const bannerImage = data.photos[0]?.url || album.cover || "";
  const tags = normalizeTags(data.tags || album.tags);
  return `
    <main class="detail page-enter">
      <div class="detail-top">
        <button class="back-link" type="button" data-back>
          <span class="arrow">${icons.back}</span>
          返回
        </button>
        <div class="detail-top-right">
          <span class="detail-counter">${String(data.photos.length).padStart(2, "0")} 张</span>
          ${themeButton()}
        </div>
      </div>
      <section class="detail-banner ${tags.length ? "has-tags" : ""}">
        ${bannerImage ? `<img class="detail-banner-image" src="${escapeHtml(bannerImage)}" alt="" aria-hidden="true" decoding="async" fetchpriority="high">` : ""}
        <div class="detail-banner-content">
          <h1 class="detail-title">${escapeHtml(album.title)}</h1>
          ${tags.length ? `
            <div class="detail-tags" aria-label="图集标签">
              ${tags.map((tag) => `<button type="button" class="detail-tag" data-album-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("")}
            </div>
          ` : ""}
          <div class="detail-like-row">
            <div class="detail-like-group">
              <button type="button" class="album-like" data-like-album>
                <span class="like-icon">${icons.heart}</span>
                <span class="album-like-count">${formatCount(data.likeCount || 0)}</span>
              </button>
              <span class="detail-like-hint">灯箱中可缩放、全屏和点赞</span>
            </div>
            <div class="detail-view-controls">
              <div class="detail-view-switch" role="group" aria-label="图片排列方式">
                <button type="button" class="detail-view-button ${detailViewMode === "gallery" ? "active" : ""}" data-view-mode="gallery" aria-pressed="${detailViewMode === "gallery"}">图册</button>
                <button type="button" class="detail-view-button ${detailViewMode === "single" ? "active" : ""}" data-view-mode="single" aria-pressed="${detailViewMode === "single"}">单图</button>
              </div>
              <label class="detail-size-control ${detailViewMode === "single" ? "is-hidden" : ""}" data-size-control>
                <span class="detail-size-label">显示大小</span>
                <input type="range" min="100" max="300" step="10" value="${detailImageScale}" data-size-slider aria-label="调整图片显示大小">
                <span class="detail-size-value" data-size-value>${detailImageScale}%</span>
              </label>
            </div>
          </div>
        </div>
      </section>
      <div class="justified-rows" data-rows></div>
      ${backToTopButton()}
    </main>
  `;
}

async function renderAlbum(id) {
  loading();
  const data = await getJson(`/api/album/${encodeURIComponent(id)}`);
  currentAlbum = {
    ...data,
    detailPages: [],
    detailLayoutKey: ""
  };
  app.innerHTML = detailTemplate(data);
  bindThemeButtons(app);
  bindBackToTop();
  app.querySelector("[data-back]").addEventListener("click", () => {
    if (history.length > 1) history.back();
    else navigate("/");
  });
  app.querySelector("[data-like-album]").addEventListener("click", () => likeAlbum());
  app.querySelectorAll("[data-album-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const tag = button.dataset.albumTag;
      if (tag) navigate(`/?tag=${encodeURIComponent(tag)}`);
    });
  });
  bindDetailControls();
  renderDetailRows();
  window.addEventListener("resize", renderDetailRowsOnResize, { passive: true });
}

function bindDetailControls() {
  const slider = app.querySelector("[data-size-slider]");
  const value = app.querySelector("[data-size-value]");
  if (slider && value) {
    slider.addEventListener("input", () => {
      setDetailImageScale(slider.value);
      value.textContent = `${detailImageScale}%`;
      renderDetailRows({ force: true });
    });
  }

  app.querySelectorAll("[data-view-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.viewMode === "single" ? "single" : "gallery";
      if (nextMode === detailViewMode) return;
      setDetailViewMode(nextMode);
      syncDetailViewControls();
      currentAlbum.detailLayoutKey = "";
      renderDetailRows({ force: true });
    });
  });
}

function syncDetailViewControls() {
  app.querySelectorAll("[data-view-mode]").forEach((button) => {
    const active = button.dataset.viewMode === detailViewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  app.querySelector("[data-size-control]")?.classList.toggle("is-hidden", detailViewMode === "single");
}

function detailLayoutConfig(container) {
  const width = container?.clientWidth || Math.max(320, window.innerWidth - 32);
  const baseHeight = width < 600 ? 160 : width < 1000 ? 220 : 280;
  const targetHeight = Math.round(baseHeight * detailImageScale / 100);
  const gap = detailViewMode === "single" ? (width < 600 ? 12 : 20) : (width < 600 ? 5 : 8);
  return {
    width,
    targetHeight,
    gap,
    key: `${detailViewMode}:${Math.round(width)}:${targetHeight}:${gap}`
  };
}

function createDetailPages(photos, config, previousPages = []) {
  const indexedPhotos = photos.map((photo, index) => ({
    ...photo,
    sourceIndex: index
  }));
  const rows = detailViewMode === "single"
    ? singlePhotoRows(indexedPhotos, config.width)
    : rowLayoutRows(indexedPhotos, config.width, config.targetHeight, config.gap);
  const pages = [];
  for (let index = 0; index < rows.length; index += DETAIL_ROWS_PER_PAGE) {
    const pageNumber = pages.length + 1;
    const previous = previousPages.find((entry) => entry.page === pageNumber);
    pages.push({
      page: pageNumber,
      rows: rows.slice(index, index + DETAIL_ROWS_PER_PAGE),
      gap: config.gap,
      height: previous?.height || 0,
      rendered: false,
      layoutTimer: null
    });
  }
  return pages;
}

function detailPageShell(entry) {
  const height = entry.height || (!entry.rendered ? estimateDetailPageHeight(entry) : 0);
  const minHeight = height ? ` style="min-height:${Math.round(height)}px"` : "";
  return `<section class="detail-photo-page ${entry.rendered ? "" : "is-placeholder"}" data-detail-page="${entry.page}"${minHeight}></section>`;
}

function detailPageNearViewport(element) {
  const rect = element.getBoundingClientRect();
  return rect.bottom > -DETAIL_PAGE_RENDER_MARGIN && rect.top < window.innerHeight + DETAIL_PAGE_RENDER_MARGIN;
}

function estimateDetailPageHeight(entry) {
  const gap = entry.gap ?? 8;
  return entry.rows.reduce((height, row, index) => {
    const rowHeight = row[0]?.displayHeight || 0;
    return height + rowHeight + (index ? gap : 0);
  }, 0);
}

function renderDetailPage(entry, options = {}) {
  const container = app.querySelector("[data-rows]");
  const page = container?.querySelector(`[data-detail-page="${entry.page}"]`);
  if (!container || !page || !currentAlbum) return;

  if (!options.force && entry.rendered) return;

  const items = entry.rows.flat();
  page.classList.remove("is-placeholder");
  page.style.minHeight = "";
  page.style.gap = `${entry.gap ?? 8}px`;
  page.innerHTML = items.map((photo, index) => {
    const photoIndex = photo.sourceIndex;
    return `
      <button type="button" class="jr-item" data-photo-index="${photoIndex}" style="width:${photo.displayWidth}px;height:${photo.displayHeight}px">
        ${lazyImage(photo.url, currentAlbum.album.title, entry.page === 1 && index < 6, photo)}
      </button>
    `;
  }).join("");
  entry.rendered = true;
  page.querySelectorAll("[data-photo-index]").forEach((button) => {
    button.addEventListener("click", () => openLightbox(Number(button.dataset.photoIndex)));
  });
  markLoadedImages(page, scheduleDetailRelayout);
  requestAnimationFrame(() => {
    entry.height = page.offsetHeight || entry.height;
    requestDetailPageSync();
  });
}

function scheduleDetailRelayout() {
  if (!currentAlbum || !appPathname().startsWith("/album/")) return;
  clearTimeout(detailRelayoutTimer);
  detailRelayoutTimer = setTimeout(() => {
    detailRelayoutTimer = null;
    renderDetailRows({ force: true });
  }, 420);
}

function unrenderDetailPage(entry) {
  const page = app.querySelector(`[data-detail-page="${entry.page}"]`);
  if (!page || !entry.rendered) return;

  clearTimeout(entry.layoutTimer);
  entry.layoutTimer = null;
  entry.height = page.offsetHeight || entry.height || estimateDetailPageHeight(entry);
  page.innerHTML = "";
  page.style.minHeight = `${Math.max(1, Math.round(entry.height))}px`;
  page.classList.add("is-placeholder");
  entry.rendered = false;
}

function syncVisibleDetailPages(options = {}) {
  if (!appPathname().startsWith("/album/") || !currentAlbum?.detailPages) return;
  const container = app.querySelector("[data-rows]");
  if (!container) return;

  const candidates = currentAlbum.detailPages
    .map((entry) => {
      const page = container.querySelector(`[data-detail-page="${entry.page}"]`);
      return page && detailPageNearViewport(page)
        ? { entry, distance: viewportDistance(page) }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_RENDERED_DETAIL_PAGES);
  const allowed = new Set(candidates.map((candidate) => candidate.entry.page));

  currentAlbum.detailPages.forEach((entry) => {
    const page = container.querySelector(`[data-detail-page="${entry.page}"]`);
    if (!page) return;
    if (allowed.has(entry.page)) {
      renderDetailPage(entry, options);
    } else {
      unrenderDetailPage(entry);
    }
  });
}

function requestDetailPageSync(options = {}) {
  if (detailSyncFrame) return;
  detailSyncFrame = requestAnimationFrame(() => {
    detailSyncFrame = null;
    syncVisibleDetailPages(options);
  });
}

function renderDetailRows(options = {}) {
  const container = app.querySelector("[data-rows]");
  if (!container || !currentAlbum) return;

  const config = detailLayoutConfig(container);
  if (config.width < 100) return;

  if (options.force || currentAlbum.detailLayoutKey !== config.key || !currentAlbum.detailPages?.length) {
    const previousPages = currentAlbum.detailLayoutKey === config.key ? currentAlbum.detailPages || [] : [];
    currentAlbum.detailPages = createDetailPages(currentAlbum.photos, config, previousPages);
    currentAlbum.detailLayoutKey = config.key;
  }

  const pages = currentAlbum.detailPages;
  container.className = `justified-rows detail-photo-pages ${detailViewMode === "single" ? "is-single" : "is-gallery"}`;
  const signature = `${currentAlbum.album.id}:${currentAlbum.detailLayoutKey}:${pages.length}`;
  if (options.force || container.dataset.detailPages !== signature) {
    container.dataset.detailPages = signature;
    container.innerHTML = pages.map(detailPageShell).join("");
  }
  syncVisibleDetailPages(options);
}

function renderDetailRowsOnResize() {
  if (!currentAlbum || !appPathname().startsWith("/album/")) return;
  clearTimeout(detailResizeTimer);
  detailResizeTimer = setTimeout(() => renderDetailRows({ force: true }), 120);
}

function singlePhotoRows(photos, containerWidth) {
  const displayWidth = Math.min(containerWidth, 980);
  return photos.map((photo, index) => {
    const suppliedSize = Number(photo.width) > 0 && Number(photo.height) > 0
      ? { width: Number(photo.width), height: Number(photo.height) }
      : null;
    if (suppliedSize) rememberImageSize(photo.url, suppliedSize);
    const size = suppliedSize || imageSizeCache.get(photo.url) || { width: 3, height: 4 };
    const rawRatio = size.width / size.height;
    const ratio = Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : 0.75;
    return [{
      ...photo,
      sourceIndex: photo.sourceIndex ?? index,
      displayWidth,
      displayHeight: displayWidth / ratio
    }];
  });
}

function rowLayoutRows(photos, width, targetHeight, gap) {
  if (width < 100) return [];
  const rows = [];
  let row = [];
  let ratioSum = 0;

  photos.forEach((photo, index) => {
    const suppliedSize = Number(photo.width) > 0 && Number(photo.height) > 0
      ? { width: Number(photo.width), height: Number(photo.height) }
      : null;
    if (suppliedSize) rememberImageSize(photo.url, suppliedSize);
    const size = suppliedSize || imageSizeCache.get(photo.url) || { width: 3, height: 4 };
    const rawRatio = size.width / size.height;
    const ratio = Math.min(2.8, Math.max(0.45, Number.isFinite(rawRatio) ? rawRatio : 0.75));
    row.push({ ...photo, sourceIndex: photo.sourceIndex ?? index, ratio });
    ratioSum += ratio;
    const gaps = (row.length - 1) * gap;

    if (ratioSum * targetHeight + gaps >= width) {
      const height = (width - gaps) / ratioSum;
      rows.push(row.map((item) => ({
        ...item,
        displayWidth: item.ratio * height,
        displayHeight: height
      })));
      row = [];
      ratioSum = 0;
    }
  });

  if (row.length) {
    rows.push(row.map((item) => ({
      ...item,
      displayWidth: Math.min(width, item.ratio * targetHeight),
      displayHeight: targetHeight
    })));
  }

  return rows;
}

function rowLayout(photos, width, targetHeight, gap) {
  return rowLayoutRows(photos, width, targetHeight, gap).flat();
}

function likeAlbum() {
  if (!currentAlbum) return;
  const button = app.querySelector("[data-like-album]");
  const count = button.querySelector(".album-like-count");
  const icon = button.querySelector("svg");
  count.textContent = formatCount(Number(count.textContent.replace(/\D/g, "") || 0) + 1);
  icon.classList.remove("popping");
  requestAnimationFrame(() => icon.classList.add("popping"));
  queueLike({ albumDelta: 1 });
}

function queueLike(delta) {
  if (!currentAlbum) return;
  const id = currentAlbum.album.id;
  const existing = pendingLikes.get(id) || { albumDelta: 0, likes: [] };
  existing.albumDelta += delta.albumDelta || 0;
  if (delta.photoId) {
    const found = existing.likes.find((item) => item.photoId === delta.photoId);
    if (found) found.delta += 1;
    else existing.likes.push({ photoId: delta.photoId, delta: 1 });
  }
  pendingLikes.set(id, existing);
  clearTimeout(existing.timer);
  existing.timer = setTimeout(() => flushLikes(id), 800);
}

async function flushLikes(id) {
  const pending = pendingLikes.get(id);
  if (!pending) return;
  pendingLikes.delete(id);
  const payload = {
    albumId: id,
    albumDelta: pending.albumDelta,
    likes: pending.likes
  };
  try {
    const result = await getJson("/api/like", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const count = app.querySelector(".album-like-count");
    if (count && result.count != null) count.textContent = formatCount(result.count);
  } catch (error) {
    console.warn(error);
  }
}

function openLightbox(index) {
  if (!currentAlbum?.photos?.length) return;
  lightboxIndex = index;

  if (!window.Fancybox?.show) {
    window.open(currentAlbum.photos[index].url, "_blank", "noopener");
    lightboxIndex = null;
    return;
  }

  const mobileViewer = window.matchMedia?.("(max-width: 760px)").matches;
  const slides = currentAlbum.photos.map((photo, photoIndex) => ({
    src: photo.url,
    thumbSrc: photo.url,
    type: "image",
    alt: currentAlbum.album.title,
    width: Number(photo.width) || undefined,
    height: Number(photo.height) || undefined,
    caption: `${currentAlbum.album.title} · ${photoIndex + 1} / ${currentAlbum.photos.length}`
  }));

  window.Fancybox.show(slides, {
    startIndex: index,
    closeExisting: true,
    dragToClose: true,
    Thumbs: { autoStart: !mobileViewer },
    Toolbar: {
      display: mobileViewer
        ? { left: ["counter"], middle: [], right: ["fullscreen", "close"] }
        : { left: ["counter"], middle: [], right: ["zoom", "slideshow", "fullscreen", "thumbs", "close"] }
    },
    Carousel: { infinite: false }
  });

  installLightboxLike(window.Fancybox.getInstance?.());
}

function closeLightbox() {
  window.Fancybox?.getInstance?.()?.close();
  lightboxIndex = null;
}

function installLightboxLike(instance) {
  const container = instance?.getContainer?.();
  if (!container) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "xrw-lightbox-like";
  button.innerHTML = icons.heart;
  container.appendChild(button);

  const sync = () => {
    const index = Number(instance.getCarousel?.()?.getPageIndex?.());
    if (Number.isFinite(index)) lightboxIndex = index;
    button.setAttribute("aria-label", `点赞第 ${Number(lightboxIndex) + 1} 张图片`);
    button.title = "点赞当前图片";
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    sync();
    likeLightboxPhoto(button);
  });
  instance.on?.("Carousel.change", () => requestAnimationFrame(sync));
  instance.on?.("destroy", () => {
    lightboxIndex = null;
  });
  sync();
}

function likeLightboxPhoto(button) {
  if (!currentAlbum || lightboxIndex === null) return;
  const photo = currentAlbum.photos[lightboxIndex];
  button.classList.remove("is-liked");
  void button.offsetWidth;
  button.classList.add("is-liked");
  queueLike({ photoId: photo.id });
}

function navigate(path) {
  history.pushState({}, "", appUrl(path));
  route().catch(errorPanel);
}

async function route() {
  window.removeEventListener("resize", renderDetailRowsOnResize);
  infiniteObserver?.disconnect();
  closeLightbox();
  const match = appPathname().match(/^\/album\/([^/]+)$/);
  try {
    if (match) {
      await renderAlbum(decodeURIComponent(match[1]));
    } else if (appPathname() === "/tags") {
      await renderTagsPage();
    } else {
      await renderHome();
    }
  } catch (error) {
    errorPanel(error);
  }
  requestAnimationFrame(() => smoothScroll?.resize());
}

initSmoothScroll();
window.addEventListener("popstate", () => route().catch(errorPanel));
window.addEventListener("scroll", onHomeScroll, { passive: true });
window.addEventListener("scroll", syncBackToTop, { passive: true });
window.addEventListener("resize", renderHomePhotoGridOnResize, { passive: true });
window.addEventListener("pagehide", () => {
  for (const id of pendingLikes.keys()) flushLikes(id);
});

route().catch(errorPanel);
