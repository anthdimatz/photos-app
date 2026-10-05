import { Player } from "./player.js";
import { buildMemories, surpriseMemory, memoryFromSelection, pickPhotos } from "./memories.js";
import { uploadPhotos, filesFromDrop } from "./upload.js";

const $ = (id) => document.getElementById(id);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-8-4.9-8-11A4.5 4.5 0 0 1 12 6.8a4.5 4.5 0 0 1 8 2.7c0 6.1-8 11-8 11z"/></svg>';
const NAME_RE = /^(\d{13})-([0-9a-f]{16})-(\d+)x(\d+)\.jpg$/;

const S = {
  photos: [],
  byId: new Map(),
  favs: new Set(),
  view: "library",
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
async function load() {
  const d = await api("photos");
  S.photos = d.photos
    .map((name) => {
      const m = name.match(NAME_RE);
      if (!m) return null;
      return { name, id: m[2], t: Number(m[1]), w: Number(m[3]), h: Number(m[4]), full: `/img/full/${name}`, thumb: `/img/thumb/${name}` };
    })
    .filter(Boolean)
    .sort((a, b) => b.t - a.t);
  S.byId = new Map(S.photos.map((p) => [p.id, p]));
  // Unsaved favorite changes win over what the server sent.
  S.favs = new Set((favDirty ? [...S.favs] : d.favorites).filter((id) => S.byId.has(id)));
  S.bytes = d.bytes || 0;
  S.limit = d.limitBytes || 9.5e9;
  S.memories = null;
  S.loadedAt = Date.now();
  S.error = null;
}

async function boot() {
  try {
    await load();
  } catch (err) {
    if (err instanceof AuthError) return;
    S.error = err.message;
  }
  $("login").hidden = true;
  $("app").hidden = false;
  render();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.loadedAt && Date.now() - S.loadedAt > 6 * 3600 * 1000) load().then(render).catch(() => {});
});

// ---------- rendering ----------
const currentList = () => (S.view === "favorites" ? S.photos.filter((p) => S.favs.has(p.id)) : S.photos);

