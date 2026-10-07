import { Player } from "./player.js";
import { buildMemories, surpriseMemory, memoryFromSelection, pickPhotos } from "./memories.js";
import { uploadPhotos, filesFromDrop } from "./upload.js";
import { withCaptureDate } from "./exif.js";
import { makeZip } from "./zip.js";

const $ = (id) => document.getElementById(id);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-8-4.9-8-11A4.5 4.5 0 0 1 12 6.8a4.5 4.5 0 0 1 8 2.7c0 6.1-8 11-8 11z"/></svg>';
const NAME_RE = /^(\d{13})-([0-9a-f]{16})-(\d+)x(\d+)\.jpg$/;

const DAY = 86400000;
const S = {
  photos: [], // in the library, newest first
  trashed: [], // in Recently Deleted, most recently deleted first
  byId: new Map(), // every photo, including recently deleted ones
  trash: {}, // photo name -> time it was deleted
  trashDays: 30,
  albums: [],
  favs: new Set(),
  view: "library",
  libMode: ["years", "months", "all"].includes(localStorage.getItem("libMode")) ? localStorage.getItem("libMode") : "all",
  albumId: null,
  selecting: false,
  selected: new Set(),
  loadedAt: 0,
  memories: null,
  memIndex: new Map(),
  cols: Number(localStorage.getItem("cols")) || (innerWidth < 500 ? 3 : innerWidth < 900 ? 5 : 7),
  error: null,
};

// ---------- helpers ----------
let toastTimer;
function toast(msg, ms = 3400) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const fmtEta = (s) => {
  if (s == null) return "";
  if (s < 90) return "Less than 2 minutes left";
  const m = Math.round(s / 60);
  if (m < 60) return `About ${m} minutes left`;
  const h = Math.floor(m / 60), r = Math.round((m % 60) / 5) * 5;
  return `About ${h} hour${h > 1 ? "s" : ""}${r ? ` ${r} minutes` : ""} left`;
};
const isDesktop = () => matchMedia("(pointer: fine)").matches;

class AuthError extends Error {}
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api/" + path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin();
    throw new AuthError(data.error || "Sign in to continue.");
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.code = data.code;
    throw err;
  }
  return data;
}
const showError = (err) => !(err instanceof AuthError) && toast(err.message);

const player = new Player({ toast });

// ---------- sign in ----------
function showLogin() {
  $("app").hidden = true;
  $("login").hidden = false;
  setTimeout(() => $("password").focus(), 50);
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector("button");
  btn.disabled = true;
  $("loginError").textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: $("password").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't sign in.");
    $("password").value = "";
    $("login").hidden = true;
    await boot();
  } catch (err) {
    $("loginError").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- loading ----------
function sortLists() {
  const all = [...S.byId.values()];
  S.photos = all.filter((p) => !S.trash[p.name]).sort((a, b) => b.t - a.t);
  S.trashed = all.filter((p) => S.trash[p.name]).sort((a, b) => S.trash[b.name] - S.trash[a.name]);
  S.memories = null;
}
const CACHE_KEY = "library-cache-v1";
function applyLibrary(d) {
  const all = d.photos
    .map((name) => {
      const m = name.match(NAME_RE);
      if (!m) return null;
      return { name, id: m[2], t: Number(m[1]), w: Number(m[3]), h: Number(m[4]), full: `/img/full/${name}`, thumb: `/img/thumb/${name}` };
    })
    .filter(Boolean);
  S.byId = new Map(all.map((p) => [p.id, p]));
  S.trash = d.trash || {};
  S.trashDays = d.trashDays || 30;
  sortLists();
  // Unsaved changes on this device win over what the server sent.
  S.favs = new Set((favDirty ? [...S.favs] : d.favorites || []).filter((id) => S.byId.has(id)));
  if (!albumsDirty) S.albums = d.albums || [];
  if (S.view === "album" && !currentAlbum()) S.view = "albums";
  S.bytes = d.bytes || 0;
  S.limit = d.limitBytes || 9.5e9;
}
// Reads the library one page at a time (photos and thumbnails side by side),
// keeps a copy on this device for instant opening, and reports storage used.
async function load() {
  const first = await api("photos");
  const names = [...first.photos];
  let bytes = first.bytes;
  const fullPages = (async () => {
    for (let c = first.cursor; c; ) {
      const p = await api(`photos?cursor=${encodeURIComponent(c)}`);
      names.push(...p.photos);
      bytes += p.bytes;
      c = p.cursor;
    }
  })();
  const thumbPages = (async () => {
    let c = "";
    do {
      const p = await api(`photos?prefix=thumb${c ? `&cursor=${encodeURIComponent(c)}` : ""}`);
      bytes += p.bytes;
      c = p.cursor;
    } while (c);
  })();
  await Promise.all([fullPages, thumbPages]);
  const d = { photos: names, favorites: first.favorites, trash: first.trash, albums: first.albums, trashDays: first.trashDays, limitBytes: first.limitBytes, bytes };
  applyLibrary(d);
  S.loadedAt = Date.now();
  S.error = null;
  api("usage", { method: "POST", body: { bytes } }).catch(() => {});
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(d));
  } catch {}
}

async function boot() {
  // Show the copy saved on this device right away, then refresh it.
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
  } catch {}
  if (cached?.photos && !S.loadedAt) {
    applyLibrary(cached);
    $("login").hidden = true;
    $("app").hidden = false;
    render();
  }
  try {
    await load();
  } catch (err) {
    if (err instanceof AuthError) return;
    if (cached?.photos) {
      toast("Couldn't refresh your library. Showing what was saved on this device.");
      return;
    }
    S.error = err.message;
  }
  $("login").hidden = true;
  $("app").hidden = false;
  render();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.loadedAt && Date.now() - S.loadedAt > 6 * 3600 * 1000) load().then(render).catch(() => {});
});

// ---------- lists ----------
const currentAlbum = () => S.albums.find((a) => a.id === S.albumId);
const albumPhotos = (a) =>
  a.photos
    .map((id) => S.byId.get(id))
    .filter((p) => p && !S.trash[p.name])
    .sort((x, y) => y.t - x.t);
