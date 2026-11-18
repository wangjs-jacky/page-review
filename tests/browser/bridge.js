/* Browser integration adapter, never included in the extension build.
   Runs production background/content/library code with real IndexedDB.
   Chrome tabs/actions/scripting are adapters, NOT native-extension E2E. */
(function () {
  const listeners = [], changes = [], installed = [], startup = [], actions = [];
  const prefix = 'page-review-browser-test:';
  function storage(area) {
    const source = area === 'session' ? sessionStorage : localStorage;
    return {
      async get(keys) {
        const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {}), result = {};
        for (const key of wanted) { const raw = source.getItem(prefix + key); if (raw !== null) result[key] = JSON.parse(raw); else if (keys && !Array.isArray(keys) && typeof keys === 'object') result[key] = keys[key]; }
        return result;
      },
      async set(items) {
        const changed = {}; for (const [key, value] of Object.entries(items)) { const raw = source.getItem(prefix + key); source.setItem(prefix + key, JSON.stringify(value)); changed[key] = { oldValue: raw ? JSON.parse(raw) : undefined, newValue: value }; }
        for (const listener of changes) listener(changed, area);
      },
      async remove(key) { source.removeItem(prefix + key); }
    };
  }
  globalThis.__adapterContentListeners=[];
  if(globalThis.__testConnection)localStorage.setItem(prefix+'cloudConnection',JSON.stringify(globalThis.__testConnection));
  globalThis.__captureQueue = [];
  globalThis.__loginQueue = [];
  const realFetch=globalThis.fetch.bind(globalThis);
  const routedFetch=(input,options)=>{if(typeof input==='string' && input.startsWith('https://review.paws.rodeo/')){const u=new URL(input);return realFetch(location.origin+u.pathname+u.search,options);}return realFetch(input,options);};
  // Fault/auth adapters are opt-in and only exist in this loopback test harness.
  globalThis.fetch=(input,options)=>globalThis.__adapterFetch
    ? globalThis.__adapterFetch(input,options,routedFetch)
    : routedFetch(input,options);
  globalThis.importScripts = () => {}; // The same files are loaded as ordered scripts below.
  globalThis.chrome = {
    identity: { getRedirectURL: () => "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/page-review", launchWebAuthFlow: options => new Promise((resolve,reject) => globalThis.__loginQueue.push({ options, resolve, reject })) },
    runtime: {
      id: 'page-review-browser-integration', getURL: name => new URL('/' + name, location.origin).href,
      onInstalled: { addListener: listener => installed.push(listener) }, onStartup: { addListener: listener => startup.push(listener) },
      onMessage: { addListener: listener => {listeners.push(listener);if(listeners.length>1)globalThis.__adapterContentListeners.push(listener);} },
      sendMessage: message => new Promise(resolve => listeners[0](message, { id: 'page-review-browser-integration', url: location.href, frameId: 0, tab: { id: 1, windowId: 1, url: location.href } }, resolve))
    },
    storage: { local: storage('local'), session: storage('session'), onChanged: { addListener: listener => changes.push(listener) } },
    permissions: { contains: async () => true, onRemoved: { addListener() {} } },
    scripting: {
      getRegisteredContentScripts: async () => JSON.parse(localStorage.getItem(prefix + 'scripts') || '[]'),
      registerContentScripts: async scripts => localStorage.setItem(prefix + 'scripts', JSON.stringify(scripts)),
      unregisterContentScripts: async () => localStorage.setItem(prefix + 'scripts', '[]'),
      executeScript: async () => globalThis.__pageReviewController?.refresh()
    },
    action: { onClicked: { addListener: listener => actions.push(listener) }, setBadgeBackgroundColor: async () => {}, setBadgeText: async value => { globalThis.__adapterBadge = value; }, setTitle: async value => { globalThis.__adapterTitle = value; } },
    tabs: {
      get: async () => ({ id: 1, windowId: 1, url: location.href }), query: async () => [{ id: 1, windowId: 1, url: location.href }],
      captureVisibleTab: async () => new Promise(resolve => globalThis.__captureQueue.push({ resolve })),
      create: async ({ url }) => { location.href = url; return { id: 1 }; }
    }
  };
  globalThis.__adapterOffscreenEvent=message=>new Promise(resolve=>listeners[0](message,{id:chrome.runtime.id,url:chrome.runtime.getURL('offscreen.html')},resolve));
  globalThis.__adapterToggle = () => actions[0]({ id: 1, windowId: 1, url: location.href });
  document.addEventListener('DOMContentLoaded', () => {
    if (/\/library\.html$/.test(location.pathname)) return;
    const banner = document.createElement('div'); banner.id = 'integration-adapter';
    banner.style.cssText = 'padding:8px 20px;background:#eef3fc;color:#697d99;font:11px/1.5 sans-serif;display:flex;justify-content:space-between';
    const label = document.createElement('span'); label.textContent = '集成验收 · Chrome API 与录制输入为测试适配；界面、采集处理、存储和云服务为实际代码';
    const button = document.createElement('button'); button.id = 'adapter-toggle'; button.textContent = '启用 / 关闭（API 适配）'; button.addEventListener('click', globalThis.__adapterToggle);
    banner.append(label, button); document.body.prepend(banner);
  });
})();
