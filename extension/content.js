(function () {
  'use strict';
  if (globalThis.__pageReviewController) { globalThis.__pageReviewController.refresh(); return; }
  const Core = PageReviewCore;
  const I = {
    pen: '<path d="m16 3 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L3 16l-1 6Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    area: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/>',
    page: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a20 20 0 0 0 0 18 20 20 0 0 0 0-18Z"/>',
    note: '<path d="M4 3h16v14l-4 4H4Zm12 14v4M8 8h8M8 12h6"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4Zm16 0h-5a3 3 0 0 0-2 3v14a4 4 0 0 1 4-2h3Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 17 6-6 4 4 3-3 5 5"/><circle cx="8" cy="8" r="1"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || I.note}</svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const labels = { found: '已定位', uncertain: '位置待确认', missing: '原位置失效', changed: '页面已明显变化' };
  const kinds = { observation: '观察', like: '优点', problem: '问题' };
  let host, shadow, controller, observer, observerTimer, frame, toastTimer, drag, regionDrag, suppressClick = 0, operation = 0, route = location.href;
  const state = { enabled: false, dock: { side: 'right', bottom: 24 }, notes: [], matches: new Map(), mode: 'browse', panel: null, showMarkers: true, hover: null, draft: null, peek: null, busy: false, rebind: null };
  async function send(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(result?.error || '插件已更新，请刷新网页后继续'); return result.value;
  }
  const own = event => Boolean(host && event.composedPath().includes(host));
  function textOf(el, length = 1200) {
    if (!el || /^(INPUT|TEXTAREA|SELECT|SCRIPT|STYLE)$/.test(el.tagName)) return '';
    return Core.normalize(el.innerText || el.textContent).slice(0, length);
  }
  function signature() { return textOf(document.querySelector('main,[role="main"],article') || document.body, 6000); }
  function selectorFor(el) {
    const parts = []; let current = el;
    while (current && current !== document.documentElement && parts.length < 6) {
      if (current.id && !/\d{3}|[a-f\d]{10}/i.test(current.id)) { parts.unshift('#' + CSS.escape(current.id)); break; }
      const testId = current.getAttribute('data-testid');
      if (testId) { parts.unshift(`[data-testid="${CSS.escape(testId)}"]`); break; }
      let part = current.localName;
      if (!part) break;
      const siblings = current.parentElement ? [...current.parentElement.children].filter(e => e.localName === current.localName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part); current = current.parentElement;
    }
    return parts.join(' > ');
  }
  function descriptor(el) {
    const attrs = {};
    for (const key of ['id', 'data-testid', 'aria-label', 'role', 'href', 'alt']) {
      const value = el.getAttribute(key); if (value && !(key === 'id' && /\d{3}|[a-f\d]{10}/i.test(value))) attrs[key] = value.slice(0, 300);
    }
    const r = el.getBoundingClientRect();
    return { tag: el.localName, selector: selectorFor(el), attrs, text: textOf(el), label: el.getAttribute('aria-label') || el.getAttribute('alt') || '', context: textOf(el.parentElement, 800), box: { width: r.width, height: r.height } };
  }
  function selectedTarget(target) {
    let el = target instanceof Element ? target : target?.parentElement;
    if (!el || el === host || el === document.documentElement) return null;
    if (el.closest('svg')) el = el.closest('svg').parentElement;
    return el?.closest('a,button,h1,h2,h3,h4,p,li,figure,img,video,canvas,[role="button"]') || el;
  }
  function viewport() { return { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio, visualScale: visualViewport?.scale || 1 }; }
  function interactionState(el) {
    return { hovered: [...document.querySelectorAll(':hover')].filter(e => e !== host && e !== document.body && e !== document.documentElement).slice(-5).map(e => ({ tag: e.localName, label: textOf(e, 120) })), expanded: el?.getAttribute('aria-expanded'), selected: el?.getAttribute('aria-selected'), detailsOpen: Boolean(el?.closest('details')?.open) };
  }
  function resolveNote(note, currentSignature) {
    const pageSimilarity = Core.similarity(note.pageSignature, currentSignature);
    if (note.pageSignature?.length > 40 && pageSimilarity < 0.46) return { status: 'changed' };
    if (note.type === 'page') return { status: 'found', element: document.body };
    if (!note.anchor?.tag || !/^[a-z][a-z0-9-]*$/i.test(note.anchor.tag)) return { status: 'missing' };
    const elements = new Set();
    try { for (const el of document.querySelectorAll(note.anchor.selector)) if (el !== host) elements.add(el); } catch {}
    const candidates = document.querySelectorAll(note.anchor.tag);
    for (const el of candidates) {
      if (elements.size >= 500) break;
      if (el !== host && el.getClientRects().length) elements.add(el);
    }
    const list = [...elements];
    const result = Core.rankAnchors(note.anchor, list.map(descriptor));
    if (result.status !== 'found') return result;
    const element = list[result.index];
    if (note.type === 'region') {
      const r = element.getBoundingClientRect(), old = note.anchor.box;
      if (!old?.width || !old.height || pageSimilarity < 0.9 || Math.abs(r.width / old.width - 1) > 0.12 || Math.abs(r.height / old.height - 1) > 0.12) return { status: 'uncertain' };
    }
    return { ...result, element };
  }
  async function loadNotes() {
    const at = location.href;
    const notes = await send('LIST');
    if (!state.enabled || at !== location.href) return;
    state.notes = notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const currentSignature = signature(); state.matches = new Map(state.notes.map(note => [note.id, resolveNote(note, currentSignature)]));
    renderWidget(); renderMarkers();
    if (state.panel === 'notes') renderPanel();
    send('LOCATION_RESULTS', { results: state.notes.map(note => ({ id: note.id, status: state.matches.get(note.id).status })) }).catch(() => {});
  }
  function mount() {
    if (host?.isConnected) return;
    host = document.createElement('div'); host.id = 'page-review-overlay'; host.setAttribute('data-page-review', '');
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = PageReviewStyles;
    shadow.append(style);
    for (const id of ['widget', 'markers', 'selection', 'panel', 'notifications']) { const el = document.createElement('div'); el.id = id; shadow.append(el); }
    document.documentElement.append(host);
    controller = new AbortController(); const options = { signal: controller.signal };
    shadow.addEventListener('click', action, options);
    shadow.addEventListener('input', event => { if (event.target.id === 'review-comment' && state.draft) state.draft.note.comment = event.target.value; }, options);
    shadow.addEventListener('pointerdown', orbDown, options);
    document.addEventListener('click', selectClick, { ...options, capture: true });
    document.addEventListener('pointermove', pointerMove, { ...options, capture: true });
    document.addEventListener('pointerdown', pointerDown, { ...options, capture: true });
    document.addEventListener('pointerup', pointerUp, { ...options, capture: true });
    document.addEventListener('pointercancel', cancelPointer, options);
    document.addEventListener('keydown', keyDown, { ...options, capture: true });
    window.addEventListener('resize', schedulePosition, options);
    window.addEventListener('scroll', schedulePosition, { ...options, capture: true, passive: true });
    window.addEventListener('popstate', pageChanged, options); window.addEventListener('hashchange', pageChanged, options);
    if (globalThis.navigation) navigation.addEventListener('navigatesuccess', pageChanged, options);
    observer = new MutationObserver(() => {
      if (observerTimer || state.busy || state.draft) return;
      observerTimer = setTimeout(() => { observerTimer = null; pageChanged(); loadNotes().catch(error => toast(error.message)); }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    renderWidget(); renderPanel();
  }
  function unmount() {
    operation++; controller?.abort(); observer?.disconnect(); clearTimeout(observerTimer); observerTimer = null;
    cancelAnimationFrame(frame); clearTimeout(toastTimer); host?.remove(); host = null; shadow = null;
    state.mode = 'browse'; state.panel = null; state.hover = null; state.rebind = null; drag = null; regionDrag = null; state.busy = false;
  }
  async function refresh() {
    try {
      const setting = await send('GET_SETTINGS'); state.enabled = setting.enabled; state.dock = setting.dock;
      if (state.enabled) { mount(); await loadNotes(); const id = await send('TAKE_FOCUS'); if (id) locate(id); }
      else unmount();
    } catch (error) { if (host) toast(error.message); }
  }
  function pageChanged() {
    if (route === location.href) return;
    route = location.href;
    if (state.draft) { state.draft.error = '网页已经切换，原评注尚未保存。请返回原页面后保存，或复制评注内容。'; renderPanel(); }
    else { state.panel = null; state.mode = 'browse'; renderPanel(); }
    loadNotes().catch(error => toast(error.message));
  }
  function schedulePosition() { if (!frame) frame = requestAnimationFrame(() => { frame = null; positionWidget(); renderMarkers(); if (state.hover) highlight(state.hover.getBoundingClientRect()); }); }
  function dockPosition() {
    const y = Math.max(12, innerHeight - Math.max(16, state.dock.bottom) - 48);
    return { x: state.dock.side === 'left' ? 16 : Math.max(12, innerWidth - 64), y };
  }
  function positionWidget(raw) {
    if (!shadow) return;
    const wrap = shadow.querySelector('.orb-wrap'), panel = shadow.querySelector('.panel'); const p = raw || dockPosition();
    if (wrap) Object.assign(wrap.style, { left: Math.max(12, Math.min(innerWidth - 60, p.x)) + 'px', top: Math.max(12, Math.min(innerHeight - 60, p.y)) + 'px' });
    if (panel) {
      const rect = panel.getBoundingClientRect(), gap = 12;
      const left = Math.max(12, Math.min(state.dock.side === 'left' ? p.x + 60 : p.x - rect.width - gap, innerWidth - rect.width - 12));
      const top = Math.max(12, Math.min(p.y + 48 - rect.height, innerHeight - rect.height - 12));
      Object.assign(panel.style, { left: left + 'px', top: top + 'px' });
    }
  }
  function renderWidget() {
    if (!shadow) return;
    shadow.getElementById('widget').innerHTML = `<div class="orb-wrap"><button class="orb ${state.mode !== 'browse' ? 'active' : ''}" data-action="toggle" aria-label="打开网页评注" aria-expanded="${Boolean(state.panel)}" title="网页评注 · 可拖动；菜单可收起到右下角">${icon('pen')}</button>${state.notes.length ? `<span class="count">${state.notes.length}</span>` : ''}<button class="orb-close" data-action="disable" aria-label="关闭网页评注" title="关闭，点击 Chrome 插件图标重新启用">${icon('close')}</button></div>`;
    positionWidget();
    renderHint();
  }
  function renderHint() {
    if (!shadow) return;
    shadow.querySelector('.hint')?.remove();
    if (state.mode !== 'browse') { const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = state.rebind ? '选择旧评注的新位置 · Esc 取消' : state.mode === 'area' ? '拖动圈出关注区域 · Esc 退出' : '点选关注的地方 · Esc 退出'; shadow.getElementById('selection').append(hint); }
  }
  function markRect(note, match) {
    if (note.type === 'page') return { left: 18, top: 16, width: 0, height: 0 };
    const r = match.element?.getBoundingClientRect(); if (!r) return null;
    if (note.type === 'region' && note.region) return { left: r.left + r.width * note.region.x, top: r.top + r.height * note.region.y, width: r.width * note.region.w, height: r.height * note.region.h };
    return r;
  }
  function renderMarkers() {
    if (!shadow) return;
    const markerRoot = shadow.getElementById('markers'); markerRoot.innerHTML = '';
    if (!state.showMarkers || state.mode !== 'browse') return;
    const positions = new Map();
    state.notes.forEach((note, index) => {
      const match = state.matches.get(note.id); if (match?.status !== 'found') return;
      const r = markRect(note, match); if (!r || r.top > innerHeight || r.top + r.height < 0 || r.left > innerWidth || r.left + r.width < 0) return;
      const base = `${Math.round(r.left)},${Math.round(r.top)}`, count = positions.get(base) || 0; positions.set(base, count + 1);
      const button = document.createElement('button'); button.className = 'pin'; button.dataset.action = 'peek'; button.dataset.id = note.id; button.textContent = String(index + 1).padStart(2, '0'); button.setAttribute('aria-label', `查看评注 ${index + 1}：${note.label}`);
      Object.assign(button.style, { left: Math.max(4, Math.min(innerWidth - 29, r.left - 12 + count * 26)) + 'px', top: Math.max(4, r.top - 12) + 'px' }); markerRoot.append(button);
      if (note.type === 'region') { const box = document.createElement('div'); box.className = 'region'; Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); markerRoot.append(box); }
    });
  }
  function panelHead(title, subtitle = '') { return `<header class="panel-head"><div><h2>${esc(title)}</h2>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</div><button class="icon" data-action="minimize" aria-label="收起到右下角" title="收起到右下角">${icon('close')}</button></header>`; }
  function renderPanel(focus = false) {
    if (!shadow) return;
    let html = '';
    if (state.panel === 'menu') {
      html = `<section class="panel" role="dialog" aria-label="网页评注操作">${panelHead('网页评注', `本页 ${state.notes.length} 条记录`)}<div class="body">${state.mode !== 'browse' ? `<div class="mode-label">${state.mode === 'area' ? '正在框选区域' : '正在点选对象'}<button data-action="finish">完成标注</button></div>` : ''}<button class="primary wide" data-action="point">${icon('pen')}开始标注</button><div class="two"><button class="secondary" data-action="area">框选区域</button><button class="secondary" data-action="page">整页评注</button></div><button class="menu-line" data-action="notes">${icon('note')}<span>本页评注</span>${state.notes.length}</button><button class="menu-line" data-action="markers">${icon('eye')}<span>${state.showMarkers ? '隐藏页面标记' : '显示页面标记'}</span></button><button class="menu-line" data-action="library">${icon('book')}<span>全部保存的网页</span>${icon('arrow')}</button></div><footer class="footer"><button class="link" data-action="minimize">收起到右下角</button><button class="link danger" data-action="disable">关闭网页评注</button></footer></section>`;
    } else if (state.panel === 'editor' && state.draft) {
      const d = state.draft;
      html = `<section class="panel editor" role="dialog" aria-label="填写网页评注">${panelHead(d.note.id ? '编辑评注' : d.note.label, d.note.type === 'page' ? '整页意见 · 记录当前视口' : '留下你关注的地方和原因')}<div class="body"><textarea id="review-comment" aria-label="评注内容" placeholder="这里有什么值得关注？写下你的观察……" maxlength="12000">${esc(d.note.comment)}</textarea><div class="kinds">${Object.entries(kinds).map(([key, label]) => `<button class="kind ${d.note.kind === key ? 'selected' : ''}" data-action="kind" data-kind="${key}">${label}</button>`).join('')}</div><div class="capture-state">${icon('image')}${d.note.id ? '修改原话，保留记录时画面' : d.asset ? '已附记录时视口与关注区域' : state.busy ? '正在记录画面…' : '画面未保存'}${!d.note.id && !d.asset && !state.busy ? '<button class="link" data-action="retry">重试截图</button>' : ''}</div>${d.error ? `<div class="error">${esc(d.error)}</div>` : ''}${!d.note.id && !d.asset && !state.busy ? `<label class="capture-state"><input id="allow-text" type="checkbox" ${d.allowWithoutImage ? 'checked' : ''}>我已知缺少画面，仅保存文字</label>` : ''}<div class="editing-row"><button class="link" data-action="cancel-draft">取消本条</button><div style="display:flex;gap:7px">${!d.note.id ? '<button class="secondary" data-action="save-continue">保存并继续</button>' : ''}<button class="primary" data-action="save" ${state.busy ? 'disabled' : ''}>保存评注</button></div></div></div></section>`;
    } else if (state.panel === 'notes') {
      const missing = state.notes.filter(n => state.matches.get(n.id)?.status !== 'found').length;
      html = `<section class="panel notes-panel" role="dialog" aria-label="本页评注">${panelHead('本页评注', `${state.notes.length} 条已保存`)}<div class="body">${missing ? `<div class="notice">${missing} 条评注的位置需要确认，原画面与意见仍保留。</div>` : ''}${state.notes.length ? state.notes.map((note, index) => { const status = state.matches.get(note.id)?.status || 'missing'; return `<article class="note"><div class="note-head"><strong>${String(index + 1).padStart(2, '0')} · ${esc(note.label)}</strong><span class="status ${status === 'found' ? '' : 'warn'}">${labels[status]}</span></div><p>${esc(note.comment)}</p><div class="note-actions"><button class="link" data-action="peek" data-id="${note.id}">原画面</button><button class="link" data-action="${status === 'found' ? 'locate' : 'rebind'}" data-id="${note.id}">${status === 'found' ? '回到位置' : '重新定位'}</button><button class="link" data-action="edit" data-id="${note.id}">编辑</button></div></article>`; }).join('') : '<div class="empty">还没有评注，留下一条自己的观察。</div>'}</div><footer class="footer"><button class="link" data-action="library">全部保存的网页</button><button class="primary" data-action="point">继续标注</button></footer></section>`;
    } else if (state.panel === 'peek' && state.peek) {
      const n = state.notes.find(n => n.id === state.peek.id);
      if (n) html = `<section class="panel editor" role="dialog" aria-label="查看已保存评注">${panelHead(n.label, new Date(n.createdAt).toLocaleString())}<div class="body"><p class="saved-comment">${esc(n.comment)}</p><div class="status">${labels[state.matches.get(n.id)?.status || 'missing']}</div>${state.peek.asset?.viewport ? `<img class="snapshot" src="${state.peek.asset.viewport}" alt="记录时网页视口">` : '<p class="muted">此条记录没有画面。</p>'}<div class="editing-row"><button class="link" data-action="notes">本页全部</button><button class="secondary" data-action="edit" data-id="${n.id}">编辑评注</button></div></div></section>`;
    } else if (state.panel === 'confirm-close') {
      html = `<section class="panel" role="dialog" aria-label="保留未保存评注">${panelHead('这条评注还没有保存')}<div class="body"><p>先保存，或者放弃这条输入后关闭。已经保存的记录不会删除。</p><div class="confirm-row"><button class="secondary" data-action="resume-draft">继续编辑</button><button class="secondary danger" data-action="discard-disable">放弃并关闭</button></div></div></section>`;
    }
    shadow.getElementById('panel').innerHTML = html; positionWidget();
    if (focus && state.panel === 'editor') { const textarea = shadow.getElementById('review-comment'); textarea?.focus({ preventScroll: true }); textarea?.setSelectionRange(textarea.value.length, textarea.value.length); }
  }
  function toast(message) {
    if (!shadow) return;
    clearTimeout(toastTimer); shadow.getElementById('notifications').innerHTML = `<div class="toast" role="status">${esc(message)}</div>`;
    toastTimer = setTimeout(() => { shadow?.getElementById('notifications').replaceChildren(); }, 4500);
  }
  function highlight(rect) {
    if (!shadow) return;
    shadow.querySelector('.highlight')?.remove();
    if (!rect) return;
    const box = document.createElement('div'); box.className = 'highlight'; Object.assign(box.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' }); shadow.getElementById('selection').append(box);
  }
  async function collapse() {
    state.panel = null; state.mode = 'browse'; state.hover = null; state.rebind = null; highlight(null);
    state.dock = { side: 'right', bottom: 24 }; renderWidget(); renderPanel(); renderMarkers();
    await send('SAVE_DOCK', { dock: state.dock });
  }
  function enter(mode) {
    if (state.draft) { state.panel = 'editor'; renderPanel(true); toast('先保存或取消当前评注'); return; }
    state.mode = mode; state.panel = null; state.hover = null; renderWidget(); renderPanel(); renderMarkers();
  }
  async function snapshot(draft) {
    const run = ++operation; state.busy = true; draft.error = ''; const target = draft.target;
    try {
      if (location.href !== draft.note.url) throw new Error('网页已切换，未截取新页面');
      const rect = draft.note.type === 'page' ? null : draft.rect;
      if (target && !target.isConnected) throw new Error('目标已移除，请重新选取或仅保存文字');
      host.style.setProperty('visibility', 'hidden', 'important');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const asset = await send('CAPTURE', { url: draft.note.url, viewport: draft.note.viewport, rect, noteType: draft.note.type });
      if (run !== operation) return;
      draft.asset = asset; draft.note.capturedAt = asset.capturedAt; draft.note.screenshotError = '';
    } catch (error) { if (run === operation) { draft.error = '未附上画面：' + error.message; draft.note.screenshotError = error.message; } }
    finally {
      host?.style.removeProperty('visibility');
      if (run === operation) { state.busy = false; state.panel = 'editor'; renderPanel(true); renderWidget(); }
    }
  }
  async function begin(type, target, rect, region = null) {
    if (state.busy || state.draft) return;
    state.mode = 'browse'; state.hover = null; highlight(null); state.panel = null; renderPanel(); renderMarkers();
    const anchor = target ? descriptor(target) : null;
    const label = type === 'page' ? '整页观察' : type === 'region' ? '选定区域' : (anchor.label || anchor.text || target.localName).slice(0, 50);
    const draft = { target, rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null, note: { url: location.href, title: document.title, type, label, anchor, region, comment: '', kind: 'observation', pageSignature: signature(), viewport: viewport(), state: interactionState(target) } };
    state.draft = draft; await snapshot(draft);
  }
  async function save(keepSelecting) {
    const draft = state.draft; if (!draft || state.busy) return;
    draft.note.comment = shadow.getElementById('review-comment')?.value || draft.note.comment;
    draft.allowWithoutImage = shadow.getElementById('allow-text')?.checked || false;
    state.busy = true; renderPanel();
    try {
      await send('SAVE', { note: draft.note, asset: draft.asset, revision: draft.note.revision, allowWithoutImage: draft.allowWithoutImage });
      state.draft = null; state.panel = null; state.mode = keepSelecting ? 'point' : 'browse'; operation++;
      await loadNotes(); renderPanel(); renderWidget(); renderMarkers(); toast(keepSelecting ? '已保存，继续点选下一处' : '已保存，下次访问可回看');
    } catch (error) { draft.error = error.message; }
    finally { state.busy = false; if (state.draft) renderPanel(true); }
  }
  async function peek(id) {
    if (state.draft) { toast('先保存或取消当前评注'); return; }
    const asset = await send('GET_ASSET', { id }); state.peek = { id, asset }; state.panel = 'peek'; renderPanel();
  }
  function locate(id) {
    const match = state.matches.get(id), note = state.notes.find(n => n.id === id);
    if (!note) return;
    if (match?.status !== 'found') { state.panel = 'notes'; renderPanel(); toast('原位置需要确认，可查看原画面'); return; }
    const r = markRect(note, match);
    if (note.type === 'region' && r) window.scrollBy({ top: r.top - innerHeight / 3, left: r.left < 0 ? r.left : 0, behavior: 'instant' });
    else if (note.type !== 'page') match.element.scrollIntoView({ block: 'center', behavior: 'instant' });
    peek(id).catch(error => toast(error.message));
  }
  async function action(event) {
    const button = event.target.closest('[data-action]'); if (!button) return;
    event.preventDefault(); event.stopPropagation(); const name = button.dataset.action;
    if (name === 'toggle' && performance.now() < suppressClick) return;
    if (state.busy) return;
    try {
      switch (name) {
        case 'toggle': state.panel = state.panel ? null : state.draft ? 'editor' : 'menu'; renderPanel(Boolean(state.draft)); renderWidget(); break;
        case 'minimize': await collapse(); break;
        case 'disable': if (state.draft?.note.comment.trim()) { state.panel = 'confirm-close'; renderPanel(); } else await send('DISABLE'); break;
        case 'discard-disable': state.draft = null; await send('DISABLE'); break;
        case 'resume-draft': state.panel = 'editor'; renderPanel(true); break;
        case 'point': enter('point'); break;
        case 'area': enter('area'); break;
        case 'page': if (state.draft) { state.panel = 'editor'; renderPanel(true); } else await begin('page', null, null); break;
        case 'finish': state.mode = 'browse'; state.hover = null; highlight(null); renderWidget(); renderMarkers(); renderPanel(); break;
        case 'markers': state.showMarkers = !state.showMarkers; renderMarkers(); renderPanel(); break;
        case 'notes': if (state.draft) { toast('先保存或取消当前评注'); break; } state.panel = 'notes'; state.mode = 'browse'; highlight(null); renderPanel(); renderMarkers(); break;
        case 'library': await send('OPEN_LIBRARY'); break;
        case 'kind': if (state.draft) { state.draft.note.kind = button.dataset.kind; shadow.querySelectorAll('.kind').forEach(el => el.classList.toggle('selected', el.dataset.kind === button.dataset.kind)); } break;
        case 'retry': if (state.draft) {
          const d = state.draft; d.note.viewport = viewport();
          if (d.target) {
            const r = d.target.getBoundingClientRect();
            d.rect = d.note.type === 'region' && d.note.region ? { left: r.left + r.width * d.note.region.x, top: r.top + r.height * d.note.region.y, width: r.width * d.note.region.w, height: r.height * d.note.region.h } : r;
          }
          d.note.state = interactionState(d.target); await snapshot(d);
        } break;
        case 'save': await save(false); break;
        case 'save-continue': await save(true); break;
        case 'cancel-draft': operation++; state.draft = null; state.panel = null; renderPanel(); break;
        case 'peek': await peek(button.dataset.id); break;
        case 'locate': locate(button.dataset.id); break;
        case 'edit': {
          const note = state.notes.find(n => n.id === button.dataset.id); if (!note) break;
          state.draft = { note: { ...note }, asset: await send('GET_ASSET', { id: note.id }) }; state.panel = 'editor'; renderPanel(true); break;
        }
        case 'rebind': state.rebind = button.dataset.id; enter('point'); break;
      }
    } catch (error) { toast(error.message); }
  }
  function orbDown(event) {
    const orb = event.target.closest('.orb'); if (!orb || event.button !== 0 || state.busy) return;
    const r = orb.getBoundingClientRect(); drag = { x: r.left, y: r.top, startX: event.clientX, startY: event.clientY, moved: false, el: orb };
    orb.setPointerCapture(event.pointerId);
  }
  function pointerDown(event) {
    if (own(event) || state.mode !== 'area' || event.button !== 0 || state.draft || state.busy) return;
    event.preventDefault(); event.stopImmediatePropagation(); regionDrag = { x: event.clientX, y: event.clientY };
    document.documentElement.setPointerCapture?.(event.pointerId);
  }
  function pointerMove(event) {
    if (drag) {
      const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) < 5 && !drag.moved) return;
      drag.moved = true; state.panel = null; shadow.getElementById('panel').replaceChildren(); positionWidget({ x: drag.x + dx, y: drag.y + dy }); return;
    }
    if (regionDrag) {
      highlight({ left: Math.min(regionDrag.x, event.clientX), top: Math.min(regionDrag.y, event.clientY), width: Math.abs(event.clientX - regionDrag.x), height: Math.abs(event.clientY - regionDrag.y) }); return;
    }
    if (own(event) || state.mode !== 'point' || state.draft || state.busy) return;
    const target = selectedTarget(event.target); if (target && target !== state.hover) { state.hover = target; highlight(target.getBoundingClientRect()); }
  }
  function cancelPointer() { drag = null; regionDrag = null; highlight(null); positionWidget(); }
  function pointerUp(event) {
    if (drag) {
      if (drag.moved) {
        const r = shadow.querySelector('.orb-wrap').getBoundingClientRect(); state.dock = { side: r.left + 24 < innerWidth / 2 ? 'left' : 'right', bottom: Math.max(16, innerHeight - r.bottom) };
        suppressClick = performance.now() + 400; send('SAVE_DOCK', { dock: state.dock }).catch(error => toast(error.message));
      }
      drag = null; positionWidget(); return;
    }
    if (!regionDrag) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const start = regionDrag; regionDrag = null; suppressClick = performance.now() + 300;
    const rect = { left: Math.min(start.x, event.clientX), top: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) };
    if (rect.width < 15 || rect.height < 15) { highlight(null); return; }
    let target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    while (target && target !== document.body) { const r = target.getBoundingClientRect(); if (r.left <= rect.left && r.top <= rect.top && r.right >= rect.left + rect.width && r.bottom >= rect.top + rect.height) break; target = target.parentElement; }
    target = target || document.body; const r = target.getBoundingClientRect();
    const region = { x: (rect.left - r.left) / r.width, y: (rect.top - r.top) / r.height, w: rect.width / r.width, h: rect.height / r.height };
    begin('region', target, rect, region).catch(error => toast(error.message));
  }
  function selectClick(event) {
    if (own(event)) return;
    if (performance.now() < suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (state.mode !== 'point' || state.draft || state.busy) return;
    const target = selectedTarget(event.target); if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (state.rebind) {
      const id = state.rebind; state.rebind = null; state.mode = 'browse'; highlight(null);
      send('REBIND', { id, anchor: descriptor(target), pageSignature: signature() }).then(() => { state.panel = 'notes'; return loadNotes(); }).catch(error => toast(error.message)); renderWidget(); return;
    }
    begin('element', target, target.getBoundingClientRect()).catch(error => toast(error.message));
  }
  function keyDown(event) {
    if (event.key === 'Escape') {
      if (state.busy) return;
      state.mode = 'browse'; state.panel = null; state.hover = null; state.rebind = null; regionDrag = null;
      highlight(null); renderPanel(); renderWidget(); renderMarkers();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && state.panel === 'editor') { event.preventDefault(); save(false); }
  }
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && ('enabled' in changes)) refresh(); });
  globalThis.__pageReviewController = { refresh };
  refresh();
})();