function currentList() {
  if (S.view === "favorites") return S.photos.filter((p) => S.favs.has(p.id));
  if (S.view === "album") return currentAlbum() ? albumPhotos(currentAlbum()) : [];
  if (S.view === "trash") return S.trashed;
  return S.photos;
}
const coverOf = (list) => list.find((p) => S.favs.has(p.id) && p.w >= p.h) || list.find((p) => p.w >= p.h) || list[0];
function groupBy(list, key) {
  const m = new Map();
  for (const p of list) {
    const k = key(p);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  }
  return m;
}
function daysLeft(p) {
  const left = Math.ceil((S.trash[p.name] + S.trashDays * DAY - Date.now()) / DAY);
  return left <= 0 ? "Today" : plural(left, "day");
}

// ---------- rendering ----------
function cellHTML(p) {
  return `<button class="cell${S.selected.has(p.id) ? " sel" : ""}" data-id="${p.id}" aria-label="${esc(fmtDay(p.t))}"><img src="${esc(p.thumb)}" alt="" loading="lazy" decoding="async" crossorigin="anonymous">${S.favs.has(p.id) && S.view !== "trash" ? `<span class="fav-badge">${HEART}</span>` : ""}${S.view === "trash" ? `<span class="days-left">${daysLeft(p)}</span>` : ""}</button>`;
}
function gridHTML(list) {
  let html = "";
  let cur = null;
  for (const p of list) {
    const d = new Date(p.t);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (key !== cur) {
      if (cur !== null) html += "</div></section>";
      cur = key;
      html += `<section class="month" data-month="${key}"><h2>${MONTHS[d.getMonth()]} <span>${d.getFullYear()}</span></h2><div class="grid">`;
    }
    html += cellHTML(p);
  }
  return html ? html + "</div></section>" : "";
}

