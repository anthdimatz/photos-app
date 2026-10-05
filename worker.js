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
async function listPrefix(env, prefix) {
  const names = [];
  let bytes = 0;
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) {
      bytes += o.size;
      const n = o.key.slice(prefix.length);
      if (NAME_RE.test(n)) names.push(n);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { names, bytes };
}

// Total storage used, cached briefly and topped up as uploads are approved.
let usage = null;
async function getUsage(env, fresh) {
  if (fresh || !usage || Date.now() - usage.at > 5 * 60 * 1000) {
    const [full, thumb] = await Promise.all([listPrefix(env, "full/"), listPrefix(env, "thumb/")]);
    usage = { bytes: full.bytes + thumb.bytes, names: full.names, at: Date.now() };
  }
  return usage;
}

async function readFavorites(env) {
  const obj = await env.BUCKET.get("meta/favorites.json");
  if (!obj) return [];
  try {
    const data = await obj.json();
    return Array.isArray(data) ? data.filter((x) => /^[0-9a-f]{16}$/.test(x)) : [];
  } catch {
    return [];
  }
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

  if (route === "photos" && method === "GET") {
    const [{ names, bytes }, favorites] = await Promise.all([getUsage(env, true), readFavorites(env)]);
    return json({ photos: names, favorites, bytes, limitBytes: limitBytes(env) });
  }

  if (route === "uploads" && method === "POST") {
    const { items } = await readBody(request);
    if (!Array.isArray(items) || !items.length || items.length > 50) {
      return json({ error: "Send between 1 and 50 photos per request." }, 400);
    }
    const limit = limitBytes(env);
    const incoming = items.reduce((sum, it) => sum + Math.max(0, Number(it.size) || 1_500_000), 0);
    const u = await getUsage(env, false);
    if (u.bytes + incoming > limit) {
      return json(
        {
          code: "storage_full",
          error: `Your free storage is full (${size(u.bytes)} of ${size(limit)} used). Uploads stopped here so you're never charged. Delete photos you don't need to make room.`,
        },
        507
      );
    }
    const uploads = [];
    for (const it of items) {
      const t = Math.round(Number(it.t));
      const w = Math.round(Number(it.w));
      const h = Math.round(Number(it.h));
      if (!/^[0-9a-f]{16}$/.test(it.id) || !(t >= 0 && t < 1e13) || !(w > 0 && w < 1e5) || !(h > 0 && h < 1e5)) {
        return json({ error: "One of the photos had invalid details." }, 400);
      }
      const name = `${String(t).padStart(13, "0")}-${it.id}-${w}x${h}.jpg`;
      uploads.push({ id: it.id, name, full: `/img/full/${name}`, thumb: `/img/thumb/${name}` });
    }
    u.bytes += incoming;
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
    await env.BUCKET.delete(names.flatMap((n) => ["full/" + n, "thumb/" + n]));
    usage = null; // recount storage after deleting
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
