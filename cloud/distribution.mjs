// Only these versioned public CLI files may enter the edge cache.
import { CLI_VERSION, READ_PROTOCOL, CLI_FILES, INSTALLER_KEY } from "./cli-release.mjs";
import { supportsLivePageSchema } from "./handoff.mjs";
export const VERSION = CLI_VERSION;
export { INSTALLER_KEY };
const names = CLI_FILES;
async function ready(env) {
  if (!env.RELEASES) return false;
  try {
    const object = await env.RELEASES.get(`releases/${VERSION}/manifest.json`),
      value = object && await new Response(object.body).json();
    if (value?.version !== VERSION || value.readProtocol !== READ_PROTOCOL || !Array.isArray(value.files) ||
        !names.every(name => value.files.includes(name))) return false;
    // A single finite readiness check; no isolate promise/state shared across requests.
    return (await Promise.all([INSTALLER_KEY, ...names.map(n => `releases/${VERSION}/${n}`)]
      .map(key => env.RELEASES.head(key)))).every(Boolean);
  } catch { return false; }
}
export async function capabilities(env) {
  let origin = false;
  try { const u = new URL(env.API_ORIGIN); origin = u.origin === env.API_ORIGIN && u.protocol === "https:"; } catch {}
  const available = Boolean(origin && await ready(env));
  const live = Boolean(available && await supportsLivePageSchema(env.DB));
  return { version: VERSION, regionalRecording: true, fixedHandoffs: true,
    terminalConnect: 1, cliAvailable: available,
    livePageReferences: live ? 1 : 0, syncAfter: live ? 1 : 0,
    installUrl: available ? `${env.API_ORIGIN}/install.sh` : null };
}
function rangeOf(value, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(value || "");
  if (!m || (!m[1] && !m[2]) || !Number.isSafeInteger(size) || size <= 0) return null;
  let start, end;
  if (!m[1]) { const count = Number(m[2]); if (!Number.isSafeInteger(count) || count <= 0) return null; start = Math.max(0, size - count); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1, end };
}
const notFound = () => new Response("Not found", { status: 404 });
const etagMatches = (value, etag) => Boolean(value && etag && value.split(",").some(v => v.trim() === "*" || v.trim().replace(/^W\//, "") === etag));
const rangeAllowed = (request, etag, uploaded) => {
  const condition = request.headers.get("if-range");
  if (!condition) return true;
  if (condition === etag && !condition.startsWith("W/")) return true;
  const time = Date.parse(condition);
  return Number.isFinite(time) && uploaded && Math.floor(new Date(uploaded).getTime() / 1000) <= Math.floor(time / 1000);
};
function headersFor(object, name, range) {
  const headers = new Headers({
    "content-type": name.startsWith("SHA256SUMS") ? "text/plain; charset=utf-8" : "application/gzip",
    "cache-control": "public, max-age=31536000, immutable",
    "accept-ranges": "bytes", "x-content-type-options": "nosniff",
  });
  if (Number.isSafeInteger(object.size)) headers.set("content-length", String(range?.length ?? object.size));
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  if (object.uploaded) headers.set("last-modified", new Date(object.uploaded).toUTCString());
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.end}/${object.size}`);
  return headers;
}
const unsatisfied = size => new Response("Range not satisfiable", { status: 416,
  headers: { "content-range": `bytes */${size}`, "cache-control": "no-store" } });
function marked(response, state, head = false) {
  const headers = new Headers(response.headers); headers.set("x-page-review-cache", state);
  if (head) response.body?.cancel().catch(() => {});
  return new Response(head ? null : response.body, { status: response.status, headers });
}
function unchanged(headers, body) {
  body?.cancel().catch(() => {});
  const result = new Headers(headers);
  result.delete("content-length"); result.delete("content-range");
  return new Response(null, { status: 304, headers: result });
}
export async function distributionRoute(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname, head = request.method === "HEAD";
  if (!(path === "/install.sh" || path.startsWith("/releases/"))) return null;
  if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  if (path === "/install.sh") {
    if (!await ready(env)) return new Response("CLI 尚未发布\n", { status: 503, headers: { "cache-control": "no-store" } });
    const object = head ? await env.RELEASES.head(INSTALLER_KEY) : await env.RELEASES.get(INSTALLER_KEY);
    if (!object) return notFound();
    return new Response(head ? null : object.body, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-page-review-delivery": "r1" } });
  }
  const parts = path.split("/"), version = parts[2], name = parts[3];
  if (parts.length !== 4 || ![VERSION, "0.4.3", "0.4.2", "0.4.0"].includes(version) || !names.includes(name)) return notFound();
  if (!env.RELEASES) return notFound();
  const key = path.slice(1), cacheKey = new Request(url.origin + path), cache = globalThis.caches?.default,
    rangeHeader = request.headers.get("range");
  // Query, Cookie and Authorization cannot alter the content of this public allowlist.
  let cached;
  try { cached = cache && await cache.match(cacheKey); } catch {}
  if (cached) {
    const etag = cached.headers.get("etag");
    if (etagMatches(request.headers.get("if-none-match"), etag)) return unchanged(cached.headers, cached.body);
    if (!rangeHeader || !rangeAllowed(request, etag, cached.headers.get("last-modified"))) return marked(cached, "HIT", head);
    cached.body?.cancel().catch(() => {});
    const size = Number(cached.headers.get("content-length")), range = rangeOf(rangeHeader, size);
    if (!range) return unsatisfied(size);
    try {
      const hit = await cache.match(new Request(cacheKey, { headers: { range: `bytes=${range.offset}-${range.end}` } }));
      if (hit?.status === 206) return marked(hit, "HIT", head);
    } catch {}
  }
  let range = null, metadata;
  if (rangeHeader) {
    metadata = await env.RELEASES.head(key);
    if (!metadata) return notFound();
    if (rangeAllowed(request, metadata.httpEtag, metadata.uploaded)) {
      range = rangeOf(rangeHeader, metadata.size);
      if (!range) return unsatisfied(metadata.size);
    }
  }
  const object = head ? metadata || await env.RELEASES.head(key) : await env.RELEASES.get(key,
    range ? { range: { offset: range.offset, length: range.length } } : undefined);
  if (!object) return notFound();
  const headers = headersFor(object, name, range);
  if (etagMatches(request.headers.get("if-none-match"), object.httpEtag)) return unchanged(headers, object.body);
  const response = new Response(head ? null : object.body, { status: range ? 206 : 200, headers });
  // Never cache a partial stream, installer, authenticated API or private FILES object.
  if (cache && !head && !range && headers.has("content-length")) {
    const put = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return marked(response, range ? "RANGE" : "MISS", head);
}