function renderYears(el) {
  const years = groupBy(S.photos, (p) => new Date(p.t).getFullYear());
  el.innerHTML = `<div class="tiles years">${[...years]
    .map(([y, ps]) => {
      const c = coverOf(ps);
      return `<button class="tile" data-year="${y}"><img src="${esc(c.full)}" alt="" loading="lazy" decoding="async" crossorigin="anonymous"><span class="t-text"><h3>${y}</h3><p>${plural(ps.length, "photo")}</p></span></button>`;
    })
    .join("")}</div>`;
}
function renderMonths(el) {
  const years = groupBy(S.photos, (p) => new Date(p.t).getFullYear());
  let html = "";
  for (const [y, ps] of years) {
    html += `<h2 class="year-head" data-year-head="${y}">${y}</h2><div class="tiles months">`;
    for (const [m, mps] of groupBy(ps, (p) => new Date(p.t).getMonth())) {
      const c = coverOf(mps);
      html += `<button class="tile" data-month-tile="${y}-${m}"><img src="${esc(c.thumb)}" alt="" loading="lazy" decoding="async" crossorigin="anonymous"><span class="t-text"><h3>${MONTHS[m]}</h3><p>${plural(mps.length, "photo")}</p></span></button>`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;
}

const ALBUM_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h13a1 1 0 0 1 1 1v13h-2V5H7zM3 7h13a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>';
function albumCard(attrs, name, list, icon = ALBUM_ICON) {
  const c = list.length ? coverOf(list) : null;
  return `<button class="album-card" ${attrs}><span class="album-cover">${c ? `<img src="${esc(c.thumb)}" alt="" loading="lazy" decoding="async" crossorigin="anonymous">` : icon}</span><strong>${esc(name)}</strong><span>${list.length.toLocaleString()}</span></button>`;
}
function renderAlbums(el) {
  const favList = S.photos.filter((p) => S.favs.has(p.id));
  const mine = [...S.albums].sort((a, b) => b.created - a.created);
  el.innerHTML = `
    <h2 class="albums-section-title">My Albums</h2>
    <div class="album-grid">
      ${albumCard('data-goto="favorites"', "Favorites", favList, HEART)}
      ${mine.map((a) => albumCard(`data-album="${a.id}"`, a.name, albumPhotos(a))).join("")}
    </div>
    ${mine.length ? "" : `<p class="trash-note">Tap New album to make one, or go to Library, tap Select, choose photos, and tap Add to album.</p>`}
    <div class="albums-utilities">
      <h2>Utilities</h2>
      <button class="util-row" data-goto="trash">${TRASH_ICON}Recently Deleted<span>${S.trashed.length.toLocaleString()}</span></button>
    </div>`;
}

function memoryCard(m, feature = false) {
  S.memIndex.set(m.key, m);
  return `<button class="memory${feature ? " mem-feature" : ""}" data-mem="${esc(m.key)}">
    <img src="${esc(m.cover.full)}" alt="" loading="lazy" decoding="async" crossorigin="anonymous">
    <span class="m-text"><h3>${esc(m.title)}</h3><p>${esc(m.subtitle)}</p></span>
  </button>`;
}
function renderMemories() {
  const el = $("view-memories");
  if (S.photos.length < 8) {
    el.innerHTML = `<div class="empty"><h2>No memories yet</h2><p>Memories appear once your library has photos from a few different days. Add more photos and check back.</p><button class="btn-primary" data-action="upload">Add photos</button></div>`;
    return;
  }
  const M = (S.memories ||= buildMemories(S.photos, S.favs));
  S.memIndex.clear();
  const featured = M.onThisDay || M.events[0];
  const events = M.events.filter((m) => m !== featured).slice(0, 80);
  let html = "";
  if (featured) html += `<div class="mem-section"><div class="mem-list" style="grid-template-columns:1fr">${memoryCard(featured, true)}</div></div>`;
  if (events.length) html += `<div class="mem-section"><h2>Days and trips</h2><div class="mem-list">${events.map((m) => memoryCard(m)).join("")}</div></div>`;
  if (M.favorites) html += `<div class="mem-section"><h2>Favorites</h2><div class="mem-list">${memoryCard(M.favorites)}</div></div>`;
  if (M.years.length) html += `<div class="mem-section"><h2>Years</h2><div class="mem-list">${M.years.map((m) => memoryCard(m)).join("")}</div></div>`;
  if (!html) html = `<div class="empty"><h2>No memories yet</h2><p>Memories come from days with several photos. Tap New memory to make one from any stretch of your library.</p></div>`;
  el.innerHTML = html;
}

const EMPTY = {
  library: `<div class="empty"><h2>Add your first photos</h2><p>On iPhone, tap Add photos and choose from your library. On a computer, choose a whole folder, even one on an external drive, or drag it onto this page. Videos are skipped.</p><button class="btn-primary" data-action="upload">Add photos</button></div>`,
  favorites: `<div class="empty"><h2>No favorites yet</h2><p>Open a photo and tap the heart. Favorites show up here and get priority in memories.</p></div>`,
  album: `<div class="empty"><h2>This album is empty</h2><p>Go to Library, tap Select, choose photos, then tap Add to album.</p></div>`,
  trash: `<div class="empty"><h2>No recently deleted photos</h2><p>Photos you delete stay here for 30 days, so you can recover them.</p></div>`,
};
const VIEWS = ["library", "memories", "favorites", "albums", "album", "trash"];

function render() {
  const { view } = S;
  for (const v of VIEWS) $("view-" + v).hidden = v !== view;
  const tab = view === "album" || view === "trash" ? "albums" : view;
  for (const b of document.querySelectorAll(".tabbar button")) {
    if (b.dataset.view === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  $("main").style.setProperty("--cols", S.cols);
  $("main").classList.toggle("selecting", S.selecting);

  const list = currentList();
  const album = currentAlbum();
  const libGrid = view !== "library" || S.libMode === "all";
  $("viewTitle").textContent =
    { library: "Library", memories: "Memories", favorites: "Favorites", albums: "Albums", trash: "Recently Deleted" }[view] ?? album?.name ?? "";
  $("backBtn").hidden = view !== "album" && view !== "trash";
  $("viewSub").textContent =
    view === "memories" || (!list.length && view !== "albums")
      ? ""
      : view === "albums"
        ? plural(S.albums.length + 1, "album")
        : view === "library" && S.bytes
          ? `${plural(list.length, "photo")}, ${fmtBytes(S.bytes)} of ${fmtBytes(S.limit)} free storage used`
          : plural(list.length, "photo");
  $("libModes").hidden = view !== "library" || S.selecting || !S.photos.length;
  for (const b of $("libModes").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.mode === S.libMode));
  const gridView = ["library", "favorites", "album", "trash"].includes(view);
  $("slideshowBtn").hidden = !gridView || view === "trash" || !list.length || S.selecting;
  $("selectBtn").hidden = !gridView || !list.length || !libGrid;
  $("selectBtn").textContent = S.selecting ? "Cancel" : "Select";
  $("selectAllBtn").hidden = !S.selecting;
  $("surpriseBtn").hidden = view !== "memories" || S.photos.length < 4;
  $("newAlbumBtn").hidden = view !== "albums";
  $("albumMenuBtn").hidden = view !== "album" || S.selecting;
  $("uploadBtn").hidden = S.selecting || !["library", "memories"].includes(view);

  const el = $("view-" + view);
  if (S.error) {
    el.innerHTML = `<div class="empty"><h2>Your photos didn't load</h2><p>${esc(S.error)}</p><button class="btn-primary" data-action="retry">Try again</button></div>`;
    return;
  }
  if (view === "memories") return renderMemories();
  if (view === "albums") return renderAlbums(el);
  if (!list.length) {
    el.innerHTML = EMPTY[view];
    return;
  }
  if (view === "library" && S.libMode === "years") return renderYears(el);
  if (view === "library" && S.libMode === "months") return renderMonths(el);
  if (view === "trash") {
    el.innerHTML = `<p class="trash-note">Photos here are deleted for good after ${S.trashDays} days. Until then they still count toward your storage.</p><section class="month"><div class="grid">${list.map(cellHTML).join("")}</div></section>`;
  } else el.innerHTML = gridHTML(list);
  updateSelbar();
}

// Scrolls so a section sits just under the top bar. Sections far away start out
// as placeholders, so it corrects itself once they've been drawn.
function scrollToSection(sel) {
  const go = () => {
    const el = document.querySelector(sel);
    if (!el) return;
    const top = el.getBoundingClientRect().top + scrollY - document.querySelector(".topbar").offsetHeight - 4;
    scrollTo({ top: Math.max(0, top) });
  };
  go();
  setTimeout(go, 120);
  setTimeout(go, 450);
}

// ---------- navigation ----------
function goTo(view, extra = {}) {
  S.view = view;
  Object.assign(S, extra);
  exitSelect(false);
  render();
  scrollTo(0, 0);
}
document.querySelector(".tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  if (S.view === b.dataset.view) return scrollTo({ top: 0, behavior: "smooth" });
  goTo(b.dataset.view);
});
$("backBtn").onclick = () => goTo("albums");
$("libModes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  S.libMode = b.dataset.mode;
  localStorage.setItem("libMode", S.libMode);
  render();
  scrollTo(0, 0);
});

$("main").addEventListener("click", (e) => {
  const cell = e.target.closest(".cell");
  if (cell) {
    const id = cell.dataset.id;
    if (S.selecting) {
      S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
      cell.classList.toggle("sel", S.selected.has(id));
      updateSelbar();
    } else {
      const list = currentList();
      openViewer(list, list.findIndex((p) => p.id === id));
    }
    return;
  }
  const t = e.target.closest("[data-year],[data-month-tile],[data-album],[data-goto],[data-mem],[data-action]");
  if (!t) return;
  const d = t.dataset;
  if (d.year) {
    S.libMode = "months";
    render();
    scrollToSection(`[data-year-head="${d.year}"]`);
  } else if (d.monthTile) {
    S.libMode = "all";
    render();
    scrollToSection(`#view-library [data-month="${d.monthTile}"]`);
  } else if (d.album) goTo("album", { albumId: d.album });
  else if (d.goto) goTo(d.goto);
  else if (d.mem) playMemory(S.memIndex.get(d.mem));
  else if (d.action === "upload") isDesktop() ? $("folderInput").click() : $("fileInput").click();
  else if (d.action === "retry") boot();
});

// Pinch the grid to change how many photos fit across.
let pinchBase = 0;
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
$("main").addEventListener("touchstart", (e) => { if (e.touches.length === 2) pinchBase = dist(e.touches); }, { passive: true });
$("main").addEventListener("touchmove", (e) => {
  if (e.touches.length !== 2 || !pinchBase) return;
  const r = dist(e.touches) / pinchBase;
  if (r > 1.3 || r < 0.77) {
    setCols(S.cols + (r > 1 ? -1 : 1));
    pinchBase = dist(e.touches);
  }
}, { passive: true });
$("main").addEventListener("touchend", () => (pinchBase = 0));
document.addEventListener("keydown", (e) => {
  if (!$("viewer").hidden || !$("player").hidden || e.target.tagName === "INPUT") return;
  if (e.key === "+" || e.key === "=") setCols(S.cols - 1);
  if (e.key === "-") setCols(S.cols + 1);
});
function setCols(n) {
  S.cols = Math.max(1, Math.min(12, n));
  localStorage.setItem("cols", S.cols);
  $("main").style.setProperty("--cols", S.cols);
}

// ---------- selection ----------
$("selectBtn").onclick = () => (S.selecting ? exitSelect() : enterSelect());
$("selectAllBtn").onclick = () => {
  const list = currentList();
  const all = list.every((p) => S.selected.has(p.id));
  S.selected = all ? new Set() : new Set(list.map((p) => p.id));
  render();
};
function enterSelect() {
  S.selecting = true;
  S.selected.clear();
  $("selbar").hidden = false;
  render();
}
function exitSelect(rerender = true) {
  if (!S.selecting) return;
  S.selecting = false;
  S.selected.clear();
  $("selbar").hidden = true;
  if (rerender) render();
}
function updateSelbar() {
  if (!S.selecting) return;
  const n = S.selected.size;
  $("selCount").textContent = n ? `${plural(n, "photo")} selected` : "Select photos";
  for (const b of document.querySelectorAll(".selbar-actions button")) {
    b.disabled = !n;
    const only = b.dataset.only?.split(" "), not = b.dataset.not?.split(" ");
    b.hidden = (only && !only.includes(S.view)) || (not && not.includes(S.view));
  }
  const allFav = n && [...S.selected].every((id) => S.favs.has(id));
  document.querySelector('[data-act="favorite"]').textContent = allFav ? "Unfavorite" : "Favorite";
  document.querySelector('[data-act="delete"]').textContent = S.view === "trash" ? "Delete for good" : "Delete";
  const list = currentList();
  $("selectAllBtn").textContent = list.length && list.every((p) => S.selected.has(p.id)) ? "Deselect all" : "Select all";
}
const selectedPhotos = () => [...S.selected].map((id) => S.byId.get(id)).filter(Boolean).sort((a, b) => a.t - b.t);

document.querySelector(".selbar-actions").addEventListener("click", async (e) => {
  const act = e.target.closest("button")?.dataset.act;
  const photos = selectedPhotos();
  if (!act || !photos.length) return;
  if (act === "save") return saveMany(photos);
  if (act === "addAlbum") return openAlbumPicker(photos);
  if (act === "removeAlbum") {
    const a = currentAlbum();
    const gone = new Set(photos.map((p) => p.id));
    a.photos = a.photos.filter((id) => !gone.has(id));
    saveAlbums();
    toast(`Removed ${plural(photos.length, "photo")} from ${a.name}.`);
    return exitSelect();
  }
  if (act === "slideshow") return player.open({ photos, kind: "slideshow", loop: true });
  if (act === "movie") {
    const m = memoryFromSelection(photos, S.favs);
    return player.open({ photos: m.photos, title: m.title, subtitle: m.subtitle, kind: "memory" });
  }
  if (act === "favorite") {
    const allFav = photos.every((p) => S.favs.has(p.id));
    photos.forEach((p) => (allFav ? S.favs.delete(p.id) : S.favs.add(p.id)));
    saveFavs();
    return exitSelect();
  }
  if (act === "recover") {
    if (await recoverPhotos(photos)) exitSelect();
    return;
  }
  if (act === "delete") {
    if (await removePhotos(photos)) exitSelect();
  }
});

// ---------- favorites ----------
let favTimer;
let favDirty = false;
let favVersion = 0;
function saveFavs() {
  S.memories = null;
  favDirty = true;
  const v = ++favVersion;
  clearTimeout(favTimer);
  favTimer = setTimeout(async () => {
    try {
      await api("favorites", { method: "PUT", body: { ids: [...S.favs] } });
      if (v === favVersion) favDirty = false;
    } catch (err) {
      if (!(err instanceof AuthError)) toast("Favorites didn't save. Check your connection and try again.");
    }
  }, 500);
}

// ---------- albums ----------
let albumTimer;
let albumsDirty = false;
let albumsVersion = 0;
function saveAlbums() {
  albumsDirty = true;
  const v = ++albumsVersion;
  clearTimeout(albumTimer);
  albumTimer = setTimeout(async () => {
    try {
      await api("albums", { method: "PUT", body: { albums: S.albums } });
      if (v === albumsVersion) albumsDirty = false;
    } catch (err) {
      if (!(err instanceof AuthError)) toast("Album changes didn't save. Check your connection and try again.");
    }
  }, 400);
}
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => (b % 36).toString(36)).join("");
function createAlbum(photos = []) {
  const name = prompt("Name this album", "");
  if (name === null) return null;
  const a = { id: newId(), name: name.trim().slice(0, 80) || "Untitled Album", photos: photos.map((p) => p.id), created: Date.now() };
  S.albums.push(a);
  saveAlbums();
  return a;
}
$("newAlbumBtn").onclick = () => {
  const a = createAlbum();
  if (a) render();
};
$("albumMenuBtn").onclick = (e) => {
  e.stopPropagation();
  $("albumMenu").hidden = !$("albumMenu").hidden;
};
document.addEventListener("click", (e) => {
  if (!$("albumMenu").hidden && !e.target.closest("#albumMenu")) $("albumMenu").hidden = true;
});
$("albumMenu").addEventListener("click", (e) => {
  const act = e.target.closest("button")?.dataset.albumAct;
  const a = currentAlbum();
  $("albumMenu").hidden = true;
  if (!act || !a) return;
  if (act === "rename") {
    const name = prompt("Rename album", a.name);
    if (name === null) return;
    a.name = name.trim().slice(0, 80) || a.name;
    saveAlbums();
    render();
  }
  if (act === "delete") {
    if (!confirm(`Delete the album "${a.name}"? The photos stay in your library.`)) return;
    S.albums = S.albums.filter((x) => x !== a);
    saveAlbums();
    goTo("albums");
  }
});

