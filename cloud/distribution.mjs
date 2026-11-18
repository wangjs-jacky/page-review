// Public CLI binaries are deliberately separate from private annotation FILES.
export const VERSION = "0.4.2";
const names = [
  "page-review-darwin-arm64.tar.gz",
  "page-review-darwin-x64.tar.gz",
  "SHA256SUMS",
];
async function manifest(env) {
  if (!env.RELEASES) return null;
  try {
    const o = await env.RELEASES.get(`releases/${VERSION}/manifest.json`);
    const m = o && (await new Response(o.body).json());
    if (
      m?.version !== VERSION ||
      !Array.isArray(m.files) ||
      !names.every((n) => m.files.includes(n))
    )
      return null;
    if (!(await env.RELEASES.head(`releases/${VERSION}/install.sh`)))
      return null;
    for (const n of names)
      if (!(await env.RELEASES.head(`releases/${VERSION}/${n}`))) return null;
    return m;
  } catch {
    return null;
  }
}
export async function capabilities(env) {
  let origin;
  try {
    const u = new URL(env.API_ORIGIN);
    origin = u.origin === env.API_ORIGIN && u.protocol === "https:";
  } catch {
    origin = false;
  }
  const ready = Boolean(origin && (await manifest(env)));
  return {
    version: VERSION,
    regionalRecording: true,
    fixedHandoffs: true,
    terminalConnect: 1,
    cliAvailable: ready,
    installUrl: ready ? `${env.API_ORIGIN}/install.sh` : null,
  };
}
export async function distributionRoute(request, env) {
  const path = new URL(request.url).pathname;
  if (
    request.method !== "GET" ||
    !(path === "/install.sh" || path.startsWith("/releases/"))
  )
    return null;
  if (!(await manifest(env)))
    return new Response("CLI 尚未发布\n", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  const name = path === "/install.sh" ? "install.sh" : path.split("/").at(-1);
  const requestedVersion = path.split("/")[2];
  if (
    path !== "/install.sh" &&
    (![VERSION, "0.4.0"].includes(requestedVersion) ||
      path !== `/releases/${requestedVersion}/${name}` ||
      !names.includes(name))
  )
    return new Response("Not found", { status: 404 });
  const o = await env.RELEASES.get(
    path === "/install.sh" ? `releases/${VERSION}/install.sh` : path.slice(1),
  );
  if (!o) return new Response("Not found", { status: 404 });
  return new Response(o.body, {
    headers: {
      "content-type":
        name === "install.sh"
          ? "text/x-shellscript; charset=utf-8"
          : name === "SHA256SUMS"
            ? "text/plain"
            : "application/gzip",
      "cache-control":
        name === "install.sh" ? "no-store" : "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
