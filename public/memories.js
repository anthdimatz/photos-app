// Builds "memories" from photo dates, the way Apple Photos groups trips and days.
// Photos are { id, t (ms), w, h, ... }. Nothing here looks at image content.

const DAY = 86400000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NUMBERS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen"];

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const dayKey = (t) => {
  const d = new Date(t);
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
};
const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function formatRange(a, b) {
  const A = new Date(a), B = new Date(b);
  if (dayKey(a) === dayKey(b)) return `${MONTHS[A.getMonth()]} ${A.getDate()}, ${A.getFullYear()}`;
  if (A.getFullYear() !== B.getFullYear())
    return `${MONTHS[A.getMonth()].slice(0, 3)} ${A.getDate()}, ${A.getFullYear()} – ${MONTHS[B.getMonth()].slice(0, 3)} ${B.getDate()}, ${B.getFullYear()}`;
  if (A.getMonth() !== B.getMonth())
    return `${MONTHS[A.getMonth()]} ${A.getDate()} – ${MONTHS[B.getMonth()]} ${B.getDate()}, ${B.getFullYear()}`;
  return `${MONTHS[A.getMonth()]} ${A.getDate()}–${B.getDate()}, ${A.getFullYear()}`;
}

// Titles a group of photos based on how long it spans, and where it was when
// that's known ("A Weekend in Rome"), otherwise when ("A Weekend in May").
export function titleFor(photos, where = null) {
  const a = photos[0].t, b = photos[photos.length - 1].t;
  const A = new Date(a);
  const days = Math.round((startOfDay(b) - startOfDay(a)) / DAY) + 1;
  const month = MONTHS[A.getMonth()];
  const sub = formatRange(a, b);
  const place = where || month;
  if (days === 1) return { title: `A ${WEEKDAYS[A.getDay()]} in ${place}`, subtitle: sub };
  const weekdays = new Set();
  for (let t = startOfDay(a); t <= b; t += DAY) weekdays.add(new Date(t).getDay());
  if (days <= 3 && (weekdays.has(6) || weekdays.has(0))) return { title: `A Weekend in ${place}`, subtitle: sub };
  if (days <= 14) return { title: `${NUMBERS[days]} Days in ${place}`, subtitle: sub };
  if (days <= 62) return { title: where ? `${where} in ${month}` : `${month} ${A.getFullYear()}`, subtitle: sub };
  return { title: `Moments from ${A.getFullYear()}`, subtitle: sub };
}

