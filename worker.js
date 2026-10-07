// Backend for the photo app, running as a Cloudflare Worker.
// The website files in /public are served by Cloudflare directly (free and
// unlimited). This Worker only handles /api/* and /img/*, and reads and writes
// your R2 bucket through the BUCKET binding, so no access keys are needed.

const NAME_RE = /^(\d{13})-([0-9a-f]{16})-(\d{1,5})x(\d{1,5})\.jpg$/;
const COOKIE = "photos_session";
const MAX_FILE = 15 * 1024 * 1024;
const enc = new TextEncoder();

// Uploads stop at this size so storage never leaves Cloudflare's free 10 GB.
const limitBytes = (env) => Math.min(9.5, Number(env.STORAGE_LIMIT_GB) || 9.5) * 1e9;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- sessions ----------
const keyCache = new Map();
async function hmacKey(env) {
  const secret = env.SESSION_SECRET || `session:${env.APP_PASSWORD}`;
  if (!keyCache.has(secret)) {
    keyCache.set(secret, await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  }
  return keyCache.get(secret);
}
const sign = async (env, msg) => hex(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(msg)));
async function makeSession(env) {
  const exp = String(Date.now() + 365 * 24 * 3600 * 1000);
  return `${exp}.${await sign(env, exp)}`;
}
async function validSession(request, env) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sameBytes(enc.encode(sig), enc.encode(await sign(env, exp)));
}
const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// ---------- storage ----------
// The file list is read one page (up to 1,000 files) per request. Reading
// everything at once is too much work for a single request on the free plan.
async function listPage(env, prefix, cursor) {
  const page = await env.BUCKET.list({ prefix, cursor: cursor || undefined, limit: 1000 });
  const names = [];
  let bytes = 0;
  for (const o of page.objects) {
    bytes += o.size;
    const n = o.key.slice(prefix.length);
    if (NAME_RE.test(n)) names.push(n);
  }
  return { names, bytes, cursor: page.truncated ? page.cursor : null };
}

// Storage used, kept in meta/usage.json. The app re-measures it every time it
// loads the library, and each approved upload adds its exact size in between.
async function readUsage(env) {
  const obj = await env.BUCKET.get("meta/usage.json");
  if (!obj) return null;
  try {
    const data = await obj.json();
    return { bytes: Number(data.bytes) || 0, etag: obj.etag };
  } catch {
    return null;
  }
}
// Adds to the counter safely even when several uploads finish at the same moment.
async function reserveUsage(env, incoming, limit) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const u = await readUsage(env);
    if (!u) return { ok: false, code: "usage_unknown" };
    if (u.bytes + incoming > limit) return { ok: false, code: "storage_full", used: u.bytes };
    const put = await env.BUCKET.put("meta/usage.json", JSON.stringify({ bytes: u.bytes + incoming, at: Date.now() }), {
      onlyIf: { etagMatches: u.etag },
      httpMetadata: { contentType: "application/json" },
    });
    if (put) return { ok: true };
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 120));
  }
  return { ok: false, code: "busy" };
}

const ID_RE = /^[0-9a-f]{16}$/;
const TRASH_DAYS = 30;
const DAY = 86400000;

async function readJson(env, key, fallback) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return fallback;
  try {
    return await obj.json();
  } catch {
    return fallback;
  }
}
const writeJson = (env, key, data) =>
  env.BUCKET.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });

async function readFavorites(env) {
  const data = await readJson(env, "meta/favorites.json", []);
  return Array.isArray(data) ? data.filter((x) => ID_RE.test(x)) : [];
}
// Recently Deleted: { "<photo name>": <time it was deleted> }
async function readTrash(env) {
  const data = await readJson(env, "meta/trash.json", {});
  const out = {};
  if (data && typeof data === "object") for (const [n, t] of Object.entries(data)) if (NAME_RE.test(n) && Number(t) > 0) out[n] = Number(t);
  return out;
}
// Albums: [{ id, name, photos: [photo ids], created }]
function cleanAlbums(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((a) => a && /^[a-z0-9]{6,32}$/.test(a.id) && !seen.has(a.id) && seen.add(a.id))
    .slice(0, 500)
    .map((a) => ({
      id: a.id,
      name: String(a.name || "Untitled Album").trim().slice(0, 80) || "Untitled Album",
      photos: [...new Set((Array.isArray(a.photos) ? a.photos : []).filter((x) => ID_RE.test(x)))].slice(0, 20000),
      created: Number(a.created) || Date.now(),
    }));
}
const readAlbums = async (env) => cleanAlbums(await readJson(env, "meta/albums.json", []));

