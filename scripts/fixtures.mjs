import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prelude = '<script src="/__test/bridge.js" defer></script><script src="/core.js" defer></script><script src="/db.js" defer></script><script src="/background.js" defer></script>';
const content = '<script src="/content-style.js" defer></script><script src="/content.js" defer></script>';
const css = `*{box-sizing:border-box}body{margin:0;font:16px/1.9 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#34493e;background:#fff}nav{padding:26px 8vw;border-bottom:1px solid #edf0eb;display:flex;justify-content:space-between}nav a{color:inherit;text-decoration:none;margin-left:22px}main{max-width:900px;margin:60px auto;padding:0 28px}h1{font:600 48px/1.45 Georgia,"PingFang SC",serif;max-width:700px}h2{margin-top:48px;font-size:26px}p{max-width:700px;color:#728071}.kicker{font-size:11px;letter-spacing:2px;color:#a1ad9b}.map{display:flex;gap:14px;background:#edf1e7;padding:35px;border-radius:5px;margin:36px 0}.map button{background:#fff;border:1px solid #dbe3d3;padding:24px;flex:1;font:inherit;color:inherit;cursor:pointer}.tip{opacity:0;min-height:44px;color:#66835c}.map button:hover{background:#dbe8cf}.map button:hover .tip{opacity:1}.long{min-height:550px}.source{font-size:12px;border-top:1px solid #e5ebdf;padding:20px 0}.resource{padding:24px;border:1px solid #dee5da;margin:20px 0}`;
function page(url) {
  const collection = url.startsWith('/collection');
  const title = collection ? '按正在做的事，整理资料。' : '让好内容，更容易被找到。';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title} · Page Review验收页</title><style>${css}</style><nav><strong>fieldnotes.</strong><div><a href="/reading">阅读</a><a href="/collection">资料架</a></div></nav><main><div class="kicker">DESIGN NOTES / ${collection ? 'COLLECTION' : 'READING PATH'}</div><h1 id="reading-title">${title}</h1><p class="lead">${collection ? '把入口安排在用户的问题旁边，让查找资料不再从猜分类开始。' : '一篇文章的入口，不只在首页。目录、关联内容和阅读进度，都在影响我们怎样理解内容。'}</p>${collection ? '<section class="resource" id="resource-classification"><h2>按任务查找</h2><p>了解内容 → 组织资料 → 解释交互 → 开始创作。资料按使用路径组织，而不是按文件格式分类。</p></section><section class="resource" id="resource-source"><h2>来源与更新时间</h2><p>解释整理方式的长段可以缩短，但资料来源和更新时间应当保留。</p></section>' : '<div class="map" id="reading-map"><button id="map-entry">找到入口<div class="tip">知道从哪里开始。</div></button><button id="map-feedback">就近反馈<div class="tip">信息在视线附近展开。</div></button><button id="map-return">继续浏览<div class="tip">离开后恢复清晰。</div></button></div><section class="long" id="reading-section"><h2>给阅读一条路</h2><p>当内容越来越多，读者带着具体的问题来到这里。目录让读者知道自己在哪里，关联内容让人知道接着读什么。好的入口，不需要反复回到首页重新查找。</p><p>必要的解释放在问题附近，不把所有信息同时摆在眼前。收集参考时，可以关注触发区域、内容组织和反馈关系。</p></section><section id="related-section"><h2>沿着这个话题，继续读</h2><p>把零散资料整理成一条线索，或者看看解释如何按需展开。</p><a href="/collection">去资料架继续收集 →</a></section>'}<footer class="source">公开的合成验收内容，无账号、无私人数据。</footer></main></html>`;
}
const server = http.createServer(async (request, response) => {
  try {
    const name = new URL(request.url, 'http://localhost').pathname;
    if (name === '/content-style.js') { response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); response.end('globalThis.PageReviewStyles = ' + JSON.stringify(await fs.readFile(path.join(project, 'extension/content.css'), 'utf8')) + ';'); return; }
    if (name === '/__test/bridge.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(await fs.readFile(path.join(project, 'tests/browser/bridge.js'))); return; }
    if (['/core.js', '/db.js', '/background.js', '/content-style.js', '/content.js', '/library.js', '/library.css'].includes(name)) {
      response.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css' : 'text/javascript', 'cache-control': 'no-store' }); response.end(await fs.readFile(path.join(project, 'extension', name.slice(1)))); return;
    }
    response.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
    if (name === '/library.html') { const html = await fs.readFile(path.join(project, 'extension/library.html'), 'utf8'); response.end(html.replace('<head>', '<head>' + prelude)); }
    else response.end(page(request.url).replace('<nav>', prelude + content + '<nav>'));
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
const portArg = process.argv.indexOf('--port'), port = portArg < 0 ? 8794 : Number(process.argv[portArg + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('测试端口无效');
server.listen(port, '127.0.0.1', () => console.log(`Page Review验收页：http://127.0.0.1:${port}/reading`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
