import { randomBytes } from "node:crypto";

const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAACiElEQVRYhc2XTWgTQRTHs+2hiodebPAiSPEg4qFgwAoaWyRYBRGkOag3BTEoWsFDqiBNNyfpsSA92pOiFz2I0IK3Htp8tLZ+kWqlb7NxthCa2WA95cls3GSb3dnsbjahC/9D2Jn3/817j82bQGCvPWqhEFQJJKkCWVWBsqpI2JqgTAlkVAIii21vrkhRlQBt3ZQjApQSGOWaUwKVtpn/F/MwQajVtLfv5OZMlKgs99UBCCQ7Zl6HmKwBUEVa5i0s5jdRnHqBJy+M4eHQLUcKjTxEcWpW22tTioyh/qDyFrJATo0bxfbaNaSxAbkL3Zy8UQORMXz/8Sc3tiMAr+a6wrEV7wDj098Qd4otSQgvcbNgC8DM2WY/AHhZ4ALo5kaAyniXKxkBeFmwBDCa+wlglQVLAKO5nwBWWeg4QGMWXAGYND9RNZs527QJdQWvrbsHOBNbxbmFvGXwyoc44td3jgAOXFrFU4k/7gEEByDNALqH0zgQ38bTyb/eAQSPIGzP0VhBM/cFQHAJwuqum/ffkf0DEByAvJz/rdWdmZ94VMTuoVRzgLvPvmDXuaWWQba2ihh6UtLMQ0/L2BNZ1tY5+hQvLG5g8HLaNQTT0L01fDMHOBhXNPPByR3svfK59t4agJjnQUUCjD5eQyG86Ank2IMqwKHrP7TfvRdTOPvW8B0gUDKMZOwOYP2XPPM6h/vOuwfYP7KCR25Xeypy/xNurG/ajGQERLuhJJ39hcdvZDHgEqJnOIXPX+Ws4xJI1AEcjOWsJDdFvZbNy9IfzWDuO2coJdI2zecP1gC0MhAY7eDF5OoucyMEa462AbCT88wDOoQs97FLAyWQthvXnQtULRaBhCnte+H5B2JTvZoEZAOhAAAAAElFTkSuQmCC";

const styles = `
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: clamp(16px, 4vw, 48px);
      background: #f7f9fd;
      color: #142342;
      font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .card {
      width: min(100%, 536px);
      overflow: hidden;
      background: #fff;
      border: 1px solid #dce4f0;
      border-radius: 28px;
      box-shadow: 0 28px 74px -38px #203d7155;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 20px clamp(20px, 6vw, 36px);
      border-bottom: 1px solid #e9eef6;
      color: #1d3463;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -.02em;
    }
    .brand img { border-radius: 8px; display: block; }
    .status {
      padding: 42px clamp(20px, 6vw, 36px) 36px;
      text-align: center;
      background: radial-gradient(ellipse 78% 80% at 50% 0%, #edf4ff, #fff 84%);
    }
    .check {
      display: grid;
      place-items: center;
      width: 64px;
      height: 64px;
      margin: 0 auto 22px;
      border: 1px solid #cbdcff;
      border-radius: 22px;
      background: #e1ecff;
      color: #013ecb;
      box-shadow: 0 0 0 8px #edf3ff;
    }
    .check::before {
      content: "";
      width: 22px;
      height: 12px;
      border-left: 3px solid currentColor;
      border-bottom: 3px solid currentColor;
      transform: translateY(-3px) rotate(-45deg);
    }
    h1 {
      margin: 0;
      font-size: clamp(30px, 7vw, 42px);
      line-height: 1.18;
      letter-spacing: -.045em;
    }
    .description { margin: 14px 0 0; color: #4d5d78; text-wrap: pretty; }
    .next {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      margin: 0 clamp(16px, 6vw, 36px) 34px;
      padding: 16px;
      background: #f6f8fc;
      border: 1px solid #e2e9f4;
      border-radius: 16px;
    }
    .terminal {
      flex: 0 0 36px;
      display: grid;
      place-items: center;
      height: 34px;
      border-radius: 8px;
      background: #1d3463;
      color: #fff;
      font: 600 14px/1 ui-monospace, monospace;
    }
    .terminal b { color: #ffb777; }
    h2 { margin: 0; font-size: 15px; line-height: 1.4; }
    .next p { margin: 3px 0 0; color: #4d5d78; font-size: 14px; }
    .warning .check { color: #9a4400; background: #fff1e2; border-color: #ffe0ba; box-shadow: 0 0 0 8px #fff7ed; }
    .warning .check::before, .waiting .check::before {
      width: auto;
      height: auto;
      border: 0;
      transform: none;
      font-size: 28px;
      font-weight: 700;
    }
    .warning .check::before { content: "!"; }
    .waiting .check::before { content: "…"; }
    .manual { margin: 0 36px 28px; }
    .manual button { padding: 8px 14px; font: inherit; cursor: pointer; }
`;

const states = {
  received: ["已收到授权", "浏览器中的授权步骤已完成。", "在终端查看连接结果。此页面可以关闭。", "", "/connected"],
  cancelled: ["已取消授权", "这次登录已取消。", "如需连接，请在终端重新发起登录。", "warning", "/connection-cancelled"],
  invalid: ["授权校验失败", "此回调无法与当前终端的登录请求匹配。", "请在终端重新发起登录。", "warning", "/connection-error"],
  failed: ["终端连接未完成", "这次连接请求无法继续。", "请在终端重新发起登录。", "warning", "/connection-error"],
  waiting: ["正在连接当前终端", "正在将浏览器授权交回给发起登录的终端。", "连接完成后，在终端查看结果。", "waiting"],
};

export function connectionPage(state, { form, formOrigin } = {}) {
  const [title, description, next, tone, route] = states[state];
  const nonce = randomBytes(18).toString("base64url");
  const script = form
    ? "document.forms[0].submit()"
    : `history.replaceState(null,"",${JSON.stringify(route)})`;
  return {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": form ? "origin" : "no-referrer",
      "content-security-policy": `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action ${formOrigin || "'none'"}; frame-ancestors 'none'; base-uri 'none'`,
    },
    html: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${title} · Page Review</title>
  <link rel="icon" href="${logo}">
  <style nonce="${nonce}">${styles}</style>
</head>
<body>
  <main class="card ${tone}">
    <header class="brand"><img src="${logo}" alt="" width="32" height="32"><span>Page Review</span></header>
    <section class="status" aria-labelledby="callback-title">
      <span class="check" aria-hidden="true"></span>
      <h1 id="callback-title">${title}</h1>
      <p class="description">${description}</p>
    </section>
    <section class="next" aria-labelledby="next-title">
      <span class="terminal" aria-hidden="true"><span>›<b>_</b></span></span>
      <div><h2 id="next-title">${form ? "请稍候" : "返回发起登录的终端"}</h2><p>${next}</p></div>
    </section>
    ${form || ""}
  </main>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`,
  };
}

export function sendConnectionPage(res, status, state, options) {
  const { headers, html } = connectionPage(state, options);
  res.writeHead(status, headers);
  res.end(html);
}