// Deletes photos for good: both stored copies, plus their spots in Recently Deleted and albums.
async function deleteForGood(env, names) {
  for (let i = 0; i < names.length; i += 500) {
    await env.BUCKET.delete(names.slice(i, i + 500).flatMap((n) => ["full/" + n, "thumb/" + n]));
  }
  const gone = new Set(names);
  const goneIds = new Set(names.map((n) => n.match(NAME_RE)[2]));
  const [trash, albums] = await Promise.all([readTrash(env), readAlbums(env)]);
  let trashChanged = false;
  for (const n of Object.keys(trash)) if (gone.has(n)) (delete trash[n], (trashChanged = true));
  const albumsChanged = albums.some((a) => a.photos.some((id) => goneIds.has(id)));
  for (const a of albums) a.photos = a.photos.filter((id) => !goneIds.has(id));
  await Promise.all([trashChanged && writeJson(env, "meta/trash.json", trash), albumsChanged && writeJson(env, "meta/albums.json", albums)]);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ---------- /api/* ----------
async function api(request, env, url) {
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = request.method;

  if (route === "login" && method === "POST") {
    const { password = "" } = await readBody(request);
    const ok = sameBytes(await sha256(String(password)), await sha256(env.APP_PASSWORD));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 600)); // slows down guessing
      return json({ error: "That password didn't work." }, 401);
    }
    return json({ ok: true }, 200, { "set-cookie": cookieHeader(await makeSession(env), 31536000) });
  }
  if (route === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
  }

  if (!(await validSession(request, env))) return json({ error: "Sign in to continue." }, 401);

  // One page of the library. The first page also carries favorites, albums and
  // Recently Deleted. prefix=thumb pages only report their size, for storage used.
  if (route === "photos" && method === "GET") {
    const prefix = url.searchParams.get("prefix") === "thumb" ? "thumb/" : "full/";
    const cursor = url.searchParams.get("cursor");
    if (prefix === "thumb/" || cursor) {
      const page = await listPage(env, prefix, cursor);
      return json({ photos: prefix === "full/" ? page.names : [], bytes: page.bytes, cursor: page.cursor });
    }
    // First page: clear out photos that have been in Recently Deleted over 30 days
    // (a few hundred at a time, so this request stays small).
    let trash = await readTrash(env);
    const expired = Object.keys(trash).filter((n) => Date.now() - trash[n] > TRASH_DAYS * DAY).slice(0, 200);
    if (expired.length) {
      await deleteForGood(env, expired);
      trash = await readTrash(env);
    }
    const [page, favorites, albums, meta] = await Promise.all([
      listPage(env, prefix, null),
      readFavorites(env),
      readAlbums(env),
      env.BUCKET.list({ prefix: "meta/", limit: 100 }),
    ]);
    const metaBytes = meta.objects.reduce((s, o) => s + o.size, 0);
    return json({ photos: page.names, cursor: page.cursor, bytes: page.bytes + metaBytes, favorites, trash, albums, trashDays: TRASH_DAYS, limitBytes: limitBytes(env) });
  }

  // The app reports the total it just measured while loading every page.
  if (route === "usage" && method === "POST") {
    const { bytes } = await readBody(request);
    const n = Number(bytes);
    if (!(n >= 0 && n < 1e13)) return json({ error: "Invalid size." }, 400);
    await writeJson(env, "meta/usage.json", { bytes: Math.round(n), at: Date.now() });
    return json({ ok: true });
  }

  if (route === "trash" && method === "POST") {
    const { names } = await readBody(request);
    if (!Array.isArray(names) || !names.length || names.length > 20000 || !names.every((n) => NAME_RE.test(n))) {
      return json({ error: "Unknown photos." }, 400);
    }
    const trash = await readTrash(env);
    const now = Date.now();
    for (const n of names) trash[n] ||= now;
    await writeJson(env, "meta/trash.json", trash);
    return json({ ok: true, trash });
  }

  if (route === "restore" && method === "POST") {
    const { names } = await readBody(request);
    if (!Array.isArray(names) || !names.length) return json({ error: "Unknown photos." }, 400);
    const trash = await readTrash(env);
    for (const n of names) delete trash[n];
    await writeJson(env, "meta/trash.json", trash);
    return json({ ok: true, trash });
  }

  if (route === "albums" && method === "PUT") {
    const { albums } = await readBody(request);
    if (!Array.isArray(albums)) return json({ error: "Expected a list of albums." }, 400);
    const clean = cleanAlbums(albums);
    await writeJson(env, "meta/albums.json", clean);
    return json({ ok: true, albums: clean });
  }

  if (route === "uploads" && method === "POST") {
    const { items } = await readBody(request);
    if (!Array.isArray(items) || !items.length || items.length > 50) {
      return json({ error: "Send between 1 and 50 photos per request." }, 400);
    }
    const limit = limitBytes(env);
    const incoming = items.reduce((sum, it) => sum + Math.max(0, Number(it.size) || 1_500_000), 0);
    // Validate everything before reserving space.
    for (const it of items) {
      const t = Number(it.t), w = Number(it.w), h = Number(it.h);
      if (!ID_RE.test(it.id) || !(t >= 0 && t < 1e13) || !(w > 0 && w < 1e5) || !(h > 0 && h < 1e5)) {
        return json({ error: "One of the photos had invalid details." }, 400);
      }
    }
    const r = await reserveUsage(env, incoming, limit);
    if (r.code === "storage_full") {
      return json(
        {
          code: "storage_full",
          error: `Your free storage is full (${size(r.used)} of ${size(limit)} used). Uploads stopped here so you're never charged. Delete photos you don't need to make room.`,
        },
        507
      );
    }
    if (r.code === "usage_unknown") {
      return json({ code: "usage_unknown", error: "The app needs to measure your storage first. Close and reopen the app, then try the upload again." }, 409);
    }
    if (r.code === "busy") return json({ error: "The server was busy. The upload will try again." }, 503);
    const uploads = items.map((it) => {
      const name = `${String(Math.round(Number(it.t))).padStart(13, "0")}-${it.id}-${Math.round(Number(it.w))}x${Math.round(Number(it.h))}.jpg`;
      return { id: it.id, name, full: `/img/full/${name}`, thumb: `/img/thumb/${name}` };
    });
    return json({ uploads });
  }

  if (route === "favorites" && method === "PUT") {
    const { ids } = await readBody(request);
    if (!Array.isArray(ids)) return json({ error: "Expected a list of photo ids." }, 400);
    const clean = [...new Set(ids.filter((x) => /^[0-9a-f]{16}$/.test(x)))];
    await env.BUCKET.put("meta/favorites.json", JSON.stringify(clean), { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, favorites: clean });
  }

  if (route === "delete" && method === "POST") {
    const { names } = await readBody(request);
    if (!Array.isArray(names) || !names.length || names.length > 500) {
      return json({ error: "Send between 1 and 500 photos to delete." }, 400);
    }
    if (!names.every((n) => NAME_RE.test(n))) return json({ error: "Unknown photo name." }, 400);
    await deleteForGood(env, names);
    return json({ ok: true });
  }

  return json({ error: "Not found." }, 404);
}

// ---------- /img/full/<name> and /img/thumb/<name> ----------
async function image(request, env, url) {
  const m = url.pathname.match(/^\/img\/(full|thumb)\/([^/]+)$/);
  if (!m || !NAME_RE.test(m[2])) return new Response("Not found", { status: 404 });
  if (!(await validSession(request, env))) return new Response("Sign in to continue.", { status: 401 });
  const key = `${m[1]}/${m[2]}`;

  if (request.method === "GET" || request.method === "HEAD") {
    const obj = await env.BUCKET.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    // Photo addresses never change, so the browser keeps them for a year.
    return new Response(request.method === "HEAD" ? null : obj.body, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=31536000, immutable",
        etag: obj.httpEtag,
      },
    });
  }

  if (request.method === "PUT") {
    const body = await request.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX_FILE) return json({ error: "That file is too large." }, 413);
    await env.BUCKET.put(key, body, { httpMetadata: { contentType: "image/jpeg" } });
    return json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (!env.BUCKET) {
        return json({ error: "The site isn't connected to your photo storage. Check that the R2 bucket binding is named BUCKET." }, 500);
      }
      if (!env.APP_PASSWORD) {
        return json({ error: "The site needs a password. Add a secret named APP_PASSWORD in your Worker's Settings, under Variables and Secrets." }, 500);
      }
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (url.pathname.startsWith("/img/")) return await image(request, env, url);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: err.message || "Something went wrong on the server." }, 500);
    }
  },
};
