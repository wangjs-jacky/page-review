(function () {
  'use strict';
  const Core = PageReviewCore, app = document.getElementById('app'), dialog = document.getElementById('detail-dialog');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { notes: [], selected: new Set(), view: 'library', query: '', filter: 'all', task: '', detail: null, editing: null, deleting: null, busy: false };
  const assets = new Map(); let renderId = 0, toastTimer;
  const statusLabels = { found: '最近可定位', uncertain: '位置待确认', missing: '原位置失效', changed: '页面已明显变化' };
  const outcomes = { pending: '未决定', adopted: '已采纳', rejected: '不采用' };
  async function send(type, payload = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(result?.error || '无法读取插件数据，请重新打开'); return result.value;
  }
  async function asset(id) { if (!assets.has(id)) assets.set(id, await send('GET_ASSET', { id })); return assets.get(id); }
  function groupNotes() {
    const groups = new Map();
    for (const note of state.notes) {
      if (!groups.has(note.pageId)) groups.set(note.pageId, { id: note.pageId, title: note.title, url: note.url, notes: [] });
      groups.get(note.pageId).notes.push(note);
    }
    return [...groups.values()];
  }
  function visibleGroups() {
    const query = state.query.trim().toLowerCase();
    return groupNotes().filter(group => (!query || [group.title, group.url, ...group.notes.map(note => note.comment)].join(' ').toLowerCase().includes(query)) && (state.filter !== 'attention' || group.notes.some(note => note.locationStatus !== 'found')));
  }
  const selectedNotes = () => state.notes.filter(note => state.selected.has(note.id));
  function selectionText() { const notes = selectedNotes(); return `已选 <strong>${new Set(notes.map(n => n.pageId)).size}</strong> 个网页，<strong>${notes.length}</strong> 条评注`; }
  function footer() { return `<div class="selection-footer"><span>${selectionText()}</span><button class="link-button" data-action="clear">清空选择</button><span class="spacer"></span><button class="button primary" data-action="ai" ${state.selected.size ? '' : 'disabled'}>准备给 AI →</button></div>`; }
  function card(group) {
    const chosen = group.notes.every(note => state.selected.has(note.id)), missing = group.notes.filter(note => note.locationStatus !== 'found').length;
    return `<article class="card ${chosen ? 'chosen' : ''}"><div class="card-image" data-thumbnail="${group.notes.find(n => n.hasImage)?.id || ''}"><span class="placeholder">↗</span></div><input class="card-select" type="checkbox" aria-label="选择 ${esc(group.title || new URL(group.url).hostname)} 的全部评注" data-page-select="${esc(group.id)}" ${chosen ? 'checked' : ''}><button class="card-body" data-action="detail" data-page="${esc(group.id)}"><div class="source">${esc(new URL(group.url).hostname)}</div><h3>${esc(group.title || group.url)}</h3><p class="excerpt">${esc(group.notes[0].comment)}</p><div class="card-meta"><span>${group.notes.length} 条评注</span><span class="${missing ? 'warning' : ''}">${missing ? `${missing} 条位置待确认` : '可原页回看'}</span></div></button></article>`;
  }
  function renderLibrary() {
    const groups = visibleGroups(), total = groupNotes().length, attention = state.notes.filter(n => n.locationStatus !== 'found').length;
    app.innerHTML = `<header class="page-head"><div><h1>保存的网页</h1><p class="lead">把关注的地方留下来，等需要时一起交给 AI。</p></div><input class="search" id="search" type="search" aria-label="搜索网页或评注" placeholder="搜索标题、网站或评注内容" value="${esc(state.query)}"></header><div class="tools"><div class="filters"><button class="filter ${state.filter === 'all' ? 'active' : ''}" data-action="filter" data-filter="all">全部网页 <span class="count-tag">${total}</span></button><button class="filter ${state.filter === 'attention' ? 'active' : ''}" data-action="filter" data-filter="attention">位置待确认 <span class="count-tag">${attention}</span></button></div><button class="link-button" data-action="select-visible">选择当前结果</button></div>${state.notes.length ? `<div class="grid">${groups.map(card).join('')}</div>${!groups.length ? '<div id="search-empty" class="empty">没有匹配的网页或评注。</div>' : ''}` : '<div class="empty"><h2>从正常浏览的网页开始</h2><p>点击 Chrome 工具栏中的 Page Review 图标启用，在网页右下角的小球中选择标注。保存的评注会出现在这里。</p><p>评论与画面保存在当前浏览器，不会自动上传。</p></div>'}${footer()}`;
    loadImages(app);
  }
  function readingNote(note) {
    const outcome = note.outcome;
    return `<article class="reading-note"><h4>${esc(note.id.slice(0, 8).toUpperCase())} · ${esc(note.label)} · ${statusLabels[note.locationStatus] || '尚未检查'}</h4><p>${esc(note.comment)}</p>${note.anchor?.text ? `<details><summary class="small">当时选中的网页内容</summary><blockquote>${esc(note.anchor.text)}</blockquote></details>` : ''}${note.hasImage ? `<img class="snapshot" data-image="${note.id}" alt="记录时画面"><div class="snapshot-caption">记录时视口 · ${new Date(note.capturedAt || note.createdAt).toLocaleString()}</div>` : `<p class="small">此条没有保存画面：${esc(note.screenshotError || '仅文字评注')}</p>`}${outcome && outcome.status !== 'pending' ? `<p class="outcome">后续结果：${outcomes[outcome.status]}${outcome.reason ? ` · ${esc(outcome.reason)}` : ''}</p>` : ''}</article>`;
  }
  function renderAI() {
    const notes = selectedNotes(), pageIds = new Set(notes.map(note => note.pageId));
    app.innerHTML = `<button class="link-button back" data-action="library">← 返回选择网页</button><header class="page-head"><div><h1>把关注点，一起交给 AI</h1><p class="lead">你的原始评注、来源和对应画面会放在一起。</p></div></header><div class="ai-grid"><aside class="task-card"><label for="ai-task">这次希望 AI 做什么？</label><textarea id="ai-task" placeholder="例如：比较这些网页的内容组织，给我的内容页一些建议。">${esc(state.task)}</textarea><div class="summary"><div><span>选中的网页</span><strong>${pageIds.size} 个</strong></div><div><span>原始评注</span><strong>${notes.length} 条</strong></div><div><span>附有画面</span><strong>${notes.filter(n => n.hasImage).length} 条</strong></div><div><span>位置需要确认</span><strong>${notes.filter(n => n.locationStatus !== 'found').length} 条</strong></div></div><button class="button primary" data-action="download" ${notes.length ? '' : 'disabled'}>下载 AI 阅读包</button><button class="button" data-action="copy" ${notes.length ? '' : 'disabled'}>复制阅读说明</button><p class="fine">阅读包含 Markdown、JSON 与原始图片。将 ZIP 解压到 Agent 可读取的目录，或把材料作为附件交给 AI。复制文字不会自动附上图片。</p></aside><section class="paper"><header class="paper-head"><span>AI 阅读材料预览</span><span>${pageIds.size} 个来源 · ${notes.length} 条评注</span></header><div class="paper-body"><div class="paper-kicker">MY WEB ANNOTATIONS</div><h2>围绕我关注的地方阅读</h2><p class="task-text" id="task-preview">${esc(state.task || '请阅读下列原始评注和对应画面。')}</p>${groupNotes().filter(group => pageIds.has(group.id)).map(group => `<section class="reading-page"><h3>${esc(group.title || group.url)}</h3><div class="source">${esc(group.url)}</div>${group.notes.filter(note => state.selected.has(note.id)).map(readingNote).join('')}</section>`).join('')}</div></section></div>`;
    loadImages(app);
  }
  async function loadImages(root) {
    const version = renderId;
    for (const el of root.querySelectorAll('[data-image],[data-thumbnail]')) {
      const id = el.dataset.image || el.dataset.thumbnail; if (!id) continue;
      asset(id).then(image => {
        if (version !== renderId || !el.isConnected || !image?.viewport) return;
        if (el.matches('img')) el.src = image.viewport;
        else { const img = document.createElement('img'); img.src = image.viewport; img.alt = '记录时网页画面'; el.replaceChildren(img); }
      }).catch(error => { if (el.isConnected) el.setAttribute('title', error.message); });
    }
  }
  function render() { renderId++; if (state.view === 'ai') renderAI(); else renderLibrary(); }
  async function reload() {
    state.notes = await send('LIST');
    const existing = new Set(state.notes.map(note => note.id)); state.selected = new Set([...state.selected].filter(id => existing.has(id)));
    render();
  }
  function renderDetail() {
    const group = groupNotes().find(group => group.id === state.detail); if (!group) { dialog.close(); return; }
    dialog.innerHTML = `<header class="detail-heading"><div><div class="source">${esc(new URL(group.url).hostname)}</div><h2>${esc(group.title || group.url)}</h2><p>勾选想交给 AI 的评注，可保留同页其他内容。</p></div><button class="close" data-action="close-detail" aria-label="关闭详情">×</button></header>${group.notes.map(note => `<article class="detail-note" data-detail-note="${note.id}"><div class="detail-title"><label><input type="checkbox" data-note-select="${note.id}" ${state.selected.has(note.id) ? 'checked' : ''}>${esc(note.label)}</label><span class="small ${note.locationStatus === 'found' ? '' : 'warning'}">${statusLabels[note.locationStatus] || '尚未检查'}</span></div>${state.editing === note.id ? `<textarea data-edit-comment="${note.id}" aria-label="编辑评注内容" maxlength="12000">${esc(note.comment)}</textarea><div class="edit-actions"><button class="button" data-action="cancel-edit">取消编辑</button><button class="button primary" data-action="save-edit" data-id="${note.id}">保存修改</button></div>` : `<p class="note-text">${esc(note.comment)}</p>`}${note.hasImage ? `<img class="snapshot" data-image="${note.id}" alt="记录时网页视口">` : '<p class="small">这条评注没有保存画面。</p>'}<div class="actions"><button class="link-button" data-action="open" data-id="${note.id}">打开原网页并定位</button><button class="link-button" data-action="edit" data-id="${note.id}">编辑原话</button><button class="link-button warning" data-action="delete" data-id="${note.id}">删除</button></div><details class="outcome-editor"><summary>记录后续结果${note.outcome && note.outcome.status !== 'pending' ? ` · ${outcomes[note.outcome.status]}` : ''}</summary><select data-outcome="${note.id}" aria-label="采纳结果">${Object.entries(outcomes).map(([key, label]) => `<option value="${key}" ${key === (note.outcome?.status || 'pending') ? 'selected' : ''}>${label}</option>`).join('')}</select><textarea data-reason="${note.id}" aria-label="采纳或不采用的理由" placeholder="为什么采纳或不采用？有什么适用条件？" maxlength="4000">${esc(note.outcome?.reason || '')}</textarea><button class="link-button" data-action="save-outcome" data-id="${note.id}">保存结果</button></details>${note.history?.length ? `<details class="history"><summary>查看修改前的原话（${note.history.length}次）</summary>${note.history.map(item => `<p>${esc(item.comment)}<br><small>${new Date(item.at).toLocaleString()}</small></p>`).join('')}</details>` : ''}</article>`).join('')}<footer class="dialog-actions"><span class="small">${selectionText()}</span><button class="button primary" data-action="detail-ai" ${state.selected.size ? '' : 'disabled'}>准备给 AI →</button></footer>`;
    loadImages(dialog);
  }
  function toast(message) { clearTimeout(toastTimer); const node = document.getElementById('toast'); node.textContent = message; node.classList.add('visible'); toastTimer = setTimeout(() => node.classList.remove('visible'), 4500); }
  async function packageSelected() {
    const notes = selectedNotes(), images = {};
    for (const note of notes) if (note.hasImage) images[note.id] = await asset(note.id);
    return Core.readingPackage(notes, images, state.task);
  }
  function download(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  document.addEventListener('input', event => {
    if (event.target.id === 'search') {
      state.query = event.target.value;
      const grid = document.querySelector('.grid');
      if (grid) {
        const groups = visibleGroups(); grid.innerHTML = groups.map(card).join('');
        let empty = document.getElementById('search-empty');
        if (!groups.length && !empty) { empty = document.createElement('div'); empty.id = 'search-empty'; empty.className = 'empty'; empty.textContent = '没有匹配的网页或评注。'; grid.after(empty); }
        if (groups.length) empty?.remove();
        loadImages(grid);
      }
    }
    if (event.target.id === 'ai-task') { state.task = event.target.value; document.getElementById('task-preview').textContent = state.task; chrome.storage.local.set({ readingTask: state.task }).catch(error => toast(error.message)); }
  });
  document.addEventListener('change', event => {
    if (event.target.dataset.pageSelect) {
      const group = groupNotes().find(group => group.id === event.target.dataset.pageSelect);
      for (const note of group.notes) event.target.checked ? state.selected.add(note.id) : state.selected.delete(note.id);
      render();
    }
    if (event.target.dataset.noteSelect) {
      event.target.checked ? state.selected.add(event.target.dataset.noteSelect) : state.selected.delete(event.target.dataset.noteSelect);
      render();
      const footer = dialog.querySelector('.dialog-actions');
      if (footer) { footer.querySelector('.small').innerHTML = selectionText(); footer.querySelector('[data-action="detail-ai"]').disabled = !state.selected.size; }
    }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]'); if (!button || state.busy) return;
    event.preventDefault(); const action = button.dataset.action, id = button.dataset.id;
    try {
      switch (action) {
        case 'filter': state.filter = button.dataset.filter; render(); break;
        case 'select-visible': for (const group of visibleGroups()) for (const note of group.notes) state.selected.add(note.id); render(); break;
        case 'clear': state.selected.clear(); render(); break;
        case 'ai': state.view = 'ai'; render(); window.scrollTo(0, 0); break;
        case 'library': state.view = 'library'; render(); window.scrollTo(0, 0); break;
        case 'detail': state.detail = button.dataset.page; state.editing = null; renderDetail(); dialog.showModal(); break;
        case 'close-detail': if (state.editing) { toast('先保存修改或取消编辑'); break; } dialog.close(); break;
        case 'detail-ai': if (state.editing) { toast('先保存修改或取消编辑'); break; } dialog.close(); state.view = 'ai'; render(); break;
        case 'open': await send('OPEN_NOTE', { id }); break;
        case 'edit': if (state.editing && state.editing !== id) { toast('先保存当前修改'); break; } state.editing = id; renderDetail(); dialog.querySelector('[data-edit-comment]')?.focus(); break;
        case 'cancel-edit': state.editing = null; renderDetail(); break;
        case 'save-edit': {
          const note = state.notes.find(note => note.id === id), comment = dialog.querySelector(`[data-edit-comment="${id}"]`).value;
          await send('SAVE', { note: { ...note, comment }, revision: note.revision }); state.editing = null; await reload(); renderDetail(); toast('已保存修改，原话历史和画面仍保留'); break;
        }
        case 'save-outcome': {
          await send('SET_OUTCOME', { id, status: dialog.querySelector(`[data-outcome="${id}"]`).value, reason: dialog.querySelector(`[data-reason="${id}"]`).value }); await reload(); renderDetail(); toast('后续结果已保存'); break;
        }
        case 'delete': state.deleting = id; document.getElementById('delete-dialog').showModal(); break;
        case 'download': {
          state.busy = true; button.disabled = true; button.textContent = '正在整理画面…';
          const pack = await packageSelected(); download(pack.bytes, `网页评注-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip'); toast(`已生成 ${pack.manifest.pages.length} 页 ${pack.manifest.annotations.length} 条评注的阅读包`); break;
        }
        case 'copy': {
          const notes = selectedNotes();
          const text = `本次任务：${state.task || '阅读以下网页评注'}\n\n${notes.map(n => `[${n.id}] ${n.title}\n${n.url}\n${n.comment}`).join('\n\n')}\n\n注意：复制文本没有携带图片；请同时提供解压后的阅读包文件。`;
          await navigator.clipboard.writeText(text); toast('已复制说明，图片请随阅读包提供'); break;
        }
      }
    } catch (error) { toast(error.message); }
    finally { if (state.busy) { state.busy = false; button.disabled = false; if (action === 'download') button.textContent = '下载 AI 阅读包'; } }
  });
  dialog.addEventListener('cancel', event => { if (state.editing) { event.preventDefault(); toast('先保存修改或取消编辑'); } });
  document.getElementById('cancel-delete').addEventListener('click', () => document.getElementById('delete-dialog').close());
  document.getElementById('confirm-delete').addEventListener('click', async () => {
    try { await send('DELETE', { id: state.deleting }); assets.delete(state.deleting); state.selected.delete(state.deleting); document.getElementById('delete-dialog').close(); await reload(); renderDetail(); toast('已删除这条评注及画面'); } catch (error) { toast(error.message); }
  });
  async function start() {
    try { state.task = (await chrome.storage.local.get('readingTask')).readingTask || ''; await reload(); }
    catch (error) { app.innerHTML = `<div class="error-box">${esc(error.message || '请从 Chrome 扩展中打开保存库。')}</div>`; }
  }
  start();
})();
