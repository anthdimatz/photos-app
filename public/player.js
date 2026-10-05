// Plays slideshows and memory movies on a canvas, and records them to video.
import { rng } from "./memories.js";
import { Soundtrack } from "./music.js";

const T = 1.0; // crossfade length in seconds
const PACE = { relaxed: 5, normal: 3.4, quick: 2.2 };
const MAX_VIDEO_SECONDS = 600;
const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const $ = (id) => document.getElementById(id);

export class Player {
  constructor({ toast }) {
    this.toast = toast;
    this.el = $("player");
    this.canvas = $("pCanvas");
    this.ctx = this.canvas.getContext("2d");
    this.buf = document.createElement("canvas");
    this.bctx = this.buf.getContext("2d");
    this.music = new Soundtrack();
    this.cache = new Map();
    this.opts = { music: "gentle", shape: matchMedia("(max-aspect-ratio: 1/1)").matches ? "tall" : "wide", pace: "normal" };
    this.bind();
  }

  bind() {
    $("pClose").onclick = () => this.close();
    $("pPlay").onclick = (e) => {
      e.stopPropagation();
      this.togglePlay();
    };
    $("pOptions").onclick = (e) => {
      e.stopPropagation();
      this.openSheet();
    };
    $("pSave").onclick = (e) => {
      e.stopPropagation();
      this.record();
    };
    $("pStage").addEventListener("click", () => this.poke(true));
    this.el.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" && !this.el.classList.contains("show-ui")) this.poke();
    });
    $("pProgress").addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.recording) return;
      const r = e.currentTarget.getBoundingClientRect();
      this.t = clamp((e.clientX - r.left) / r.width) * this.total;
      this.poke();
    });
    $("pSheetDone").onclick = () => this.closeSheet();
    $("pSheet").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-opt]");
      if (!b) return;
      const { opt, val } = b.dataset;
      if (opt === "music" && val === "file") {
        this.music.unlock();
        $("pMusicFile").click();
        return;
      }
      this.setOption(opt, val);
    });
    $("pMusicFile").addEventListener("change", (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      this.music.setFile(f);
      this.setOption("music", "file");
    });
    $("pShuffle").onclick = () => {
      if (!this.reshuffle) return;
      const photos = this.reshuffle();
      if (photos && photos.length) {
        this.photos = photos;
        this.build(0);
        this.t = 0;
        if (this.playing) this.music.play();
      }
      this.closeSheet();
    };
    $("pRecCancel").onclick = () => this.stopRecording(true);
    $("pDoneClose").onclick = () => {
      $("pDone").hidden = true;
    };
    $("pDoneSave").onclick = () => this.saveVideo();
    document.addEventListener("keydown", (e) => {
      if (this.el.hidden) return;
      if (e.key === "Escape") this.close();
      if (e.key === " ") {
        e.preventDefault();
        this.togglePlay();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.playing && !this.recording) this.pause();
    });
  }

  // ---------- public ----------
  open({ photos, title = "", subtitle = "", loop = false, kind = "memory", reshuffle = null }) {
    if (!photos.length) return;
    this.music.unlock(); // inside the tap, so iPhone allows sound
    this.photos = photos;
    this.title = title;
    this.subtitle = subtitle;
    this.loop = loop;
    this.kind = kind;
    this.reshuffle = reshuffle;
    this.seed = Math.floor(Math.random() * 1e9);
    this.opts.pace = kind === "slideshow" ? "relaxed" : "normal";
    this.el.hidden = false;
    document.body.classList.add("no-scroll");
    $("pShuffle").hidden = !reshuffle;
    $("pTitle").textContent = title || "Slideshow";
    this.syncSheet();
    this.build(0);
    this.t = 0;
    this.last = performance.now();
    this.running = true;
    document.fonts?.load('400 80px "Instrument Serif"').catch(() => {});
    this.music.mode = this.opts.music;
    this.play();
    requestAnimationFrame((n) => this.frame(n));
  }

  close() {
    if (this.recording) this.stopRecording(true);
    this.running = false;
    this.playing = false;
    this.music.stop(0.2);
    this.releaseWake();
    this.cache.clear();
    this.el.hidden = true;
    $("pDone").hidden = true;
    this.closeSheet();
    document.body.classList.remove("no-scroll");
  }

  // ---------- timeline ----------
  build(keepIndex) {
    const wide = this.opts.shape === "wide";
    this.W = wide ? 1920 : 1080;
    this.H = wide ? 1080 : 1920;
    this.canvas.width = this.buf.width = this.W;
    this.canvas.height = this.buf.height = this.H;
    this.el.dataset.shape = this.opts.shape;
    const per = PACE[this.opts.pace];
    const mismatched = (p) => (wide ? p.h > p.w * 1.05 : p.w > p.h * 1.05);
    const slides = [];
    const ps = this.photos;
    for (let i = 0; i < ps.length; i++) {
      if (mismatched(ps[i]) && i + 1 < ps.length && mismatched(ps[i + 1])) {
        slides.push({ photos: [ps[i], ps[i + 1]] });
        i++;
      } else slides.push({ photos: [ps[i]] });
    }
    let at = 0;
    slides.forEach((s, k) => {
      const r = rng(this.seed + k * 7919);
      s.kb = s.photos.map(() => {
        const zoomIn = r() < 0.6;
        const big = 1.12 + r() * 0.1;
        return {
          z0: zoomIn ? 1.0 : big,
          z1: zoomIn ? big : 1.02,
          x0: 0.2 + r() * 0.6,
          x1: 0.2 + r() * 0.6,
          y0: 0.2 + r() * 0.4,
          y1: 0.2 + r() * 0.4,
        };
      });
      s.start = at;
      s.dur = per * (s.photos.length > 1 ? 1.25 : 1) + (k === 0 && this.title ? 1.8 : 0);
      at += s.dur;
    });
    this.slides = slides;
    this.total = at + T + 0.6;
    if (keepIndex && slides[keepIndex]) this.t = slides[keepIndex].start;
  }

  slideAt(t) {
    const s = this.slides;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // ---------- image loading ----------
  load(photo) {
    if (this.cache.has(photo.id)) return this.cache.get(photo.id);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    const entry = { img, ok: null };
    img.onload = () => {
      entry.ok = true;
      entry.blur = this.makeBlur(img);
    };
    img.onerror = () => {
      entry.ok = false;
    };
    img.src = photo.full;
    this.cache.set(photo.id, entry);
    return entry;
  }
  ensure(i) {
    const keep = new Set();
    for (let k = Math.max(0, i - 1); k < Math.min(this.slides.length, i + 5); k++) {
      for (const p of this.slides[k].photos) {
        this.load(p);
        keep.add(p.id);
      }
    }
    if (this.cache.size > 40) {
      for (const id of this.cache.keys()) if (!keep.has(id)) this.cache.delete(id);
    }
  }
  slideReady(k) {
    const s = this.slides[k];
    return !s || s.photos.every((p) => {
      const e = this.cache.get(p.id);
      return e && e.ok !== null;
    });
  }
  ready(t) {
    const i = this.slideAt(t);
    return this.slideReady(i) && this.slideReady(this.slideAt(t + T + 0.2));
  }
  preloadAll() {
    this.slides.forEach((s) => s.photos.forEach((p) => this.load(p)));
    return new Promise((resolve) => {
      const check = () => (this.slides.every((_, k) => this.slideReady(k)) ? resolve() : setTimeout(check, 100));
      check();
    });
  }
  makeBlur(img) {
    const small = document.createElement("canvas");
    small.width = 24;
    small.height = Math.max(1, Math.round((24 * img.naturalHeight) / img.naturalWidth));
    small.getContext("2d").drawImage(img, 0, 0, small.width, small.height);
    const mid = document.createElement("canvas");
    mid.width = 96;
    mid.height = Math.max(1, small.height * 4);
    const m = mid.getContext("2d");
    m.imageSmoothingQuality = "high";
    m.drawImage(small, 0, 0, mid.width, mid.height);
    return mid;
  }

  // ---------- drawing ----------
  draw(t) {
    const { ctx, W, H } = this;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (!this.slides.length) return;
    const i = this.slideAt(t);
    const local = t - this.slides[i].start;
    let alpha = 1;
    if (i > 0 && local < T) {
      this.drawSlide(ctx, i - 1, t);
      alpha = ease(clamp(local / T));
    } else if (i === 0) alpha = clamp(t / 0.8);
    if (alpha >= 1) this.drawSlide(ctx, i, t);
    else {
      this.bctx.fillStyle = "#000";
      this.bctx.fillRect(0, 0, W, H);
      this.drawSlide(this.bctx, i, t);
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.buf, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (this.title) this.drawTitle(t);
    const fade = clamp((t - (this.total - 1.6)) / 1.4);
    if (fade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${fade})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  drawSlide(c, k, t) {
    const s = this.slides[k];
    const p = clamp((t - s.start) / (s.dur + T));
    const { W, H } = this;
    if (s.photos.length === 1) return this.drawPhoto(c, s.photos[0], s.kb[0], 0, 0, W, H, p, true);
    const gap = 10;
    if (W > H) {
      const w = (W - gap) / 2;
      this.drawPhoto(c, s.photos[0], s.kb[0], 0, 0, w, H, p, false);
      this.drawPhoto(c, s.photos[1], s.kb[1], w + gap, 0, w, H, p, false);
    } else {
      const h = (H - gap) / 2;
      this.drawPhoto(c, s.photos[0], s.kb[0], 0, 0, W, h, p, false);
      this.drawPhoto(c, s.photos[1], s.kb[1], 0, h + gap, W, h, p, false);
    }
  }

  drawPhoto(c, photo, kb, x, y, w, h, p, allowFit) {
    const e = this.cache.get(photo.id);
    if (!e || !e.ok) return;
    const img = e.img;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const ep = ease(p);
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.imageSmoothingQuality = "high";
    const ratio = iw / ih / (w / h);
    if (allowFit && (ratio < 0.72 || ratio > 1.5)) {
      // Photo shape doesn't match the screen: blurred backdrop, whole photo on top.
      if (e.blur) {
        const bs = Math.max(w / e.blur.width, h / e.blur.height) * 1.15;
        c.drawImage(e.blur, x + (w - e.blur.width * bs) / 2, y + (h - e.blur.height * bs) / 2, e.blur.width * bs, e.blur.height * bs);
        c.fillStyle = "rgba(0,0,0,0.28)";
        c.fillRect(x, y, w, h);
      }
      const s = Math.min(w / iw, h / ih) * 0.92 * (1 + 0.05 * ep);
      const dw = iw * s, dh = ih * s;
      c.shadowColor = "rgba(0,0,0,0.45)";
      c.shadowBlur = 40;
      c.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      const base = Math.max(w / iw, h / ih);
      const z = kb.z0 + (kb.z1 - kb.z0) * ep;
      const dw = iw * base * z, dh = ih * base * z;
      const fx = kb.x0 + (kb.x1 - kb.x0) * ep;
      const fy = kb.y0 + (kb.y1 - kb.y0) * ep;
      c.drawImage(img, x - (dw - w) * fx, y - (dh - h) * fy, dw, dh);
    }
    c.restore();
  }

  drawTitle(t) {
    const { ctx, W, H } = this;
    const end = this.slides[1] ? this.slides[1].start : this.total - 1.5;
    const a = clamp((t - 0.7) / 0.9) * (1 - clamp((t - (end - 1.1)) / 0.8));
    if (a <= 0) return;
    const tall = H > W;
    ctx.save();
    ctx.globalAlpha = a;
    const g = ctx.createLinearGradient(0, H * 0.4, 0, H);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.62)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    let size = tall ? W * 0.135 : H * 0.115;
    const font = (s) => `400 ${s}px "Instrument Serif", Georgia, "Times New Roman", serif`;
    ctx.font = font(size);
    while (ctx.measureText(this.title).width > W * 0.86 && size > 20) {
      size *= 0.92;
      ctx.font = font(size);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 30;
    const y = H * (tall ? 0.76 : 0.74) + 12 * (1 - ease(clamp((t - 0.7) / 1.2)));
    ctx.fillText(this.title, W / 2, y);
    if (this.subtitle) {
      ctx.font = `500 ${Math.round(size * 0.24)}px -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.86)";
      ctx.fillText(this.subtitle, W / 2, y + size * 0.6);
    }
    ctx.restore();
  }

  // ---------- playback ----------
  frame(now) {
    if (!this.running) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.playing && this.slides.length) {
      this.ensure(this.slideAt(this.t));
      const waiting = !this.ready(this.t);
      this.el.classList.toggle("loading", waiting);
      if (!waiting) this.t += dt;
      if (!this.fading && this.t > this.total - 1.8 && !this.loop) {
        this.fading = true;
        this.music.fadeOut(1.6);
      }
      if (this.t >= this.total) {
        if (this.recording) {
          this.t = this.total;
          this.stopRecording(false);
        } else if (this.loop) {
          this.t = 0;
        } else {
          this.t = this.total;
          this.pause(true);
        }
      }
    }
    this.draw(this.t);
    $("pBar").style.transform = `scaleX(${this.total ? this.t / this.total : 0})`;
    if (this.recording) $("pRecBar").style.transform = `scaleX(${this.t / this.total})`;
    requestAnimationFrame((n) => this.frame(n));
  }

  play() {
    if (this.t >= this.total) this.t = 0;
    const fromStart = this.t < 0.05 || !this.music.playing;
    this.playing = true;
    this.fading = false;
    this.el.classList.remove("paused");
    if (fromStart) this.music.play();
    else this.music.resume();
    this.requestWake();
    this.poke();
  }
  pause(ended = false) {
    this.playing = false;
    this.el.classList.add("paused");
    if (ended) this.music.stop(0.3);
    else this.music.pause();
    this.releaseWake();
    this.poke();
  }
  togglePlay() {
    if (this.recording) return;
    this.music.unlock();
    this.playing ? this.pause() : this.play();
  }
  // Shows the controls, then hides them again while playing.
  poke(toggle = false) {
    const showing = this.el.classList.contains("show-ui");
    if (toggle && showing && this.playing) {
      this.el.classList.remove("show-ui");
      return;
    }
    this.el.classList.add("show-ui");
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.playing && $("pSheet").hidden) this.el.classList.remove("show-ui");
    }, 2800);
  }

  // ---------- options ----------
  openSheet() {
    this.syncSheet();
    $("pSheet").hidden = false;
    this.el.classList.add("show-ui");
  }
  closeSheet() {
    $("pSheet").hidden = true;
    this.poke();
  }
  syncSheet() {
    for (const b of document.querySelectorAll("#pSheet button[data-opt]")) {
      b.setAttribute("aria-pressed", String(this.opts[b.dataset.opt] === b.dataset.val));
    }
    const fileBtn = document.querySelector('#pSheet button[data-val="file"]');
    fileBtn.textContent = this.music.fileName ? `Song: ${this.music.fileName}` : "Your song…";
  }
  setOption(opt, val) {
    this.opts[opt] = val;
    if (opt === "music") {
      this.music.setMode(val);
      if (this.playing) this.music.play();
    } else {
      const i = this.slideAt(this.t);
      this.build(i);
    }
    this.syncSheet();
  }

  // ---------- recording ----------
  pickMime() {
    if (!window.MediaRecorder) return null;
    const list = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return list.find((m) => MediaRecorder.isTypeSupported(m)) || null;
  }
  async record() {
    if (this.recording) return;
    const mime = this.pickMime();
    if (!mime || !this.canvas.captureStream) {
      this.toast("This browser can't save videos. Try Safari on iPhone or Chrome on a computer.");
      return;
    }
    if (this.total > MAX_VIDEO_SECONDS) {
      this.toast("Videos are limited to 10 minutes. Select fewer photos, or choose a quicker pace.");
      return;
    }
    this.music.unlock();
    this.closeSheet();
    this.pause();
    this.recording = true;
    this.el.classList.add("recording");
    $("pRec").hidden = false;
    $("pRecText").textContent = "Getting photos ready…";
    $("pRecBar").style.transform = "scaleX(0)";
    await this.preloadAll();
    if (!this.recording) return;
    await document.fonts?.ready;
    $("pRecText").textContent = "Recording your video. Keep this screen open.";
    const stream = this.canvas.captureStream(30);
    const track = this.music.audioTrack;
    if (track) stream.addTrack(track);
    this.chunks = [];
    this.mime = mime;
    try {
      this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    } catch {
      this.rec = new MediaRecorder(stream);
    }
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => this.onRecorded();
    this.t = 0;
    this.savedLoop = this.loop;
    this.loop = false;
    this.rec.start(1000);
    this.play();
  }
  stopRecording(cancel) {
    this.cancelled = cancel;
    this.recording = false;
    this.el.classList.remove("recording");
    $("pRec").hidden = true;
    this.loop = this.savedLoop ?? this.loop;
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    else if (cancel) this.pause();
    this.pause(true);
  }
  onRecorded() {
    const type = (this.rec.mimeType || this.mime).split(";")[0];
    const blob = new Blob(this.chunks, { type });
    this.rec = null;
    if (this.cancelled || !blob.size) return;
    const ext = type.includes("mp4") ? "mp4" : "webm";
    const name = (this.title || "Slideshow").replace(/[^\w\- ]+/g, "").trim() || "Memory";
    this.videoFile = new File([blob], `${name}.${ext}`, { type });
    const mb = (blob.size / 1048576).toFixed(1);
    $("pDoneText").textContent = `${this.videoFile.name}, ${mb} MB`;
    $("pDone").hidden = false;
  }
  async saveVideo() {
    const f = this.videoFile;
    if (!f) return;
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try {
        await navigator.share({ files: [f], title: f.name });
        $("pDone").hidden = true;
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    $("pDone").hidden = true;
  }

  async requestWake() {
    try {
      if ("wakeLock" in navigator && !this.wake) this.wake = await navigator.wakeLock.request("screen");
    } catch {}
  }
  releaseWake() {
    this.wake?.release().catch(() => {});
    this.wake = null;
  }
}
