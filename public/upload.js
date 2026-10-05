// Prepares photos in the browser and uploads them straight to storage.
// Each photo is stored twice: a 2048px version for viewing and movies, and a
// small thumbnail for the grid. Originals stay on your phone, drive or iCloud.

// 2048px is sharper than an iPhone screen or a 1080p TV, and keeps each photo
// around 0.5–0.9 MB so 10,000+ photos fit in Cloudflare's free 10 GB.
const FULL_SIZE = 2048; // longest edge
const THUMB_SIZE = 420; // shortest edge
const EXIFR_URL = "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs";
// Only downloaded if the browser can't open HEIC itself (Chrome/Edge on Windows).
const HEIC_URL = "https://cdn.jsdelivr.net/npm/heic-to@1.6.5/dist/heic-to.js";

const PHOTO_EXT = /\.(jpe?g|jpe|png|heic|heif|webp|avif|gif)$/i;
const VIDEO_EXT = /\.(mov|mp4|m4v|avi|mkv|3gp|3g2|mts|m2ts|wmv|webm|mpe?g|flv|insv|lrv)$/i;
const PHOTO_TYPES = /^image\/(jpeg|png|heic|heif|webp|avif|gif)$/i;
const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type);
// Hidden files and system clutter that external drives collect (._IMG_1234.JPG, Thumbs.db).
const isSystemFile = (name) => name.startsWith(".") || /^(thumbs\.db|desktop\.ini|icon\r?)$/i.test(name);

// Splits a pile of files into photos to upload and things to skip.
export function sortFiles(files) {
  const photos = [];
  let videos = 0, other = 0;
  for (const f of files) {
    if (isSystemFile(f.name)) continue;
    if (PHOTO_EXT.test(f.name) || PHOTO_TYPES.test(f.type)) photos.push(f);
    else if (VIDEO_EXT.test(f.name) || f.type.startsWith("video/")) videos++;
    else other++;
  }
  return { photos, videos, other };
}

// Reads everything inside dropped folders, including subfolders.
export async function filesFromDrop(dataTransfer, onCount) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dataTransfer.files || [])];
  const out = [];
  const readAll = (dir) =>
    new Promise((resolve) => {
      const reader = dir.createReader();
      const all = [];
      const next = () =>
        reader.readEntries(
          (batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)),
          () => resolve(all)
        );
      next();
    });
  const walk = async (entry) => {
    if (entry.isFile) {
      if (isSystemFile(entry.name)) return;
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (file) {
        out.push(file);
        if (out.length % 200 === 0) onCount?.(out.length);
      }
    } else if (entry.isDirectory && !isSystemFile(entry.name)) {
      for (const child of await readAll(entry)) await walk(child);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

let exifrMod = null;
async function readMeta(file) {
  try {
    exifrMod ||= await import(EXIFR_URL);
    const exifr = exifrMod.default || exifrMod;
    const tags = await exifr.parse(file, {
      pick: ["DateTimeOriginal", "SubSecTimeOriginal", "CreateDate", "Make", "Model"],
      reviveValues: false,
    });
    return tags || {};
  } catch {
    return {};
  }
}
function parseExifDate(s) {
  const m = typeof s === "string" && s.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d) || d.getFullYear() < 1900 ? null : d.getTime();
}
const hex16 = (buf) => [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
const clean = (s) => String(s ?? "").replace(/\0/g, "").trim();

// A photo's id. When the camera recorded the exact capture moment (iPhones always
// do), the id comes from that moment and the camera model, so the same photo gets
// the same id whether it arrives as a HEIC from a drive or a JPEG from the iPhone.
async function identify(file) {
  const tags = await readMeta(file);
  const raw = clean(tags.DateTimeOriginal || tags.CreateDate);
  const exifTime = parseExifDate(raw);
  const sub = clean(tags.SubSecTimeOriginal);
  const t = exifTime != null ? exifTime + (Number(`0.${sub}`) * 1000 || 0) : file.lastModified || Date.now();
  let source;
  if (exifTime != null && sub) {
    source = new TextEncoder().encode(`v1|${raw}|${sub}|${clean(tags.Make)}|${clean(tags.Model)}`);
  } else {
    source = await file.arrayBuffer();
  }
  const id = hex16(await crypto.subtle.digest("SHA-256", source));
  return { id, t: Math.round(t) };
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable"));
    };
    img.src = url;
  });
}
let heicMod = null;
async function decode(file) {
  try {
    return await loadImage(file);
  } catch (err) {
    if (!isHeic(file)) throw err;
  }
  heicMod ||= await import(HEIC_URL);
  const bmp = await heicMod.heicTo({ blob: file, type: "bitmap" });
  return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close?.() };
}