// Drops burst shots (photos taken seconds apart), keeping favorites when possible.
function dedupeBursts(photos, favs) {
  const out = [];
  for (const p of photos) {
    const last = out[out.length - 1];
    if (last && p.t - last.t < 20000) {
      if (favs.has(p.id) && !favs.has(last.id)) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

// Picks up to `max` photos spread evenly across time, favorites first.
export function pickPhotos(photos, favs, max = 20, seed = 1) {
  const r = rng(seed);
  const sorted = [...photos].sort((a, b) => a.t - b.t);
  let pool = dedupeBursts(sorted, favs);
  if (pool.length <= max) return pool;
  const favPicks = pool.filter((p) => favs.has(p.id));
  const chosen = new Set(favPicks.slice(0, Math.floor(max / 2)).map((p) => p.id));
  const need = max - chosen.size;
  const rest = pool.filter((p) => !chosen.has(p.id));
  const step = rest.length / need;
  for (let i = 0; i < need; i++) {
    const jitter = seed === 1 ? 0.5 : r();
    const k = Math.min(rest.length - 1, Math.floor(i * step + jitter * step));
    chosen.add(rest[k].id);
  }
  return pool.filter((p) => chosen.has(p.id));
}

// Groups photos into days, then joins back-to-back busy days into trips.
function findEvents(sortedAsc) {
  const days = [];
  for (const p of sortedAsc) {
    const k = dayKey(p.t);
    const last = days[days.length - 1];
    if (last && last.key === k) last.photos.push(p);
    else days.push({ key: k, start: startOfDay(p.t), photos: [p] });
  }
  const events = [];
  let cur = null;
  for (const d of days) {
    const busy = d.photos.length >= 5;
    if (cur && busy && d.start - cur.lastStart <= DAY * 1.1 && cur.days < 14) {
      cur.photos.push(...d.photos);
      cur.lastStart = d.start;
      cur.days++;
    } else {
      if (cur) events.push(cur);
      cur = { photos: [...d.photos], lastStart: d.start, days: 1 };
    }
  }
  if (cur) events.push(cur);
  return events;
}

const coverOf = (picks, favs) => picks.find((p) => favs.has(p.id) && p.w >= p.h) || picks.find((p) => p.w >= p.h) || picks[Math.floor(picks.length / 2)];

export function buildMemories(allPhotos, favs, whereOf = () => null) {
  if (!allPhotos.length) return { onThisDay: null, events: [], years: [], favorites: null };
  const asc = [...allPhotos].sort((a, b) => a.t - b.t);

  // On this day: same date (±2 days) in earlier years.
  const now = new Date();
  const thisYear = now.getFullYear();
  const onThisDayPhotos = asc.filter((p) => {
    const d = new Date(p.t);
    if (d.getFullYear() >= thisYear) return false;
    const same = new Date(thisYear, d.getMonth(), d.getDate());
    return Math.abs(same - new Date(thisYear, now.getMonth(), now.getDate())) <= 2 * DAY;
  });
  let onThisDay = null;
  if (onThisDayPhotos.length >= 4) {
    const photos = pickPhotos(onThisDayPhotos, favs, 18);
    onThisDay = {
      key: "otd",
      title: "On This Day",
      subtitle: `${MONTHS[now.getMonth()]} ${now.getDate()} over the years`,
      photos,
      source: onThisDayPhotos,
      cover: coverOf(photos, favs),
    };
  }

  const events = findEvents(asc)
    .filter((e) => dedupeBursts(e.photos, favs).length >= 8)
    .map((e) => {
      const photos = pickPhotos(e.photos, favs, 20);
      return { key: "e" + e.photos[0].id, ...titleFor(e.photos, whereOf(e.photos)), photos, source: e.photos, cover: coverOf(photos, favs) };
    })
    .reverse();

  const byYear = new Map();
  for (const p of asc) {
    const y = new Date(p.t).getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }
  const years = [...byYear.entries()]
    .filter(([, ps]) => ps.length >= 20)
    .sort((a, b) => b[0] - a[0])
    .map(([y, ps]) => {
      const photos = pickPhotos(ps, favs, 24);
      return { key: "y" + y, title: `Looking Back at ${y}`, subtitle: `${ps.length.toLocaleString()} photos from ${y}`, photos, source: ps, cover: coverOf(photos, favs) };
    });

  const favList = asc.filter((p) => favs.has(p.id));
  const favorites =
    favList.length >= 6
      ? (() => {
          const photos = pickPhotos(favList, new Set(), 24);
          return { key: "fav", title: "Favorites", subtitle: "Your favorite photos", photos, source: favList, cover: coverOf(photos, favs) };
        })()
      : null;

  return { onThisDay, events, years, favorites };
}

// A random memory: a random event, or a random stretch of a few weeks.
export function surpriseMemory(allPhotos, favs, whereOf = () => null) {
  if (allPhotos.length < 4) return null;
  const seed = Math.floor(Math.random() * 1e9) + 2;
  const r = rng(seed);
  const asc = [...allPhotos].sort((a, b) => a.t - b.t);
  const events = findEvents(asc).filter((e) => e.photos.length >= 6);
  let source;
  if (events.length && r() < 0.6) {
    source = events[Math.floor(r() * events.length)].photos;
  } else {
    const center = asc[Math.floor(r() * asc.length)].t;
    const span = (7 + Math.floor(r() * 50)) * DAY;
    source = asc.filter((p) => Math.abs(p.t - center) <= span / 2);
    if (source.length < 6) source = asc.slice(Math.max(0, asc.length - 30));
  }
  const photos = pickPhotos(source, favs, 18, seed);
  return { key: "s" + seed, ...titleFor(photos, whereOf(photos)), photos, source, cover: coverOf(photos, favs) };
}

// A memory built from photos the person selected.
export function memoryFromSelection(photos, favs, whereOf = () => null) {
  const asc = [...photos].sort((a, b) => a.t - b.t);
  return { key: "sel", ...titleFor(asc, whereOf(asc)), photos: asc, source: asc, cover: coverOf(asc, favs) };
}
