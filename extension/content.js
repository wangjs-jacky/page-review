(function () {
  'use strict';
  if (globalThis.__pageReviewController) { globalThis.__pageReviewController.refresh(); return; }
  const Core = PageReviewCore;
  const I = {
    like: '<path d="M7 10v11H3V10h4Zm0 0 5-7c1-1 3 0 3 2l-1 5h5a2 2 0 0 1 2 2l-2 7a3 3 0 0 1-3 2H7"/>',
    dislike: '<path d="M7 14V3H3v11h4Zm0 0 5 7c1 1 3 0 3-2l-1-5h5a2 2 0 0 0 2-2l-2-7a3 3 0 0 0-3-2H7"/>',
    select: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8-5 3 7 2-4 4-2-7-3Z"/>',
    hide: '<path d="m3 3 18 18M9.5 5.3A12 12 0 0 1 12 5c6 0 10 7 10 7a20 20 0 0 1-4 4M6 6a22 22 0 0 0-4 6s4 7 10 7a12 12 0 0 0 5-1M10 10a3 3 0 0 0 4 4"/>',
    pin: '<path d="M19 10c0 5-7 11-7 11s-7-6-7-11a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
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
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || I.note}</svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const labels = { found: '已定位', uncertain: '位置待确认', missing: '原位置失效', changed: '页面已明显变化' };
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
    shadow.addEventListener('input', event => {
      if (event.target.id === 'review-comment' && state.draft) {
        state.draft.note.comment = event.target.value;
        updateComposer(); positionWidget();
      }
    }, options);
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
  function currentAnchor() {
    if (state.panel === 'editor' && state.draft) {
      const d = state.draft;
      if (d.note.type === 'page') return null;
      if (d.target?.isConnected) {
        const r = d.target.getBoundingClientRect(), area = d.note.region;
        return d.note.type === 'region' && area ? { left: r.left + r.width * area.x, top: r.top + r.height * area.y, width: r.width * area.w, height: r.height * area.h } : r;
      }
      return d.rect;
    }
    if (state.panel === 'peek' && state.peek) {
      const note = state.notes.find(note => note.id === state.peek.id), match = state.matches.get(state.peek.id);
      return note && match?.status === 'found' && note.type !== 'page' ? markRect(note, match) : null;
    }
    return null;
  }
  function schedulePosition() {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = null; positionWidget(); renderMarkers();
      const rect = currentAnchor();
      if (rect) highlight(rect, state.draft?.note.type === 'region' ? 0 : 5);
      else if (state.hover) highlight(state.hover.getBoundingClientRect());
    });
  }
  function dockPosition() {
    const y = Math.max(12, innerHeight - Math.max(16, state.dock.bottom) - 44);
    return { x: state.dock.side === 'left' ? 16 : Math.max(12, innerWidth - 60), y };
  }
  function positionWidget(raw) {
    if (!shadow) return;
    const wrap = shadow.querySelector('.orb-wrap'), panel = shadow.querySelector('.panel'); const p = raw || dockPosition();
    if (wrap) Object.assign(wrap.style, { left: Math.max(12, Math.min(innerWidth - 56, p.x)) + 'px', top: Math.max(12, Math.min(innerHeight - 56, p.y)) + 'px' });
    if (panel?.classList.contains('drawer')) return;
    if (panel?.classList.contains('popover')) {
      const rect = panel.getBoundingClientRect(), anchor = currentAnchor();
      const visible = anchor && anchor.top + anchor.height > 0 && anchor.top < innerHeight;
      const position = Core.placePopover(visible ? anchor : null, { width: innerWidth, height: innerHeight }, rect);
      Object.assign(panel.style, { left: position.left + 'px', top: position.top + 'px' });
    } else if (panel) {
      const rect = panel.getBoundingClientRect(), gap = 12;
      const left = Math.max(12, Math.min(state.dock.side === 'left' ? p.x + 56 : p.x - rect.width - gap, innerWidth - rect.width - 12));
      const top = Math.max(12, Math.min(p.y + 44 - rect.height, innerHeight - rect.height - 12));
      Object.assign(panel.style, { left: left + 'px', top: top + 'px' });
    }
  }
  function renderWidget() {
    if (!shadow) return;
    const active = state.mode !== 'browse';
    shadow.getElementById('widget').innerHTML = `<div class="orb-wrap"><button class="orb floating-orb ${active ? 'is-marking' : ''} ${state.dock.side === 'left' ? 'docked-left' : ''}" data-action="toggle" aria-label="打开网页评注" aria-expanded="${state.panel === 'menu'}" data-hint="${active ? '正在标注 · 点击切换方式' : '网页评注 · 拖动可换位置'}">${icon(active ? 'select' : 'pen')}${state.notes.length ? `<span class="orb-count">${state.notes.length}</span>` : ''}</button><button class="orb-close" data-action="disable" aria-label="关闭网页评注" title="关闭，点击 Chrome 插件图标重新启用">${icon('close')}</button></div>`;
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
      const button = document.createElement('button'); button.className = 'pin note-pin'; button.dataset.action = 'peek'; button.dataset.id = note.id; button.textContent = String(index + 1).padStart(2, '0'); button.setAttribute('aria-label', `查看评注 ${index + 1}：${note.label}`);
      Object.assign(button.style, { left: Math.max(4, Math.min(innerWidth - 29, r.left - 12 + count * 26)) + 'px', top: Math.max(4, r.top - 12) + 'px' }); markerRoot.append(button);
      if (note.type === 'region') { const box = document.createElement('div'); box.className = 'region region-saved'; Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); markerRoot.append(box); }
    });
  }
  function panelHead(title, subtitle = '') {
    return `<header class="orb-menu-head"><div><strong>${esc(title)}</strong>${subtitle ? `<span>${esc(subtitle)}</span>` : ''}</div><button class="icon-btn" data-action="minimize" aria-label="收起到右下角" title="收起到右下角">${icon('close')}</button></header>`;
  }
  function statusMarkup(status) {
    return `<span class="status-label ${status === 'found' ? '' : status === 'uncertain' ? 'warning' : 'stale'}">${icon(status === 'found' ? 'pin' : 'note')}${labels[status] || '位置待确认'}</span>`;
  }
  function feedbackMarkup(note) {
    return note.feedback ? `<span class="feedback-value ${note.feedback}" role="img" aria-label="${note.feedback === 'positive' ? '点赞' : '点踩'}">${icon(note.feedback === 'positive' ? 'like' : 'dislike')}</span>` : '';
  }
  function updateComposer() {
    const input = shadow?.getElementById('review-comment'); if (!input || !state.draft) return;
    input.style.height = 'auto'; input.style.height = Math.max(26, Math.min(144, input.scrollHeight)) + 'px';
    shadow.querySelectorAll('[data-action="feedback"]').forEach(button => { const selected = state.draft.note.feedback === button.dataset.feedback; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    const save = shadow.querySelector('.composer-submit'); if (save) save.disabled = state.busy || !(input.value.trim() || state.draft.note.feedback);
  }
  function renderPanel(focus = false) {
    if (!shadow) return;
    let html = '';
    if (state.panel === 'menu') {
      html = `<section class="panel orb-menu" role="dialog" aria-label="网页评注操作">
        ${panelHead('网页评注', `本页 ${state.notes.length} 条记录`)}
        ${state.mode !== 'browse' ? `<div class="orb-active-line"><span><i></i>${state.mode === 'area' ? '正在框选区域' : '正在点选对象'}</span><button data-action="finish">完成标注</button></div>` : ''}
        <div class="orb-pick-actions"><button class="btn primary" data-action="point">${icon('select')}开始标注</button><div class="orb-other-modes"><button data-action="area">${icon('area')}框选区域</button><button data-action="page">${icon('page')}整页评注</button></div></div>
        <div class="orb-menu-links"><button data-action="notes">${icon('note')}<span>本页评注</span><b>${state.notes.length}</b>${icon('arrow')}</button><button data-action="markers" aria-pressed="${state.showMarkers}">${icon(state.showMarkers ? 'eye' : 'hide')}<span>${state.showMarkers ? '显示页面标记' : '页面标记已隐藏'}</span><i class="orb-switch ${state.showMarkers ? 'checked' : ''}"></i></button><button data-action="library">${icon('book')}<span>全部保存的网页</span>${icon('arrow')}</button></div>
        <footer><span>可拖动贴边</span><button data-action="minimize">收起到右下角</button><button data-action="disable">关闭</button></footer>
      </section>`;
    } else if (state.panel === 'editor' && state.draft) {
      const d = state.draft, disabled = state.busy || !(d.note.comment.trim() || d.note.feedback);
      html = `<section class="panel editor popover compact-composer" role="dialog" aria-label="网页评论" aria-busy="${state.busy}">
        <div class="composer-row"><textarea id="review-comment" rows="1" aria-label="用户评论" placeholder="添加评论…" maxlength="12000">${esc(d.note.comment)}</textarea>
        <div class="feedback-actions" role="group" aria-label="可选反馈"><button class="feedback-button" data-action="feedback" data-feedback="positive" aria-label="点赞" title="点赞" aria-pressed="${d.note.feedback === 'positive'}">${icon('like')}</button><button class="feedback-button" data-action="feedback" data-feedback="negative" aria-label="点踩" title="点踩" aria-pressed="${d.note.feedback === 'negative'}">${icon('dislike')}</button></div>
        <button class="composer-submit" data-action="save" aria-label="保存评论" title="保存（Ctrl / ⌘ + Enter）" ${disabled ? 'disabled' : ''}>${icon('check')}</button><button class="composer-cancel" data-action="cancel-draft" aria-label="取消评论" title="取消">${icon('close')}</button></div>
        ${d.error ? `<div class="capture-error">${esc(d.error)}${!d.note.id && !d.asset && !state.busy ? '<button class="text-button" data-action="retry">重试截图</button>' : ''}</div>` : ''}
        ${!d.note.id && !d.asset && !state.busy ? `<label class="text-only"><input id="allow-text" type="checkbox" ${d.allowWithoutImage ? 'checked' : ''}>我已知缺少画面，仍然保存</label>` : ''}
      </section>`;
    } else if (state.panel === 'notes') {
      const missing = state.notes.filter(note => state.matches.get(note.id)?.status !== 'found').length;
      html = `<div class="drawer-backdrop" data-action="minimize"></div><aside class="panel notes-panel drawer" role="dialog" aria-modal="true" aria-label="本页评注">
        <header class="drawer-head"><div><h2>本页评注</h2><p>${esc(location.hostname)} · ${state.notes.length} 条已保存</p></div><button class="icon-btn" data-action="minimize" aria-label="关闭评注面板">${icon('close')}</button></header>
        <div class="drawer-content">${missing ? `<div class="drawer-banner">${missing} 条评注的原位置需要确认。原截图和评论仍保留。</div>` : ''}
        ${state.notes.length ? state.notes.map((note, index) => {
          const status = state.matches.get(note.id)?.status || 'missing';
          return `<article class="drawer-note"><div class="drawer-note-head"><span class="note-number">${String(index + 1).padStart(2, '0')}</span>${feedbackMarkup(note)}${statusMarkup(status)}</div>${note.comment ? `<p>${esc(note.comment)}</p>` : ''}<div class="drawer-note-actions"><button data-action="peek" data-id="${note.id}">查看原画面</button><button data-action="${status === 'found' ? 'locate' : 'rebind'}" data-id="${note.id}">${status === 'found' ? '回到网页' : '重新定位'}</button><button data-action="edit" data-id="${note.id}">编辑</button></div></article>`;
        }).join('') : `<div class="empty-state">${icon('pen')}<strong>留下一条自己的观察</strong><p>关于内容、路径、交互，或你想参考的地方。</p></div>`}</div>
        <footer class="drawer-footer"><button class="btn" data-action="library">${icon('book')}全部已保存网页</button><button class="btn primary" data-action="point">${icon('pen')}继续评注</button></footer>
      </aside>`;
    } else if (state.panel === 'peek' && state.peek) {
      const note = state.notes.find(note => note.id === state.peek.id);
      if (note) html = `<section class="panel editor popover" role="dialog" aria-label="查看已保存评注">
        <header class="popover-head">${feedbackMarkup(note)}<button class="icon-btn" data-action="close-popup" aria-label="关闭评注">${icon('close')}</button></header>
        <div class="saved-note-body">${esc(note.comment)}</div><div class="note-snapshot">${state.peek.asset?.viewport ? `<img class="snapshot-thumb" src="${state.peek.asset.viewport}" alt="记录时网页视口">` : '<p class="muted">此条记录没有画面。</p>'}<div class="snapshot-meta"><span>记录于 ${new Date(note.createdAt).toLocaleDateString('zh-CN')}</span>${statusMarkup(state.matches.get(note.id)?.status || 'missing')}</div></div>
        <footer class="popover-footer"><button class="btn small quiet" data-action="edit" data-id="${note.id}">编辑评注</button><button class="btn small" data-action="notes">查看本页全部 ${icon('arrow')}</button></footer>
      </section>`;
    } else if (state.panel === 'confirm-close') {
      html = `<section class="panel confirm-panel" role="dialog" aria-label="保留未保存评注">${panelHead('这条评注还没有保存')}<div class="confirm-body"><p>先保存，或者放弃这条输入后关闭。已经保存的记录不会删除。</p><div class="confirm-row"><button class="btn small" data-action="resume-draft">继续编辑</button><button class="btn small danger" data-action="discard-disable">放弃并关闭</button></div></div></section>`;
    }
    shadow.getElementById('panel').innerHTML = html; updateComposer(); positionWidget();
    const rect = currentAnchor();
    if (rect) highlight(rect, state.draft?.note.type === 'region' ? 0 : 5);
    else if (state.mode === 'browse') highlight(null);
    shadow.querySelectorAll('.snapshot-thumb').forEach(img => { if (!img.complete) img.addEventListener('load', () => positionWidget(), { once: true }); });
    if (focus && state.panel === 'editor') { const textarea = shadow.getElementById('review-comment'); textarea?.focus({ preventScroll: true }); textarea?.setSelectionRange(textarea.value.length, textarea.value.length); }
  }

  function toast(message) {
    if (!shadow) return;
    clearTimeout(toastTimer); shadow.getElementById('notifications').innerHTML = `<div class="toast" role="status">${esc(message)}</div>`;
    toastTimer = setTimeout(() => { shadow?.getElementById('notifications').replaceChildren(); }, 4500);
  }
  function highlight(rect, offset = 5) {
    if (!shadow) return;
    shadow.querySelector('.highlight')?.remove();
    if (!rect) return;
    const box = document.createElement('div'); box.className = 'highlight'; Object.assign(box.style, { left: (rect.left - offset) + 'px', top: (rect.top - offset) + 'px', width: (rect.width + offset * 2) + 'px', height: (rect.height + offset * 2) + 'px' }); shadow.getElementById('selection').append(box);
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
    draft.note.comment = shadow.getElementById('review-comment')?.value ?? draft.note.comment;
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
        case 'disable': if (state.draft && (state.draft.note.comment.trim() || state.draft.note.feedback)) { state.panel = 'confirm-close'; renderPanel(); } else await send('DISABLE'); break;
        case 'discard-disable': state.draft = null; await send('DISABLE'); break;
        case 'resume-draft': state.panel = 'editor'; renderPanel(true); break;
        case 'point': enter('point'); break;
        case 'area': enter('area'); break;
        case 'page': if (state.draft) { state.panel = 'editor'; renderPanel(true); } else await begin('page', null, null); break;
        case 'finish': state.mode = 'browse'; state.hover = null; highlight(null); renderWidget(); renderMarkers(); renderPanel(); break;
        case 'markers': state.showMarkers = !state.showMarkers; renderMarkers(); renderPanel(); break;
        case 'notes': if (state.draft) { toast('先保存或取消当前评注'); break; } state.panel = 'notes'; state.mode = 'browse'; highlight(null); renderPanel(); renderMarkers(); break;
        case 'library': await send('OPEN_LIBRARY'); break;
        case 'feedback': if (state.draft) { state.draft.note.feedback = state.draft.note.feedback === button.dataset.feedback ? null : button.dataset.feedback; updateComposer(); } break;
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
        case 'close-popup': state.peek = null; state.panel = null; renderPanel(); break;
        case 'peek': await peek(button.dataset.id); break;
        case 'locate': locate(button.dataset.id); break;
        case 'edit': {
          const note = state.notes.find(n => n.id === button.dataset.id); if (!note) break;
          const match = state.matches.get(note.id);
          state.draft = { note: { ...note }, asset: await send('GET_ASSET', { id: note.id }), target: match?.element || null, rect: match?.status === 'found' ? markRect(note, match) : null }; state.panel = 'editor'; renderPanel(true); break;
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
      drag.moved = true; drag.el.classList.add('is-dragging'); drag.el.setAttribute('aria-expanded', 'false'); state.panel = null; shadow.getElementById('panel').replaceChildren(); positionWidget({ x: drag.x + dx, y: drag.y + dy }); return;
    }
    if (regionDrag) {
      highlight({ left: Math.min(regionDrag.x, event.clientX), top: Math.min(regionDrag.y, event.clientY), width: Math.abs(event.clientX - regionDrag.x), height: Math.abs(event.clientY - regionDrag.y) }, 0); return;
    }
    if (own(event) || state.mode !== 'point' || state.draft || state.busy) return;
    const target = selectedTarget(event.target); if (target && target !== state.hover) { state.hover = target; highlight(target.getBoundingClientRect()); }
  }
  function cancelPointer() { drag?.el.classList.remove('is-dragging'); drag = null; regionDrag = null; highlight(null); positionWidget(); }
  function pointerUp(event) {
    if (drag) {
      drag.el.classList.remove('is-dragging');
      if (drag.moved) {
        const r = shadow.querySelector('.orb-wrap').getBoundingClientRect(); state.dock = { side: r.left + 22 < innerWidth / 2 ? 'left' : 'right', bottom: Math.max(16, innerHeight - r.bottom) };
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
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && state.panel === 'editor') { event.preventDefault(); save(event.shiftKey && !state.draft?.note.id); }
  }
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && ('enabled' in changes)) refresh(); });
  globalThis.__pageReviewController = { refresh };
  refresh();
})();