let pickerPhotos = [];
function openAlbumPicker(photos) {
  pickerPhotos = photos;
  $("pickerText").textContent = plural(photos.length, "photo");
  const mine = [...S.albums].sort((a, b) => b.created - a.created);
  $("pickerList").innerHTML =
    `<button data-pick="new"><span class="picker-thumb"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg></span><span><strong>New album…</strong></span></button>` +
    mine
      .map((a) => {
        const list = albumPhotos(a);
        const c = list.length ? coverOf(list) : null;
        return `<button data-pick="${a.id}">${c ? `<img class="picker-thumb" src="${esc(c.thumb)}" alt="" crossorigin="anonymous">` : `<span class="picker-thumb">${ALBUM_ICON}</span>`}<span><strong>${esc(a.name)}</strong><small>${plural(list.length, "photo")}</small></span></button>`;
      })
      .join("");
  $("albumPicker").hidden = false;
}
$("pickerCancel").onclick = () => ($("albumPicker").hidden = true);
$("pickerList").addEventListener("click", (e) => {
  const id = e.target.closest("button")?.dataset.pick;
  if (!id) return;
  let a;
  if (id === "new") {
    a = createAlbum(pickerPhotos);
    if (!a) return;
  } else {
    a = S.albums.find((x) => x.id === id);
    const have = new Set(a.photos);
    for (const p of pickerPhotos) if (!have.has(p.id)) a.photos.push(p.id);
    saveAlbums();
  }
  $("albumPicker").hidden = true;
  toast(`Added ${plural(pickerPhotos.length, "photo")} to ${a.name}.`);
  exitSelect();
});