function toJpeg(source, w, h, quality) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve({ blob: b, canvas: c }) : reject(new Error("encode"))), "image/jpeg", quality)
  );
}

async function render(item) {
  const img = await decode(item.file);
  try {
    const s = Math.min(1, FULL_SIZE / Math.max(img.w, img.h));
    const w = Math.round(img.w * s), h = Math.round(img.h * s);
    const full = await toJpeg(img.src, w, h, 0.82);
    const ts = THUMB_SIZE / Math.min(w, h);
    const thumb = await toJpeg(full.canvas, Math.max(1, Math.round(w * ts)), Math.max(1, Math.round(h * ts)), 0.78);
    full.canvas.width = full.canvas.height = 0; // frees memory on iPhone
    thumb.canvas.width = thumb.canvas.height = 0;
    return { ...item, w, h, full: full.blob, thumb: thumb.blob };
  } finally {
    img.done();
  }
}

async function put(url, blob) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body: blob, headers: { "content-type": "image/jpeg" } });
      if (res.ok) return;
      if (res.status === 401) throw new Error("Your sign-in expired. Sign in again, then run the same upload to add the rest.");
      if (res.status === 413) throw new Error("A photo was too large to upload.");
    } catch (err) {
      if (attempt === 3 || /sign-in|too large/.test(err.message)) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw new Error("Upload failed after 4 tries.");
}

// files: File[]; existing: Set of ids already in the library.
// onProgress({ done, total, added, duplicates, videos, other, failed, etaSeconds })
export async function uploadPhotos(files, { existing, api, onProgress, signal }) {
  const { photos, videos, other } = sortFiles(files);
  const stats = { done: 0, total: photos.length, added: 0, duplicates: 0, videos, other, failed: 0, failedNames: [], etaSeconds: null };
  const report = () => onProgress({ ...stats });
  report();
  const seen = new Set(existing);
  const desktop = matchMedia("(pointer: fine)").matches;
  const workers = desktop ? Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1)) : 2;
  const batchSize = desktop ? 10 : 6;
  const started = performance.now();
  let uploadedWork = 0; // photos that needed real work (not duplicates), for the time estimate
  let queue = [];
  let next = 0;
  let halted = false; // storage is full: stop everything

  const tick = (didWork) => {
    stats.done++;
    if (didWork) uploadedWork++;
    const elapsed = (performance.now() - started) / 1000;
    if (uploadedWork >= 8 && elapsed > 10) {
      const perPhoto = elapsed / Math.max(1, uploadedWork + stats.duplicates * 0.05);
      stats.etaSeconds = Math.round(perPhoto * (stats.total - stats.done));
    }
    report();
  };

  const flush = async () => {
    const batch = queue;
    queue = [];
    if (!batch.length) return;
    let uploads;
    try {
      ({ uploads } = await api("uploads", {
        method: "POST",
        body: { items: batch.map(({ id, t, w, h, full, thumb }) => ({ id, t, w, h, size: full.size + thumb.size })) },
      }));
    } catch (err) {
      if (err.code === "storage_full") {
        halted = true;
        stats.storageFull = err.message;
        return;
      }
      for (const item of batch) {
        stats.failed++;
        stats.failedNames.push(item.file.name);
        seen.delete(item.id);
        tick(true);
      }
      stats.lastError = err.message;
      return;
    }
    await Promise.all(
      uploads.map(async (u) => {
        const item = batch.find((b) => b.id === u.id);
        try {
          await put(u.thumb, item.thumb);
          await put(u.full, item.full);
          stats.added++;
        } catch (err) {
          stats.failed++;
          stats.failedNames.push(item.file.name);
          stats.lastError = err.message;
          seen.delete(item.id);
        }
        tick(true);
      })
    );
  };

  const worker = async () => {
    while (next < photos.length) {
      if (signal?.aborted || halted) return;
      const file = photos[next++];
      try {
        const item = { file, ...(await identify(file)) };
        if (seen.has(item.id)) {
          stats.duplicates++;
          tick(false);
          continue;
        }
        seen.add(item.id);
        // Resize first, then push: `queue` is swapped out whenever a batch is sent.
        const ready = await render(item);
        queue.push(ready);
        if (queue.length >= batchSize) await flush();
      } catch (err) {
        stats.failed++;
        stats.failedNames.push(file.name);
        if (err?.message && err.message !== "unreadable") stats.lastError = err.message;
        tick(true);
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  if (!halted) await flush();
  stats.etaSeconds = 0;
  report();
  return stats;
}