function cellHTML(p) {
  return `<button class="cell${S.selected.has(p.id) ? " sel" : ""}" data-id="${p.id}" aria-label="${esc(fmtDay(p.t))}"><img src="${esc(p.thumb)}" alt="" loading="lazy" decoding="async" crossorigin="anonymous">${S.favs.has(p.id) ? `<span class="fav-badge">${HEART}</span>` : ""}</button>`;
}
function gridHTML(list) {
  let html = "";
  let cur = null;
  for (const p of list) {
    const d = new Date(p.t);
    const key = d.getFullYear() * 12 + d.getMonth();
    if (key !== cur) {
      if (cur !== null) html += "</div></section>";
      cur = key;
      html += `<section class="month"><h2>${MONTHS[d.getMonth()]} <span>${d.getFullYear()}</span></h2><div class="grid">`;
    }
    html += cellHTML(p);
  }
  return html ? html + "</div></section>" : "";
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

function render() {
  const { view } = S;
  for (const v of ["library", "memories", "favorites"]) $("view-" + v).hidden = v !== view;
  for (const b of document.querySelectorAll(".tabbar button")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  $("main").style.setProperty("--cols", S.cols);
  $("main").classList.toggle("selecting", S.selecting);

  const list = currentList();
  $("viewTitle").textContent = { library: "Library", memories: "Memories", favorites: "Favorites" }[view];
  $("viewSub").textContent =
    view === "memories" || !list.length
      ? ""
      : view === "library" && S.bytes
        ? `${plural(list.length, "photo")}, ${fmtBytes(S.bytes)} of ${fmtBytes(S.limit)} free storage used`
        : plural(list.length, "photo");
  $("slideshowBtn").hidden = view === "memories" || !list.length || S.selecting;
  $("selectBtn").hidden = view === "memories" || !list.length;
  $("selectBtn").textContent = S.selecting ? "Cancel" : "Select";
  $("surpriseBtn").hidden = view !== "memories" || S.photos.length < 4;
  $("uploadBtn").hidden = S.selecting;

  if (S.error) {
    $("view-" + view).innerHTML = `<div class="empty"><h2>Your photos didn't load</h2><p>${esc(S.error)}</p><button class="btn-primary" data-action="retry">Try again</button></div>`;
    return;
  }
  if (view === "memories") return renderMemories();
  const el = $("view-" + view);
  if (!list.length) {
    el.innerHTML =
      view === "library"
        ? `<div class="empty"><h2>Add your first photos</h2><p>On iPhone, tap Add photos and choose from your library. On a computer, choose a whole folder, even one on an external drive, or drag it onto this page. Videos are skipped.</p><button class="btn-primary" data-action="upload">Add photos</button></div>`
        : `<div class="empty"><h2>No favorites yet</h2><p>Open a photo and tap the heart. Favorites show up here and get priority in memories.</p></div>`;
    return;
  }
  el.innerHTML = gridHTML(list);
  updateSelbar();
}

// ---------- navigation ----------
document.querySelector(".tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  if (S.view === b.dataset.view) return scrollTo({ top: 0, behavior: "smooth" });
  S.view = b.dataset.view;
  exitSelect(false);
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
  const mem = e.target.closest(".memory");
  if (mem) return playMemory(S.memIndex.get(mem.dataset.mem));
  const act = e.target.closest("[data-action]")?.dataset.action;
  if (act === "upload") isDesktop() ? $("folderInput").click() : $("fileInput").click();
  if (act === "retry") boot();
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
  for (const b of document.querySelectorAll(".selbar-actions button")) b.disabled = !n;
  const allFav = n && [...S.selected].every((id) => S.favs.has(id));
  document.querySelector('[data-act="favorite"]').textContent = allFav ? "Unfavorite" : "Favorite";
}
const selectedPhotos = () => [...S.selected].map((id) => S.byId.get(id)).filter(Boolean).sort((a, b) => a.t - b.t);

document.querySelector(".selbar-actions").addEventListener("click", async (e) => {
  const act = e.target.closest("button")?.dataset.act;
  const photos = selectedPhotos();
  if (!act || !photos.length) return;
  if (act === "slideshow") player.open({ photos, kind: "slideshow", loop: true });
  if (act === "movie") {
    const m = memoryFromSelection(photos, S.favs);
    player.open({ photos: m.photos, title: m.title, subtitle: m.subtitle, kind: "memory" });
  }
  if (act === "favorite") {
    const allFav = photos.every((p) => S.favs.has(p.id));
    photos.forEach((p) => (allFav ? S.favs.delete(p.id) : S.favs.add(p.id)));
    saveFavs();
    exitSelect();
  }
  if (act === "delete") {
    if (!confirm(`Delete ${plural(photos.length, "photo")}? This can't be undone.`)) return;
    await deletePhotos(photos);
    exitSelect();
  }
});

// ---------- favorites & delete ----------
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

async function deletePhotos(photos) {
  try {
    for (let i = 0; i < photos.length; i += 200) {
      await api("delete", { method: "POST", body: { names: photos.slice(i, i + 200).map((p) => p.name) } });
    }
    const gone = new Set(photos.map((p) => p.id));
    S.photos = S.photos.filter((p) => !gone.has(p.id));
    gone.forEach((id) => {
      S.byId.delete(id);
      if (S.favs.delete(id)) saveFavs();
    });
    S.memories = null;
    toast(`Deleted ${plural(photos.length, "photo")}.`);
    render();
    return true;
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message);
    return false;
  }
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
const V = { list: [], i: 0 };
const vImg = $("vImg");
vImg.crossOrigin = "anonymous";

function openViewer(list, i) {
  if (i < 0) return;
  V.list = list;
  V.i = i;
  $("viewer").hidden = false;
  $("viewer").classList.remove("chrome-off");
  document.body.classList.add("no-scroll");
  showPhoto();
}
function closeViewer() {
  $("viewer").hidden = true;
  document.body.classList.remove("no-scroll");
  vImg.removeAttribute("src");
}
function showPhoto() {
  const p = V.list[V.i];
  if (!p) return closeViewer();
  vImg.style.transform = "";
  vImg.src = p.thumb;
  const full = new Image();
  full.crossOrigin = "anonymous";
  full.onload = () => {
    if (V.list[V.i] === p) vImg.src = p.full;
  };
  full.src = p.full;
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
  showPhoto();
  render();
};
$("vPlay").onclick = () => {
  const photos = [...V.list.slice(V.i), ...V.list.slice(0, V.i)];
  closeViewer();
  player.open({ photos, kind: "slideshow", loop: true });
};
$("vDelete").onclick = async () => {
  const p = V.list[V.i];
  if (!confirm("Delete this photo? This can't be undone.")) return;
  if (await deletePhotos([p])) {
    V.list = V.list.filter((x) => x.id !== p.id);
    if (V.i >= V.list.length) V.i = V.list.length - 1;
    V.list.length ? showPhoto() : closeViewer();
  }
};
document.addEventListener("keydown", (e) => {
  if ($("viewer").hidden) return;
  if (e.key === "ArrowRight") step(1);
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "Escape") closeViewer();
});

// Swipe left/right to move, swipe down to close, tap to hide controls.
const drag = { on: false };
$("vStage").addEventListener("pointerdown", (e) => {
  Object.assign(drag, { on: true, x: e.clientX, y: e.clientY, t: Date.now(), dx: 0, dy: 0 });
  vImg.classList.add("dragging");
});
$("vStage").addEventListener("pointermove", (e) => {
  if (!drag.on) return;
  drag.dx = e.clientX - drag.x;
  drag.dy = e.clientY - drag.y;
  if (Math.abs(drag.dx) > Math.abs(drag.dy)) vImg.style.transform = `translateX(${drag.dx}px)`;
  else if (drag.dy > 0) vImg.style.transform = `translateY(${drag.dy}px) scale(${Math.max(0.7, 1 - drag.dy / 1200)})`;
});
const endDrag = () => {
  if (!drag.on) return;
  drag.on = false;
  vImg.classList.remove("dragging");
  const { dx, dy } = drag;
  if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) return step(dx < 0 ? 1 : -1);
  if (dy > 110 && dy > Math.abs(dx)) return closeViewer();
  vImg.style.transform = "";
  if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - drag.t < 350) $("viewer").classList.toggle("chrome-off");
};
$("vStage").addEventListener("pointerup", endDrag);
$("vStage").addEventListener("pointercancel", endDrag);

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
      existing: new Set(S.photos.map((p) => p.id)),
      api,
      signal: uploading.signal,
      onProgress: (s) => {
        if (uploading?.signal.aborted) return;
        $("upText").textContent = `${s.done.toLocaleString()} of ${plural(s.total, "photo")}`;
        $("upBar").style.transform = `scaleX(${s.total ? s.done / s.total : 1})`;
        $("upEta").textContent = s.done < s.total ? fmtEta(s.etaSeconds) : "";
        $("upSkip").textContent = skippedText(s);
      },
    });
  } catch (err) {
    stats = { added: 0, duplicates: 0, videos: 0, other: 0, failed: 0, failedNames: [], lastError: err.message };
  }
  wake?.release().catch(() => {});
  const stopped = uploading.signal.aborted;
  uploading = null;
  $("upTitle").textContent = stats.storageFull ? "Storage is full" : stopped ? "Upload stopped" : "Upload finished";
  $("upText").textContent =
    !stats.added && !stats.failed && stats.duplicates
      ? "Nothing new to add. These photos are already in your library."
      : !stats.added && !stats.failed && !stats.duplicates
        ? "No photos found. Only photos are added; videos and other files are skipped."
        : `Added ${plural(stats.added, "photo")}.` + (stats.failed ? ` ${plural(stats.failed, "photo")} couldn't be added.` : "");
  $("upEta").textContent = "";
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