// ---------- delete, recently deleted, recover ----------
async function inChunks(path, photos, size) {
  for (let i = 0; i < photos.length; i += size) {
    await api(path, { method: "POST", body: { names: photos.slice(i, i + size).map((p) => p.name) } });
  }
}
// In Recently Deleted this deletes for good; everywhere else it moves photos there.
async function removePhotos(photos) {
  const forGood = S.view === "trash";
  const n = plural(photos.length, "photo");
  const ok = forGood
    ? confirm(`Delete ${n} for good? This can't be undone.`)
    : confirm(`Delete ${n}? ${photos.length === 1 ? "It moves" : "They move"} to Recently Deleted for ${S.trashDays} days, where you can recover ${photos.length === 1 ? "it" : "them"}.`);
  if (!ok) return false;
  try {
    if (forGood) {
      await inChunks("delete", photos, 500);
      for (const p of photos) {
        S.byId.delete(p.id);
        delete S.trash[p.name];
        if (S.favs.delete(p.id)) saveFavs();
      }
      sortLists();
      toast(`Deleted ${n} for good.`);
      load().then(render).catch(() => {}); // refresh storage used
    } else {
      await inChunks("trash", photos, 5000);
      const now = Date.now();
      for (const p of photos) S.trash[p.name] = now;
      sortLists();
      toast(`Moved ${n} to Recently Deleted.`);
    }
    render();
    return true;
  } catch (err) {
    showError(err);
    return false;
  }
}
async function recoverPhotos(photos) {
  try {
    await inChunks("restore", photos, 5000);
    for (const p of photos) delete S.trash[p.name];
    sortLists();
    toast(`Recovered ${plural(photos.length, "photo")}.`);
    render();
    return true;
  } catch (err) {
    showError(err);
    return false;
  }
}

