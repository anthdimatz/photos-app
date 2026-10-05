// Background music for slideshows and memory movies.
// "Gentle" and "Bright" are generated live with the Web Audio API, so there are
// no music files to host and no copyright issues when you save a video.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

const MOODS = {
  gentle: {
    bpm: 68,
    // [bass, ...chord tones]
    chords: [
      [48, 60, 64, 67, 71, 74],
      [45, 57, 60, 64, 67, 71],
      [41, 57, 60, 64, 65, 69],
      [43, 55, 59, 62, 64, 67],
    ],
    pattern: [0, 2, 4, 3, 1, 3, 4, 2],
    pluckVol: 0.16,
    padVol: 0.05,
    drums: false,
  },
  bright: {
    bpm: 104,
    chords: [
      [50, 62, 66, 69, 74],
      [45, 61, 64, 69, 73],
      [47, 62, 66, 71, 74],
      [43, 62, 67, 71, 74],
    ],
    pattern: [0, 2, 3, 2, 4, 2, 3, 1],
    pluckVol: 0.13,
    padVol: 0.035,
    drums: true,
  },
};

export class Soundtrack {
  constructor() {
    this.ctx = null;
    this.mode = "none";
    this.fileUrl = null;
    this.audioEl = null;
    this.timer = null;
  }

  // Must be called from inside a tap/click so iPhone allows sound.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
      this.recordDest = this.ctx.createMediaStreamDestination ? this.ctx.createMediaStreamDestination() : null;
      if (this.recordDest) this.master.connect(this.recordDest);
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this.impulse(2.6);
      this.wet = this.ctx.createGain();
      this.wet.gain.value = 0.32;
      this.reverb.connect(this.wet).connect(this.master);
      this.dry = this.ctx.createGain();
      this.dry.connect(this.master);
      this.dry.connect(this.reverb);
    }
    this.connectFile();
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  connectFile() {
    if (this.ctx && this.audioEl && !this.fileConnected) {
      this.ctx.createMediaElementSource(this.audioEl).connect(this.master);
      this.fileConnected = true;
    }
  }

  impulse(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  get audioTrack() {
    return this.recordDest && this.mode !== "none" ? this.recordDest.stream.getAudioTracks()[0] : null;
  }

  setFile(file) {
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = URL.createObjectURL(file);
    this.fileName = file.name.replace(/\.[^.]+$/, "");
    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.loop = true;
      this.audioEl.crossOrigin = "anonymous";
      this.audioEl.playsInline = true;
    }
    this.connectFile();
    this.audioEl.src = this.fileUrl;
  }

  setMode(mode) {
    const wasPlaying = this.playing;
    this.stop(0);
    this.mode = mode;
    if (wasPlaying) this.play();
  }

  play() {
    if (!this.ctx || this.mode === "none") return;
    this.playing = true;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(0.8, this.ctx.currentTime);
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (this.mode === "file") {
      if (this.audioEl) {
        this.audioEl.currentTime = 0;
        this.audioEl.play().catch(() => {});
      }
      return;
    }
    const mood = MOODS[this.mode];
    this.mood = mood;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.schedule(), 50);
    this.schedule();
  }

  pause() {
    if (!this.ctx) return;
    if (this.audioEl) this.audioEl.pause();
    this.ctx.suspend();
  }
  resume() {
    if (!this.ctx || !this.playing) return;
    this.ctx.resume();
    if (this.mode === "file" && this.audioEl) this.audioEl.play().catch(() => {});
  }

  fadeOut(seconds) {
    if (!this.ctx || !this.playing) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0.0001, t + seconds);
  }

  stop(fade = 0.3) {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    if (this.audioEl) this.audioEl.pause();
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(0.0001, t + Math.max(0.01, fade));
    }
  }

  schedule() {
    const { ctx, mood } = this;
    if (!mood || !this.playing) return;
    const eighth = 60 / mood.bpm / 2;
    while (this.nextTime < ctx.currentTime + 0.25) {
      const s = this.step;
      const bar = Math.floor(s / 8) % mood.chords.length;
      const chord = mood.chords[bar];
      const t = this.nextTime;
      const tones = chord.slice(1);
      if (s % 8 === 0) {
        this.pad(tones, t, eighth * 8);
        this.bass(chord[0], t, eighth * 7);
      }
      const idx = mood.pattern[s % 8] % tones.length;
      this.pluck(tones[idx] + 12, t, mood.pluckVol * (s % 2 ? 0.7 : 1));
      if (mood.drums) {
        if (s % 4 === 0) this.kick(t);
        if (s % 2 === 1) this.shaker(t);
      }
      this.nextTime += eighth;
      this.step++;
    }
  }

  env(gain, t, peak, attack, decay) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  pluck(note, t, vol) {
    const { ctx } = this;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 2600;
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = "triangle";
    o2.type = "sine";
    o1.frequency.value = midi(note);
    o2.frequency.value = midi(note + 12);
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    o1.connect(f);
    o2.connect(g2).connect(f);
    f.connect(g).connect(this.dry);
    this.env(g, t, vol, 0.006, 1.6);
    o1.start(t);
    o2.start(t);
    o1.stop(t + 1.8);
    o2.stop(t + 1.8);
  }

  pad(notes, t, dur) {
    const { ctx } = this;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900;
    f.connect(g).connect(this.dry);
    const vol = this.mood.padVol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(vol * 0.7, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0.0001, t + dur * 1.15);
    for (const n of notes.slice(0, 4)) {
      for (const detune of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = midi(n);
        o.detune.value = detune;
        o.connect(f);
        o.start(t);
        o.stop(t + dur * 1.2);
      }
    }
  }

  bass(note, t, dur) {
    const { ctx } = this;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = midi(note - 12);
    o.connect(g).connect(this.master);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  kick(t) {
    const { ctx } = this;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    o.connect(g).connect(this.master);
    this.env(g, t, 0.35, 0.004, 0.22);
    o.start(t);
    o.stop(t + 0.3);
  }

  shaker(t) {
    const { ctx } = this;
    if (!this.noise) {
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 7000;
    const g = ctx.createGain();
    src.connect(f).connect(g).connect(this.master);
    this.env(g, t, 0.05, 0.003, 0.06);
    src.start(t);
    src.stop(t + 0.1);
  }
}
