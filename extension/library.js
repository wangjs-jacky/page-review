(function () {
  'use strict';
  const Core = PageReviewCore, app = document.getElementById('app'), dialog = document.getElementById('detail-dialog');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icons = { note: '<path d="M4 3h16v14l-4 4H4Zm12 14v4M8 8h8M8 12h6"/>', check: '<path d="m5 12 4 4L19 6"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', back: '<path d="M19 12H5m5-5-5 5 5 5"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>', download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>', copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>', pin: '<path d="M19 10c0 5-7 11-7 11s-7-6-7-11a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/>', page: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a19 19 0 0 0 0 18 19 19 0 0 0 0-18Z"/>' };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.note}</svg>`;
  icons.like = '<path d="M7 10v11H3V10h4Zm0 0 5-7c1-1 3 0 3 2l-1 5h5a2 2 0 0 1 2 2l-2 7a3 3 0 0 1-3 2H7"/>';
  icons.dislike = '<path d="M7 14V3H3v11h4Zm0 0 5 7c1 1 3 0 3-2l-1-5h5a2 2 0 0 0 2-2l-2-7a3 3 0 0 0-3-2H7"/>';
  const feedbackText = note => note.feedback === 'positive' ? '👍 喜欢' : note.feedback === 'negative' ? '👎 不喜欢' : '未评价';
  const feedbackMarkup = note => note.feedback ? `<span class="feedback-value ${note.feedback}" role="img" aria-label="${feedbackText(note)}">${icon(note.feedback === 'positive' ? 'like' : 'dislike')}</span>` : '';
  const state = { notes: [], selected: new Set(), view: 'library', query: '', filter: 'all', task: '', detail: null, editing: null, editingFeedback: null, deleting: null, busy: false, preview: null };
  const assets = new Map(); let toastTimer;
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
  function footer() {
    return `<div class="selection-footer collection-footer"><span class="selection-count">${selectionText()}</span><button class="link-button text-button" data-action="clear">清空选择</button><button class="button btn primary" data-action="ai" ${state.selected.size ? '' : 'disabled'}>准备给 AI ${icon('arrow')}</button></div>`;
  }
  function statusMarkup(note) {
    const found = note.locationStatus === 'found';
    return `<span class="status-label ${found ? '' : 'warning'}">${icon('pin')}${statusLabels[note.locationStatus] || '尚未检查'}</span>`;
  }
  function card(group) {
    const chosen = group.notes.every(note => state.selected.has(note.id)), missing = group.notes.filter(note => note.locationStatus !== 'found').length, host = new URL(group.url).hostname;
    return `<article class="card page-card ${chosen ? 'chosen selected' : ''}"><div class="card-image card-art" data-thumbnail="${group.notes.find(note => note.hasImage)?.id || ''}"><span class="placeholder">↗</span></div><label class="card-select"><input type="checkbox" aria-label="选择 ${esc(group.title || host)} 的全部评注" data-page-select="${esc(group.id)}" ${chosen ? 'checked' : ''}>${icon('check')}</label><button class="card-body" data-action="detail" data-page="${esc(group.id)}"><div class="source card-source"><span class="favicon">${esc(host[0].toLowerCase())}</span>${esc(host)}</div><h2>${esc(group.title || group.url)}</h2><p class="excerpt card-excerpt">${feedbackMarkup(group.notes[0])}${esc(group.notes[0].comment)}</p><div class="card-meta card-foot"><span>${group.notes.length} 条评注</span>${missing ? `<span class="warning">${missing} 条位置待确认</span>` : `<span>${icon('pin')} 可原页回看</span>`}</div></button></article>`;
  }
  function renderLibrary() {
    const groups = visibleGroups(), total = groupNotes().length, attention = state.notes.filter(note => note.locationStatus !== 'found').length;
    app.className = 'library-shell';
    app.innerHTML = `<div class="library-top"><span class="mini-logo">${icon('note')}</span>网页评注 <span>／</span> 保存在这个浏览器</div>
      <header class="page-head library-header"><div><h1>保存的网页</h1><p>把关注的地方留下来，等需要时一起交给 AI。</p></div><label class="search-field">${icon('search')}<input class="search" id="search" type="search" aria-label="搜索网页或评注" placeholder="搜索标题、网站或评注内容" value="${esc(state.query)}"></label></header>
      <div class="tools library-tools"><div class="filters filter-tabs"><button class="filter ${state.filter === 'all' ? 'active' : ''}" data-action="filter" data-filter="all">全部网页 <span class="tiny-count">${total}</span></button><button class="filter ${state.filter === 'attention' ? 'active' : ''}" data-action="filter" data-filter="attention">位置待确认 <span class="tiny-count">${attention}</span></button></div><button class="link-button text-button" data-action="select-visible">选择当前结果</button></div>
      ${state.notes.length ? `<div class="grid library-grid">${groups.map(card).join('')}</div>${!groups.length ? '<div id="search-empty" class="empty-state">没有匹配的网页或评注。</div>' : ''}<p class="library-note">点开网页卡片可查看原评注，也可以只选其中几条。</p>` : `<div class="empty-state library-empty">${icon('note')}<strong>从正常浏览的网页开始</strong><p>点击 Chrome 工具栏图标启用，从网页右下角的小球开始标注。<br>保存的评注和画面会出现在这里。</p></div>`}${footer()}`;
    loadImages(app);
  }
  function readingNote(note) {
    const outcome = note.outcome;
    return `<article class="reading-note document-note"><header class="document-note-header"><span>${esc(note.id.slice(0, 8).toUpperCase())}</span>${feedbackMarkup(note)}${statusMarkup(note)}</header>${note.comment ? `<p>“${esc(note.comment)}”</p>` : ''}${note.hasImage ? `<img class="snapshot" data-image="${note.id}" alt="记录时画面"><div class="snapshot-caption snapshot-meta"><span>记录时画面 · ${new Date(note.capturedAt || note.createdAt).toLocaleDateString('zh-CN')}</span></div>` : `<p class="small">此条没有保存画面：${esc(note.screenshotError || '未附画面')}</p>`}${note.anchor?.text ? `<details class="note-source"><summary>当时选中的网页内容</summary><blockquote>${esc(note.anchor.text)}</blockquote></details>` : ''}${outcome && outcome.status !== 'pending' ? `<p class="reading-outcome">后续结果：${outcomes[outcome.status]}${outcome.reason ? ` · ${esc(outcome.reason)}` : ''}</p>` : ''}</article>`;
  }
  function renderAI() {
    const notes = selectedNotes(), pageIds = new Set(notes.map(note => note.pageId));
    app.className = 'ai-shell';
    app.innerHTML = `<button class="link-button back back-link" data-action="library">${icon('back')}返回选择网页</button>
      <header class="ai-top"><h1>把关注点，一起交给 AI</h1><p>先说这次想做什么，再带上你的原始评注和对应画面。</p></header>
      <div class="ai-grid ai-layout"><aside class="task-card ai-settings"><label class="field-label" for="ai-task">这次希望 AI 做什么？</label><textarea id="ai-task" placeholder="例如：比较这些网站的资料查找路径，给我的内容页一些建议。">${esc(state.task)}</textarea><div class="task-examples"><button data-action="task-example" data-example="compare">比较设计取舍</button><button data-action="task-example" data-example="apply">结合我的项目</button></div><div class="summary ai-summary"><div class="summary-line"><span>选中的网页</span><strong>${pageIds.size} 个</strong></div><div class="summary-line"><span>原始评注</span><strong>${notes.length} 条</strong></div><div class="summary-line"><span>附有画面</span><strong>${notes.filter(note => note.hasImage).length} 条</strong></div><div class="summary-line"><span>位置需要确认</span><strong>${notes.filter(note => note.locationStatus !== 'found').length} 条</strong></div></div><div class="ai-actions"><button class="button btn primary" data-action="download" ${notes.length ? '' : 'disabled'}>${icon('download')}下载阅读包</button><button class="button btn" data-action="copy" ${notes.length ? '' : 'disabled'}>${icon('copy')}复制阅读说明</button></div><p class="fine ai-note">阅读包包含原评注、来源与对应图片。复制说明后，仍需把图片随材料交给 AI。</p></aside>
      <section class="paper reading-document"><header class="paper-head document-top"><span>${icon('note')} AI 阅读材料预览</span><span>${pageIds.size} 个来源 · ${notes.length} 条评注</span></header><div class="paper-body document-body"><div class="paper-kicker eyebrow">MY WEB ANNOTATIONS</div><h2>围绕我关注的地方阅读</h2><p class="task-text document-task" id="task-preview">${esc(state.task || '请先填写这次希望 AI 做什么。')}</p>${groupNotes().filter(group => pageIds.has(group.id)).map((group, index) => `<section class="reading-page document-page"><h3>${String(index + 1).padStart(2, '0')} ／ ${esc(group.title || group.url)}</h3><div class="source document-page-url">${esc(group.url)}</div>${group.notes.filter(note => state.selected.has(note.id)).map(readingNote).join('')}</section>`).join('')}<div class="document-foot">请区分我的原始评注和你的推断，并用评注编号引用依据。位置失效的内容只代表记录时状态；必要时再核对当前网页。</div></div></section></div>`;
    loadImages(app);
  }

  async function loadImages(root) {
    for (const el of root.querySelectorAll('[data-image],[data-thumbnail]')) {
      const id = el.dataset.image || el.dataset.thumbnail; if (!id) continue;
      asset(id).then(image => {
        if (!el.isConnected || !image?.viewport) return;
        if (el.matches('img')) el.src = image.viewport;
        else { const img = document.createElement('img'); img.src = image.viewport; img.alt = '记录时网页画面'; el.replaceChildren(img); }
      }).catch(error => { if (el.isConnected) el.setAttribute('title', error.message); });
    }
  }
  function render() { if (state.view === 'ai') renderAI(); else renderLibrary(); }
  async function reload() {
    state.notes = await send('LIST');
    const existing = new Set(state.notes.map(note => note.id)); state.selected = new Set([...state.selected].filter(id => existing.has(id)));
    render();
  }
  function renderDetail() {
    const group = groupNotes().find(group => group.id === state.detail);
    if (!group) { dialog.close(); return; }
    const scrollTop = dialog.querySelector('.drawer-content')?.scrollTop || 0, hero = group.notes.find(note => note.hasImage);
    dialog.innerHTML = `<header class="drawer-head"><div class="dialog-heading-title"><h2>${esc(group.title || new URL(group.url).hostname)}</h2><p>${esc(new URL(group.url).hostname)} · ${group.notes.length} 条已保存</p></div><button class="icon-btn" data-action="close-detail" aria-label="关闭详情">${icon('close')}</button></header><div class="selected-counter">勾选想交给 AI 的评注，可保留同页其他内容。</div>
      <div class="drawer-content">${hero ? `<div class="detail-hero"><img data-image="${hero.id}" alt="记录时网页画面"></div>` : ''}${group.notes.map((note, index) => `<article class="detail-note drawer-note" data-detail-note="${note.id}"><div class="note-select-line"><input type="checkbox" aria-label="选择评注 ${esc(note.label)}" data-note-select="${note.id}" ${state.selected.has(note.id) ? 'checked' : ''}><div><div class="detail-title drawer-note-head"><span class="note-number">${String(index + 1).padStart(2, '0')}</span>${state.editing === note.id ? '' : feedbackMarkup(note)}${statusMarkup(note)}</div>
        ${state.editing === note.id ? `<textarea class="edit-comment" data-edit-comment="${note.id}" aria-label="编辑评注内容" maxlength="12000">${esc(note.comment)}</textarea><div class="edit-actions"><div class="feedback-actions" role="group" aria-label="可选反馈">${['positive', 'negative'].map(value => `<button class="feedback-button ${state.editingFeedback === value ? 'selected' : ''}" data-action="edit-feedback" data-feedback="${value}" aria-label="${value === 'positive' ? '点赞' : '点踩'}" title="${value === 'positive' ? '点赞' : '点踩'}" aria-pressed="${state.editingFeedback === value}">${icon(value === 'positive' ? 'like' : 'dislike')}</button>`).join('')}</div><button class="button btn small" data-action="cancel-edit">取消编辑</button><button class="button btn primary small" data-action="save-edit" data-id="${note.id}">保存修改</button></div>` : `<p class="note-text">${esc(note.comment)}</p>`}
        <div class="actions drawer-note-actions"><button data-action="preview" data-id="${note.id}">查看原画面</button><button data-action="open" data-id="${note.id}">回到网页</button><button data-action="edit" data-id="${note.id}">编辑</button><button data-action="delete" data-id="${note.id}">删除</button></div>
        ${state.preview === note.id ? `<div class="note-preview">${note.hasImage ? `<img data-image="${note.id}" alt="该条评注记录时的网页视口">` : '<p class="small">这条记录没有保存画面。</p>'}</div>` : ''}
        <details class="outcome-editor"><summary>记录后续结果${note.outcome && note.outcome.status !== 'pending' ? ` · ${outcomes[note.outcome.status]}` : ''}</summary><select data-outcome="${note.id}" aria-label="采纳结果">${Object.entries(outcomes).map(([key, label]) => `<option value="${key}" ${key === (note.outcome?.status || 'pending') ? 'selected' : ''}>${label}</option>`).join('')}</select><textarea data-reason="${note.id}" aria-label="采纳或不采用的理由" placeholder="为什么采纳或不采用？有什么适用条件？" maxlength="4000">${esc(note.outcome?.reason || '')}</textarea><button class="text-button" data-action="save-outcome" data-id="${note.id}">保存结果</button></details>
        ${note.history?.length ? `<details class="history"><summary>查看修改前的原话（${note.history.length}次）</summary>${note.history.map(item => `<p>${feedbackMarkup(item)}${esc(item.comment)}<br><small>${new Date(item.at).toLocaleString()}</small></p>`).join('')}</details>` : ''}</div></div></article>`).join('')}</div>
      <footer class="dialog-actions drawer-footer"><button class="button btn" data-action="open" data-id="${group.notes[0].id}">${icon('page')}打开原网页</button><button class="button btn primary" data-action="detail-ai" ${state.selected.size ? '' : 'disabled'}>准备给 AI ${icon('arrow')}</button></footer>`;
    dialog.querySelector('.drawer-content').scrollTop = scrollTop;
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
        if (!groups.length && !empty) { empty = document.createElement('div'); empty.id = 'search-empty'; empty.className = 'empty-state'; empty.textContent = '没有匹配的网页或评注。'; grid.after(empty); }
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
      if (footer) footer.querySelector('[data-action="detail-ai"]').disabled = !state.selected.size;
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
        case 'detail': state.detail = button.dataset.page; state.editing = null; state.preview = null; renderDetail(); dialog.showModal(); break;
        case 'close-detail': if (state.editing) { toast('先保存修改或取消编辑'); break; } dialog.close(); break;
        case 'detail-ai': if (state.editing) { toast('先保存修改或取消编辑'); break; } dialog.close(); state.view = 'ai'; render(); break;
        case 'open': await send('OPEN_NOTE', { id }); break;
        case 'preview': if (state.editing) { toast('先保存修改或取消编辑'); break; } state.preview = state.preview === id ? null : id; renderDetail(); break;
        case 'task-example': {
          state.task = button.dataset.example === 'compare' ? '比较这些网页如何组织内容、帮助用户查找资料，以及用交互解释信息。请围绕我的评注分析，引用具体编号，说明各自的取舍。' : '我在设计一个有较多内容和资料的个人网站。请依据我标出的这些做法，给出导航、内容层级和解释性互动的建议，并说明哪些情境不适用。';
          document.getElementById('ai-task').value = state.task; document.getElementById('task-preview').textContent = state.task; await chrome.storage.local.set({ readingTask: state.task }); break;
        }
        case 'edit': if (state.editing && state.editing !== id) { toast('先保存当前修改'); break; } state.editing = id; state.editingFeedback = state.notes.find(note => note.id === id)?.feedback ?? null; renderDetail(); dialog.querySelector('[data-edit-comment]')?.focus(); break;
        case 'edit-feedback': {
          state.editingFeedback = state.editingFeedback === button.dataset.feedback ? null : button.dataset.feedback;
          dialog.querySelectorAll('[data-action="edit-feedback"]').forEach(node => { const selected = node.dataset.feedback === state.editingFeedback; node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected)); }); break;
        }
        case 'cancel-edit': state.editing = null; renderDetail(); break;
        case 'save-edit': {
          const note = state.notes.find(note => note.id === id), comment = dialog.querySelector(`[data-edit-comment="${id}"]`).value;
          await send('SAVE', { note: { ...note, comment, feedback: state.editingFeedback }, revision: note.revision }); state.editing = null; await reload(); renderDetail(); toast('已保存修改，原话历史和画面仍保留'); break;
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
          const text = `本次任务：${state.task || '阅读以下网页评注'}\n\n${notes.map(n => `[${n.id}] ${n.url}\n用户明确反馈：${feedbackText(n)}\n${n.comment}`).join('\n\n')}\n\n注意：复制文本没有携带图片；请同时提供解压后的阅读包文件。`;
          await navigator.clipboard.writeText(text); toast('已复制说明，图片请随阅读包提供'); break;
        }
      }
    } catch (error) { toast(error.message); }
    finally { if (state.busy) { state.busy = false; button.disabled = false; if (action === 'download') button.innerHTML = `${icon('download')}下载阅读包`; } }
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