// ---------- save several ----------
let saveCancelled = false;
$("saveCancel").onclick = () => {
  saveCancelled = true;
  $("saveModal").hidden = true;
};
async function datedFile(p) {
  const res = await fetch(p.full);
  if (!res.ok) throw new Error("A photo didn't download. Check your connection and try again.");
  return new File([await withCaptureDate(await res.blob(), p.t)], fileName(p), { type: "image/jpeg", lastModified: p.t });
}
async function saveMany(photos) {
  const phone = !isDesktop() && !!navigator.canShare;
  const max = phone ? 50 : 1000;
  if (photos.length > max) {
    return toast(phone ? "You can save up to 50 photos at a time on iPhone. Select fewer and try again." : "You can save up to 1,000 photos at a time. Select fewer and try again.");
  }
  saveCancelled = false;
  $("saveModal").hidden = false;
  $("saveTitle").textContent = `Saving ${plural(photos.length, "photo")}`;
  $("saveText").textContent = "Getting the photos ready…";
  $("saveGo").hidden = true;
  $("saveBar").style.transform = "scaleX(0)";
  const files = [];
  let done = 0, next = 0;
  try {
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < photos.length && !saveCancelled) {
          const k = next++;
          files[k] = await datedFile(photos[k]);
          $("saveBar").style.transform = `scaleX(${++done / photos.length})`;
        }
      })
    );
  } catch (err) {
    $("saveModal").hidden = true;
    return toast(err.message);
  }
  if (saveCancelled) return;
  // iPhone: the share sheet's "Save Images" puts them in the Camera Roll. It needs a fresh tap.
  if (phone && navigator.canShare({ files })) {
    $("saveTitle").textContent = "Ready to save";
    $("saveText").textContent = `Tap Save, then choose Save ${files.length} Images.`;
    $("saveGo").hidden = false;
    $("saveGo").textContent = `Save ${plural(files.length, "photo")}`;
    $("saveGo").onclick = async () => {
      try {
        await navigator.share({ files });
        $("saveModal").hidden = true;
        exitSelect();
      } catch (err) {
        if (err.name !== "AbortError") toast("Saving didn't work. Try again with fewer photos.");
      }
    };
    return;
  }
  // Computer: one photo downloads as is; several come as a single zip file.
  $("saveText").textContent = "Packing your download…";
  const blob = files.length === 1 ? files[0] : await makeZip(files);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = files.length === 1 ? files[0].name : `Photos (${files.length}).zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  $("saveModal").hidden = true;
  toast(files.length === 1 ? "Photo saved to your downloads." : `Saved ${plural(files.length, "photo")} as a zip file in your downloads.`);
  exitSelect();
}

// ---------- slideshow & memories ----------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
$("slideshowBtn").onclick = () => {
  const list = currentList();
  if (!list.length) return;
  // The whole library plays shuffled; favorites play in date order.
  const photos = S.view === "library" ? shuffle(list) : [...list].sort((a, b) => a.t - b.t);
  player.open({ photos, kind: "slideshow", loop: true });
};
function playMemory(m) {
  if (!m) return;
  player.open({
    photos: m.photos,
    title: m.title,
    subtitle: m.subtitle,
    kind: "memory",
    reshuffle: () => pickPhotos(m.source, S.favs, Math.max(m.photos.length, 12), Math.floor(Math.random() * 1e9) + 2),
  });
}
$("surpriseBtn").onclick = () => {
  const m = surpriseMemory(S.photos, S.favs);
  if (!m) return toast("Add a few more photos to make a memory.");
  playMemory(m);
};

// ---------- viewer ----------
const V = { list: [], i: 0, file: null, fileFor: null, url: null };
const vImg = $("vImg");
const stage = $("vStage");
vImg.crossOrigin = "anonymous";

function openViewer(list, i) {
  if (i < 0) return;
  V.list = list;
  V.i = i;
  const inTrash = S.view === "trash";
  $("vRecover").hidden = !inTrash;
  $("vFav").hidden = $("vPlay").hidden = inTrash;
  $("vDelete").setAttribute("aria-label", inTrash ? "Delete for good" : "Delete photo");
  $("viewer").hidden = false;
  $("viewer").classList.remove("chrome-off");
  document.body.classList.add("no-scroll");
  showPhoto();
}
function closeViewer() {
  $("viewer").hidden = true;
  document.body.classList.remove("no-scroll");
  vImg.removeAttribute("src");
  if (V.url) URL.revokeObjectURL(V.url);
  V.url = V.file = V.fileFor = null;
}
const pad = (n) => String(n).padStart(2, "0");
function fileName(p) {
  const d = new Date(p.t);
  return `Photo ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.jpg`;
}
function showPhoto() {
  const p = V.list[V.i];
  if (!p) return closeViewer();
  resetZoom(false);
  vImg.style.opacity = "";
  vImg.src = p.thumb;
  V.file = V.fileFor = null;
  // Load the full photo, and get a dated copy ready so Save works instantly.
  fetch(p.full)
    .then((r) => (r.ok ? r.blob() : Promise.reject()))
    .then(async (blob) => {
      if (V.list[V.i] !== p) return;
      if (V.url) URL.revokeObjectURL(V.url);
      V.url = URL.createObjectURL(blob);
      vImg.src = V.url;
      const dated = await withCaptureDate(blob, p.t);
      if (V.list[V.i] === p) {
        V.file = new File([dated], fileName(p), { type: "image/jpeg", lastModified: p.t });
        V.fileFor = p.id;
      }
    })
    .catch(() => {});
  [V.list[V.i + 1], V.list[V.i - 1]].forEach((n) => {
    if (n) {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.src = n.full;
    }
  });
  $("vDate").textContent = fmtDay(p.t);
  $("vTime").textContent = fmtTime(p.t);
  $("vCount").textContent = `${(V.i + 1).toLocaleString()} of ${V.list.length.toLocaleString()}`;
  $("vFav").setAttribute("aria-pressed", String(S.favs.has(p.id)));
  $("vFav").setAttribute("aria-label", S.favs.has(p.id) ? "Remove from favorites" : "Add to favorites");
}
function step(d) {
  const n = V.i + d;
  if (n < 0 || n >= V.list.length) {
    vImg.style.transform = "";
    vImg.style.opacity = "";
    return;
  }
  V.i = n;
  showPhoto();
}
$("vClose").onclick = closeViewer;
$("vPrev").onclick = () => step(-1);
$("vNext").onclick = () => step(1);
$("vFav").onclick = () => {
  const p = V.list[V.i];
  S.favs.has(p.id) ? S.favs.delete(p.id) : S.favs.add(p.id);
  saveFavs();
  $("vFav").setAttribute("aria-pressed", String(S.favs.has(p.id)));
  render();
};
$("vPlay").onclick = () => {
  const photos = [...V.list.slice(V.i), ...V.list.slice(0, V.i)];
  closeViewer();
  player.open({ photos, kind: "slideshow", loop: true });
};
// Takes the current photo out of the viewer's list after it's deleted or recovered.
function dropCurrent() {
  const p = V.list[V.i];
  V.list = V.list.filter((x) => x.id !== p.id);
  if (V.i >= V.list.length) V.i = V.list.length - 1;
  V.list.length ? showPhoto() : closeViewer();
}
$("vDelete").onclick = async () => {
  if (await removePhotos([V.list[V.i]])) dropCurrent();
};
$("vRecover").onclick = async () => {
  if (await recoverPhotos([V.list[V.i]])) dropCurrent();
};

// Save: on iPhone this opens the share sheet, where "Save Image" puts the photo
// in your Camera Roll on the day it was taken. On a computer it downloads.
$("vSave").onclick = async () => {
  const p = V.list[V.i];
  let file = V.fileFor === p.id ? V.file : null;
  if (!file) {
    toast("Getting the photo ready…", 1500);
    try {
      const blob = await (await fetch(p.full)).blob();
      file = new File([await withCaptureDate(blob, p.t)], fileName(p), { type: "image/jpeg", lastModified: p.t });
    } catch {
      return toast("The photo didn't download. Check your connection and try again.");
    }
  }
  if (!isDesktop() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name === "NotAllowedError") toast("Tap Save once more to save the photo.");
    }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  toast("Photo saved to your downloads.");
};

// ---------- zoom and gestures (works like the iPhone Photos app) ----------
// Pinch with two fingers to zoom, drag to look around, double-tap to zoom in or
// back out. Swipe sideways for the next photo and down to close when not zoomed.
const Z = { s: 1, x: 0, y: 0 };
const MAX_ZOOM = 5;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function applyZoom(animate) {
  vImg.classList.toggle("dragging", !animate);
  vImg.style.transform = Z.s === 1 && !Z.x && !Z.y ? "" : `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`;
  $("viewer").classList.toggle("zoomed", Z.s > 1.01);
}
function resetZoom(animate = true) {
  Z.s = 1;
  Z.x = Z.y = 0;
  applyZoom(animate);
}
// Position relative to the middle of the screen.
function rel(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
}
// Keeps the photo's edges from being dragged past the edge of the screen.
function clampPan() {
  const bx = Math.max(0, (vImg.offsetWidth * Z.s - stage.clientWidth) / 2);
  const by = Math.max(0, (vImg.offsetHeight * Z.s - stage.clientHeight) / 2);
  Z.x = clampN(Z.x, -bx, bx);
  Z.y = clampN(Z.y, -by, by);
}
// Zooms to scale s while keeping the point under the finger (or cursor) in place.
function zoomAt(point, s) {
  const qx = (point.x - Z.x) / Z.s, qy = (point.y - Z.y) / Z.s;
  Z.s = s;
  Z.x = point.x - s * qx;
  Z.y = point.y - s * qy;
}
function settle() {
  if (Z.s < 1.01) return resetZoom(true);
  clampPan();
  applyZoom(true);
}

const G = { pts: new Map(), mode: null, moved: false, lastTap: null, tapTimer: null };
const midOf = () => {
  const [a, b] = [...G.pts.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
};
function beginGesture() {
  if (G.pts.size >= 2) {
    const m = midOf();
    const c = rel(m.x, m.y);
    G.mode = "pinch";
    G.start = { s: Z.s, d: m.d || 1, qx: (c.x - Z.x) / Z.s, qy: (c.y - Z.y) / Z.s };
  } else if (G.pts.size === 1) {
    const p = [...G.pts.values()][0];
    G.mode = Z.s > 1.01 ? "pan" : "swipe";
    G.start = { x: p.x, y: p.y, zx: Z.x, zy: Z.y };
  }
}
stage.addEventListener("pointerdown", (e) => {
  stage.setPointerCapture?.(e.pointerId);
  G.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (G.pts.size === 1) {
    G.moved = false;
    G.downAt = Date.now();
    G.downPos = { x: e.clientX, y: e.clientY };
  } else G.moved = true;
  beginGesture();
});
stage.addEventListener("pointermove", (e) => {
  if (!G.pts.has(e.pointerId)) return;
  G.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (G.downPos && Math.hypot(e.clientX - G.downPos.x, e.clientY - G.downPos.y) > 10) G.moved = true;
  if (G.mode === "pinch" && G.pts.size >= 2) {
    const m = midOf();
    const c = rel(m.x, m.y);
    Z.s = clampN((G.start.s * m.d) / G.start.d, 0.6, MAX_ZOOM * 1.3);
    Z.x = c.x - Z.s * G.start.qx;
    Z.y = c.y - Z.s * G.start.qy;
    applyZoom(false);
  } else if (G.mode === "pan") {
    Z.x = G.start.zx + (e.clientX - G.start.x);
    Z.y = G.start.zy + (e.clientY - G.start.y);
    applyZoom(false);
  } else if (G.mode === "swipe") {
    const dx = e.clientX - G.start.x, dy = e.clientY - G.start.y;
    vImg.classList.add("dragging");
    if (Math.abs(dx) > Math.abs(dy)) vImg.style.transform = `translateX(${dx}px)`;
    else if (dy > 0) {
      vImg.style.transform = `translateY(${dy}px) scale(${Math.max(0.7, 1 - dy / 1200)})`;
      $("viewer").style.background = `rgba(0,0,0,${Math.max(0.3, 1 - dy / 500)})`;
    }
  }
});
function endPointer(e) {
  if (!G.pts.has(e.pointerId)) return;
  const last = G.pts.get(e.pointerId);
  G.pts.delete(e.pointerId);
  $("viewer").style.background = "";
  if (G.pts.size > 0) {
    // One finger lifted after a pinch: keep panning with the other.
    if (Z.s > MAX_ZOOM) {
      const p = [...G.pts.values()][0];
      zoomAt(rel(p.x, p.y), MAX_ZOOM);
    }
    beginGesture();
    return;
  }
  const mode = G.mode;
  G.mode = null;
  if (mode === "pinch" || mode === "pan") {
    if (Z.s > MAX_ZOOM) zoomAt(rel(last.x, last.y), MAX_ZOOM);
    settle();
    // A tap (not a drag) on a zoomed photo still counts, so double-tap zooms back out.
    if (mode === "pan" && !G.moved && Date.now() - G.downAt <= 400) handleTap(last);
    return;
  }
  // Swipe or tap with the photo at normal size.
  const dx = last.x - G.start.x, dy = last.y - G.start.y;
  vImg.classList.remove("dragging");
  if (G.moved) {
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) return step(dx < 0 ? 1 : -1);
    if (dy > 110 && dy > Math.abs(dx)) return closeViewer();
    vImg.style.transform = "";
    return;
  }
  if (Date.now() - G.downAt > 400) return;
  handleTap(last);
}
stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);

// Single tap shows or hides the controls; double tap zooms in or out.
function handleTap(pt) {
  const now = Date.now();
  if (G.lastTap && now - G.lastTap.t < 320 && Math.hypot(pt.x - G.lastTap.x, pt.y - G.lastTap.y) < 40) {
    clearTimeout(G.tapTimer);
    G.lastTap = null;
    if (Z.s > 1.01) resetZoom(true);
    else {
      zoomAt(rel(pt.x, pt.y), 2.5);
      settle();
    }
    return;
  }
  G.lastTap = { t: now, x: pt.x, y: pt.y };
  clearTimeout(G.tapTimer);
  G.tapTimer = setTimeout(() => $("viewer").classList.toggle("chrome-off"), 320);
}

// Trackpad pinch (or Ctrl + scroll) zooms on a computer; scrolling pans when zoomed.
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      zoomAt(rel(e.clientX, e.clientY), clampN(Z.s * Math.exp(-e.deltaY * 0.01), 1, MAX_ZOOM));
      clampPan();
      applyZoom(false);
    } else if (Z.s > 1.01) {
      Z.x -= e.deltaX;
      Z.y -= e.deltaY;
      clampPan();
      applyZoom(false);
    }
  },
  { passive: false }
);
// Stops Safari from zooming the whole page instead of the photo.
for (const ev of ["gesturestart", "gesturechange"]) stage.addEventListener(ev, (e) => e.preventDefault());

document.addEventListener("keydown", (e) => {
  if ($("viewer").hidden) return;
  if (e.key === "ArrowRight" && Z.s <= 1.01) step(1);
  if (e.key === "ArrowLeft" && Z.s <= 1.01) step(-1);
  if (e.key === "+" || e.key === "=") {
    zoomAt({ x: 0, y: 0 }, Math.min(MAX_ZOOM, Z.s * 1.5));
    settle();
  }
  if (e.key === "-") {
    zoomAt({ x: 0, y: 0 }, Math.max(1, Z.s / 1.5));
    settle();
  }
  if (e.key === "Escape") Z.s > 1.01 ? resetZoom(true) : closeViewer();
});

// ---------- uploads ----------
// On a computer, + offers a folder picker (great for external drives).
$("uploadBtn").onclick = (e) => {
  e.stopPropagation();
  if (!isDesktop()) return $("fileInput").click();
  const menu = $("addMenu");
  menu.hidden = !menu.hidden;
  if (!menu.hidden) menu.querySelector("button").focus();
};
$("addMenu").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-pick]");
  if (!b) return;
  $("addMenu").hidden = true;
  $(b.dataset.pick === "folder" ? "folderInput" : "fileInput").click();
});
document.addEventListener("click", (e) => {
  if (!$("addMenu").hidden && !e.target.closest("#addMenu")) $("addMenu").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("addMenu").hidden = true;
});
for (const id of ["fileInput", "folderInput"]) {
  $(id).addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) startUpload(files);
  });
}

let dragDepth = 0;
addEventListener("dragenter", (e) => {
  if ($("app").hidden || !e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  $("dropHint").hidden = false;
});
addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("dropHint").hidden = true;
  }
});
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("dropHint").hidden = true;
  if ($("app").hidden || !e.dataTransfer || uploading) return;
  // Folders are read here, before the drop event ends; the browser forgets them after.
  showUploadModal("Looking through your files", "Finding photos…");
  const files = await filesFromDrop(e.dataTransfer, (n) => ($("upText").textContent = `Found ${n.toLocaleString()} files so far…`));
  if (files.length) startUpload(files);
  else $("uploadModal").hidden = true;
});

let uploading = null;
$("upCancel").onclick = () => {
  uploading?.abort();
  $("upEta").textContent = "";
  $("upText").textContent = "Stopping after the photos already in progress…";
};
$("upDone").onclick = () => ($("uploadModal").hidden = true);

function showUploadModal(title, text) {
  $("uploadModal").hidden = false;
  $("upTitle").textContent = title;
  $("upText").textContent = text;
  $("upEta").textContent = "";
  $("upNow").textContent = "";
  $("upSkip").textContent = "";
  $("upNote").textContent = isDesktop()
    ? "Keep this tab open and the drive connected. Your computer shouldn't go to sleep."
    : "Keep this screen open until it finishes.";
  $("upCancel").hidden = false;
  $("upDone").hidden = true;
  $("upBar").style.transform = "scaleX(0)";
}

function skippedText(s) {
  const parts = [];
  if (s.duplicates) parts.push(`${plural(s.duplicates, "photo")} already in your library`);
  if (s.videos) parts.push(plural(s.videos, "video"));
  if (s.other) parts.push(`${plural(s.other, "other file")} that ${s.other === 1 ? "isn't a photo" : "aren't photos"}`);
  if (!parts.length) return "";
  const last = parts.pop();
  return `Skipping ${parts.length ? parts.join(", ") + " and " + last : last}.`;
}

async function startUpload(files) {
  if (uploading) return toast("An upload is already running.");
  if (S.limit && S.bytes >= S.limit) {
    showUploadModal("Storage is full", `Your free ${fmtBytes(S.limit)} is used up, so nothing new can be added and you'll never be charged.`);
    $("upNote").textContent = "Delete photos you don't need to make room.";
    $("upCancel").hidden = true;
    $("upDone").hidden = false;
    return;
  }
  uploading = new AbortController();
  let wake = null;
  try {
    wake = await navigator.wakeLock?.request("screen");
  } catch {}
  showUploadModal("Adding photos", "Getting started…");
  let stats;
  try {
    stats = await uploadPhotos(files, {
      existing: new Set(S.byId.keys()),
      api,
      signal: uploading.signal,
      onProgress: (s) => {
        if (uploading?.signal.aborted) return;
        $("upText").textContent = `${s.done.toLocaleString()} of ${plural(s.total, "photo")}`;
        $("upBar").style.transform = `scaleX(${s.total ? s.done / s.total : 1})`;
        $("upEta").textContent = s.done < s.total ? fmtEta(s.etaSeconds) : "";
        $("upNow").textContent = s.current && s.done < s.total ? `Working on ${s.current}` : "";
        $("upSkip").textContent = skippedText(s);
      },
    });
  } catch (err) {
    stats = { added: 0, duplicates: 0, videos: 0, other: 0, failed: 0, failedNames: [], lastError: err.message };
  }
  wake?.release().catch(() => {});
  const stopped = uploading.signal.aborted;
  uploading = null;
  $("upTitle").textContent = stats.storageFull ? (/storage is full/i.test(stats.storageFull) ? "Storage is full" : "Upload paused") : stopped ? "Upload stopped" : "Upload finished";
  $("upText").textContent =
    !stats.added && !stats.failed && stats.duplicates
      ? "Nothing new to add. These photos are already in your library."
      : !stats.added && !stats.failed && !stats.duplicates
        ? "No photos found. Only photos are added; videos and other files are skipped."
        : `Added ${plural(stats.added, "photo")}.` + (stats.failed ? ` ${plural(stats.failed, "photo")} couldn't be added.` : "");
  $("upEta").textContent = "";
  $("upNow").textContent = "";
  $("upSkip").textContent = skippedText(stats).replace(/^Skipping/, "Skipped");
  const names = (stats.failedNames || []).slice(0, 5).join(", ");
  $("upNote").textContent = stats.storageFull
    ? stats.storageFull
    : stats.failed
    ? `${stats.lastError ? stats.lastError + " " : ""}Not added: ${names}${stats.failedNames.length > 5 ? " and more" : ""}. Run the same upload again to retry. Photos already added are skipped.`
    : stopped
      ? "Run the same upload again to pick up where it stopped. Photos already added are skipped."
      : "";
  $("upCancel").hidden = true;
  $("upDone").hidden = false;
  $("upBar").style.transform = "scaleX(1)";
  try {
    await load();
    render();
  } catch {}
}

boot();
