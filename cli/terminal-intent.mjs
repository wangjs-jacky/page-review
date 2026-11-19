import { sendConnectionPage } from "./connection-page.mjs";
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
    sendConnectionPage(res, 403, "failed");
    return true;
  }
  let body = "";
  for await (const part of req) {
    body += part;
    if (Buffer.byteLength(body) > 8192) {
      sendConnectionPage(res, 413, "failed");
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
    sendConnectionPage(res, 400, "invalid");
    return true;
  }
  // Top-level form navigation preserves the central host's SameSite=Lax session.
  const inputs = Object.entries({ request_id: requestId, relay, proof })
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`)
    .join("");
  const relayForm = `<form method="post" action="${esc(loginOrigin)}/page-review/terminal-return">${inputs}<noscript><div class="manual"><button type="submit">继续连接</button></div></noscript></form>`;
  sendConnectionPage(res, 200, "waiting", { form: relayForm, formOrigin: loginOrigin });
  return true;
}
