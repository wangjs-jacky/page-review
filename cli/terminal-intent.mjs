import { randomBytes } from "node:crypto";
const valid = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
// Top-level form navigation works with SameSite=Lax and needs no CORS/private-network permission.
export function relayPage(action, values, message = "正在连接当前终端…") {
  const nonce = randomBytes(18).toString("base64url");
  return {
    nonce,
    html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="origin"><title>连接终端 · Page Review</title><body><p>${esc(message)}</p><form method="post" action="${esc(action)}">${Object.entries(
      values,
    )
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`,
      )
      .join(
        "",
      )}</form><script nonce="${nonce}">document.forms[0].submit()</script></body></html>`,
  };
}
export async function terminalRelay(
  req,
  res,
  { callbackOrigin, loginOrigin, requestId, proof },
) {
  if (req.method !== "POST" || req.url !== "/connect") return false;
  if (
    req.headers.host !== new URL(callbackOrigin).host ||
    req.headers.origin !== loginOrigin ||
    req.headers["content-type"]?.split(";")[0] !==
      "application/x-www-form-urlencoded"
  ) {
    res.writeHead(403);
    res.end("终端连接来源无效");
    return true;
  }
  let body = "";
  for await (const part of req) {
    body += part;
    if (Buffer.byteLength(body) > 8192) {
      res.writeHead(413);
      res.end();
      return true;
    }
  }
  const form = new URLSearchParams(body),
    relay = form.get("relay");
  if (
    !valid(requestId) ||
    form.get("request_id") !== requestId ||
    !relay ||
    relay.length > 6000 ||
    !/^[\w-]+\.[\w-]{43}$/.test(relay)
  ) {
    res.writeHead(400);
    res.end("不是当前终端发起的连接");
    return true;
  }
  const page = relayPage(loginOrigin + "/page-review/terminal-return", {
    request_id: requestId,
    relay,
    proof,
  });
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "origin",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${page.nonce}'; form-action ${loginOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  });
  res.end(page.html);
  return true;
}
