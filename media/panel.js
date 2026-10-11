// Checklist panel (runs inside the VS Code webview).
(function () {
  const vscode = acquireVsCodeApi();
  const ui = Object.assign({ expanded: {}, collapsed: {}, sharedOpen: false }, vscode.getState() || {});
  const saveUi = () => vscode.setState(ui);

  let list = null;
  let currentId = null;
  let arriveId = null;
  const notes = {}; // note text typed here, not yet confirmed saved
  const noteTimers = {};
  const rendered = new Map(); // taskId -> { key, el }
  let lastHover = null;

  /* ---------------- icons (one stroke family, 16px grid) ---------------- */
  const svg = (d, cls = '') =>
    `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    hide: svg('<path d="M2 8s2.2-4.2 6-4.2S14 8 14 8s-2.2 4.2-6 4.2S2 8 2 8z"/><path d="M3 13 13 3"/>'),
    close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
    folder: svg('<path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/>'),
    chev: svg('<path d="m4 6 4 4 4-4"/>', 'chev'),
    check: svg('<path d="m3.5 8.3 3 3 6-6.6"/>'),
    minus: svg('<path d="M4 8h8"/>'),
    eye: svg('<path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>'),
    clock: svg('<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>'),
    image: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.8" cy="6.6" r="1.1"/><path d="m2.5 11.8 3.4-3.2 2.4 2.1 1.9-1.6 3.3 2.9"/>'),
    note: svg('<path d="M3 2.8h10v7.6H7.2L4 13.2v-2.8H3z"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
    send: svg('<path d="M2.5 8h9.5M8.5 4.5 12 8l-3.5 3.5"/>'),
    undo: svg('<path d="M5.5 4 3 6.5 5.5 9"/><path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7"/>'),
    urgent: `<svg class="prio urgent" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="currentColor"/><path d="M8 4.6v4.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.2" r="1.05" fill="#fff"/></svg>`,
    important: `<svg class="prio important" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><rect x="2" y="9" width="3" height="5" rx="1"/><rect x="6.5" y="5.5" width="3" height="8.5" rx="1"/><rect x="11" y="2" width="3" height="12" rx="1"/></svg>`,
  };

  /* ---------------- helpers ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }
  const post = (msg) => vscode.postMessage(Object.assign({ listId: list && list.id }, msg));
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('on'), 1700);
  }

  const noteOf = (t) => notes[t.id] ?? t.draft.note;
  const rank = (t) => (t.tags.includes('urgent') ? 0 : t.tags.includes('important') ? 1 : 2);
  const hasContent = (t) => !!noteOf(t).trim() || t.draft.images.length > 0;
  const ready = (t) => !t.shared && (t.draft.done || hasContent(t));

  /** To-do tasks in display order: ungrouped first, then Claude's group order; urgent before important before the rest. */
  function todoGroups() {
    const todo = list.tasks.filter((t) => !t.shared);
    const sortRank = (arr) => arr.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
    const out = [];
    const loose = todo.filter((t) => !t.group);
    if (loose.length) out.push({ name: null, tasks: sortRank(loose) });
    for (const g of list.groupOrder) {
      const ts = todo.filter((t) => t.group === g);
      if (ts.length) out.push({ name: g, tasks: sortRank(ts) });
    }
    return out;
  }

  function pickCurrent(groups) {
    const ordered = groups.flatMap((g) => g.tasks);
    if (!ordered.length) return null;
    const best = Math.min(...ordered.map(rank));
    return ordered.find((t) => rank(t) === best).id;
  }

  const isOpen = (t) => (t.id in ui.expanded ? ui.expanded[t.id] : t.id === currentId || (!t.shared && hasContent(t)));

  function toggle(t) {
    ui.expanded[t.id] = !isOpen(t);
    saveUi();
    render();
    if (ui.expanded[t.id]) {
      const ta = document.querySelector(`#task-${t.id} textarea`);
      if (ta && !ta.value) setTimeout(() => ta.focus({ preventScroll: true }), 0);
    }
  }

  /* ---------------- images ---------------- */
  function readImage(file) {
    return new Promise((resolve) => {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return resolve(null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const hh = Math.round(img.height * scale);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = hh;
        c.getContext('2d').drawImage(img, 0, 0, w, hh);
        let mime = 'image/png';
        let data = c.toDataURL(mime);
        if (data.length > 900_000) {
          mime = 'image/jpeg';
          data = c.toDataURL(mime, 0.86);
        }
        URL.revokeObjectURL(url);
        resolve({ mime, data: data.slice(data.indexOf(',') + 1), w, h: hh });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  async function attach(taskId, files) {
    const imgs = (await Promise.all([...files].map(readImage))).filter(Boolean);
    if (!imgs.length) return toast('Attach a PNG, JPEG, GIF or WebP image');
    ui.expanded[taskId] = true;
    saveUi();
    post({ type: 'addImages', taskId, images: imgs });
  }

  function lightbox(src) {
    const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Screenshot', tabindex: '-1' }, h('img', { src, alt: '' }));
    const close = () => {
      box.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => e.key === 'Escape' && close();
    box.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(box);
    box.focus();
  }

  function shots(images, removable, taskId) {
    if (!images.length) return null;
    return h(
      'div',
      { class: 'shots' },
      images.map((img) => {
        const src = `data:${img.mime};base64,${img.data}`;
        return h(
          'div',
          { class: 'shot' },
          h('img', { src, alt: 'Screenshot', onclick: () => lightbox(src) }),
          removable &&
            h('button', {
              class: 'x',
              title: 'Remove screenshot',
              'aria-label': 'Remove screenshot',
              html: I.close,
              onclick: () => post({ type: 'removeImage', taskId, imageId: img.id }),
            })
        );
      })
    );
  }

  /* ---------------- sharing ---------------- */
  function share(t) {
    clearTimeout(noteTimers[t.id]);
    if (!ready(t)) return toast('Tick it or write a note first');
    const note = noteOf(t);
    const send = () => {
      post({ type: 'share', taskId: t.id, note, done: t.draft.done });
      delete notes[t.id];
      delete ui.expanded[t.id];
      saveUi();
    };
    const el = document.getElementById(`task-${t.id}`);
    if (el && !reduced()) {
      el.classList.add('leaving');
      setTimeout(send, 200);
    } else send();
  }

  function shareAllTicked() {
    const ticked = list.tasks.filter((t) => !t.shared && t.draft.done);
    for (const t of ticked) share(t);
    if (ticked.length) toast(`Shared ${plural(ticked.length, 'task', 'tasks')} with Claude`);
  }

  /* ---------------- task rows ---------------- */
  function chipsFor(t, open, isCurrent) {
    const out = [];
    const tags = [...t.tags].sort((a, b) => (b === 'urgent') - (a === 'urgent') || (b === 'important') - (a === 'important'));
    for (const g of tags) {
      if (!open && (g === 'urgent' || g === 'important')) continue; // shown as the priority mark instead
      out.push(h('span', { class: `chip ${g}` }, g[0].toUpperCase() + g.slice(1)));
    }
    if (isCurrent && t.group) out.push(h('span', { class: 'chip soft' }, t.group));
    const note = (t.shared ? t.shared.note : noteOf(t)).trim();
    const pics = (t.shared ? t.shared.images : t.draft.images).length;
    if (!open && note) out.push(h('span', { class: 'chip soft', title: 'Has a note', html: `${I.note}<span>Note</span>` }));
    if (!open && pics) out.push(h('span', { class: 'chip soft', title: 'Screenshots', html: `${I.image}<span>${pics}</span>` }));
    return out;
  }

  function prioMark(t) {
    if (t.tags.includes('urgent')) return h('span', { title: 'Urgent', html: I.urgent });
    if (t.tags.includes('important')) return h('span', { title: 'Important', html: I.important });
    return null;
  }

  function renderTodo(t) {
    const isCurrent = t.id === currentId;
    const open = isOpen(t);
    const el = h('div', {
      class: `task${open ? ' open' : ''}${isCurrent ? ' current' : ''}${rank(t) === 0 ? ' urgent' : ''}${!t.draft.done && hasContent(t) ? ' started' : ''}${t.id === arriveId ? ' arrive' : ''}`,
      id: `task-${t.id}`,
      'data-id': t.id,
      onmouseenter: () => (lastHover = t.id),
    });

    const tick = h('input', {
      type: 'checkbox',
      class: 'tick',
      'aria-label': `Done: ${t.text}`,
      checked: t.draft.done,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        t.draft.done = e.target.checked;
        post({ type: 'draft', taskId: t.id, done: t.draft.done });
        refresh(el, t);
      },
    });
    const quickShare = h('button', {
      class: 'btn small quiet qs',
      title: 'Share with Claude',
      onclick: (e) => {
        e.stopPropagation();
        share(t);
      },
    }, 'Share');

    const row = h(
      'div',
      {
        class: 'row',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(open),
        onclick: () => toggle(t),
        onkeydown: (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault();
            toggle(t);
          }
        },
      },
      tick,
      h('div', {}, h('div', { class: 'text' }, t.text), h('div', { class: 'meta' }, chipsFor(t, open, isCurrent))),
      h('div', { class: 'right' }, open ? null : quickShare, open ? null : prioMark(t))
    );
    el.append(row);

    if (open) {
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true, onchange: (e) => attach(t.id, e.target.files) });
      const ta = h('textarea', {
        class: 'note',
        rows: '2',
        placeholder: 'Add a note…',
        'aria-label': `Note for ${t.text}`,
        oninput: (e) => {
          notes[t.id] = e.target.value;
          clearTimeout(noteTimers[t.id]);
          noteTimers[t.id] = setTimeout(() => post({ type: 'draft', taskId: t.id, note: notes[t.id] }), 350);
          refresh(el, t);
        },
        onkeydown: (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            share(t);
          }
        },
      });
      ta.value = noteOf(t);
      const shareBtn = h('button', { class: 'btn share-btn', onclick: () => share(t) });
      el.append(
        h(
          'div',
          { class: 'more' },
          t.detail && h('p', { class: 'detail' }, t.detail),
          t.command &&
            h(
              'div',
              { class: 'cmd' },
              h('code', {}, t.command),
              h('button', { title: 'Copy command', html: `${I.copy}<span>Copy</span>`, onclick: () => post({ type: 'copy', text: t.command }) })
            ),
          ta,
          shots(t.draft.images, true, t.id),
          h(
            'div',
            { class: 'actions' },
            h('button', { class: 'ghost', title: 'Attach a screenshot (or paste one into the note)', html: `${I.image}<span>Add image</span>`, onclick: () => file.click() }),
            file,
            h('span', { class: 'grow' }),
            shareBtn
          )
        )
      );
      el.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        attach(t.id, e.dataTransfer.files);
      });
    }
    refresh(el, t);
    return el;
  }

  /** In-place update while the user ticks or types, so focus and caret stay put. */
  function refresh(el, t) {
    const isReady = ready(t);
    el.classList.toggle('started', !t.draft.done && hasContent(t));
    const qs = el.querySelector('.qs');
    if (qs) qs.hidden = !t.draft.done;
    const btn = el.querySelector('.share-btn');
    if (btn) {
      btn.hidden = !isReady;
      btn.classList.toggle('secondary', !t.draft.done);
      btn.innerHTML = `${I.send}<span>${t.draft.done ? 'Share as done' : 'Share as not done'}</span>`;
      btn.title = 'Claude can read a task only after you share it (Ctrl/Cmd+Enter in the note)';
    }
    renderProgress();
    renderDock();
  }

  function renderShared(t) {
    const s = t.shared;
    const open = isOpen(t);
    const el = h('div', { class: `task shared-row${open ? ' open' : ''}`, id: `task-${t.id}`, 'data-id': t.id });
    el.append(
      h(
        'div',
        {
          class: 'row',
          role: 'button',
          tabindex: '0',
          'aria-expanded': String(open),
          onclick: () => toggle(t),
          onkeydown: (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
              e.preventDefault();
              toggle(t);
            }
          },
        },
        h('span', { class: `mark ${s.done ? 'done' : 'notdone'}`, title: s.done ? 'Shared as done' : 'Shared as not done', html: s.done ? I.check : I.minus }),
        h('div', {}, h('div', { class: 'text' }, t.text), h('div', { class: 'meta' }, chipsFor(t, open, false))),
        h(
          'div',
          { class: 'right' },
          t.seenAt
            ? h('span', { class: 'status seen', title: 'Claude has read this', html: I.eye })
            : h('span', { class: 'status', title: 'Claude hasn’t read this yet', html: I.clock })
        )
      )
    );
    if (open) {
      el.append(
        h(
          'div',
          { class: 'more' },
          s.note && h('p', { class: 'said' }, s.note),
          shots(s.images, false, t.id),
          h(
            'div',
            { class: 'actions' },
            t.seenAt
              ? h('span', { class: 'status seen', html: `${I.eye}<span>Claude has read this</span>` })
              : h('span', { class: 'status', html: `${I.clock}<span>Shared as ${s.done ? 'done' : 'not done'}. Claude hasn’t read it yet</span>` }),
            h('span', { class: 'grow' }),
            h('button', {
              class: 'ghost',
              title: 'Hide this from Claude again so you can change it',
              html: `${I.undo}<span>Take back</span>`,
              onclick: () => post({ type: 'unshare', taskId: t.id }),
            })
          )
        )
      );
    }
    return el;
  }

  /* ---------------- page parts ---------------- */
  function renderProgress() {
    if (!list) return;
    const n = list.tasks.length || 1;
    const done = list.tasks.filter((t) => t.shared && t.shared.done).length;
    const notdone = list.tasks.filter((t) => t.shared && !t.shared.done).length;
    const pct = (x) => `${(100 * x) / n}%`;
    // The bar shows only what Claude can see, so it always agrees with "x of y shared".
    $('#bar').replaceChildren(
      h('span', { class: 'b-done', style: `width:${pct(done)}` }),
      h('span', { class: 'b-notdone', style: `width:${pct(notdone)}` })
    );
    const left = list.tasks.length - done - notdone;
    $('#progress-label').innerHTML = list.tasks.length
      ? `<span><b>${left}</b> to do</span><span><b>${done + notdone}</b> of ${list.tasks.length} shared</span>`
      : '';
    $('#progress').hidden = !list.tasks.length;
  }

  function renderDock() {
    if (!list) return;
    const ticked = list.tasks.filter((t) => !t.shared && t.draft.done).length;
    const dock = $('#dock');
    dock.classList.toggle('on', ticked >= 2);
    dock.setAttribute('aria-hidden', String(ticked < 2));
    $('#dock-text').innerHTML = `<b>${ticked}</b> ticked and not shared yet`;
  }

  function sectionHead(key, label, count, open, hint) {
    return h(
      'button',
      {
        class: 'section-head',
        'aria-expanded': String(open),
        onclick: () => {
          if (key === '__shared') ui.sharedOpen = !ui.sharedOpen;
          else ui.collapsed[key] = !ui.collapsed[key];
          saveUi();
          render();
        },
        html: I.chev,
      },
      h('span', {}, label),
      h('span', { class: 'count' }, String(count)),
      hint && h('span', { class: 'hint' }, hint)
    );
  }

  function row(t, renderFn, extraKey) {
    const key = `${t.rev}|${t.seenAt || 0}|${isOpen(t)}|${t.id === currentId}|${t.id === arriveId}|${extraKey || ''}`;
    let r = rendered.get(t.id);
    if (!r || r.key !== key) {
      r = { key, el: renderFn(t) };
      rendered.set(t.id, r);
    }
    return r.el;
  }

  function render() {
    if (!list) return;
    $('#title').textContent = list.title;
    document.title = list.title;
    $('#folder-name').textContent = list.folder;
    $('#folder').hidden = !list.folder;
    $('#task-count').textContent = plural(list.tasks.length, 'task', 'tasks');

    const groups = todoGroups();
    currentId = pickCurrent(groups);
    renderProgress();
    renderDock();

    // Keep focus and caret across re-renders.
    const active = document.activeElement;
    const activeRow = active && active.closest && active.closest('.task');
    const focus = activeRow && { id: activeRow.dataset.id, tag: active.tagName, start: active.selectionStart, end: active.selectionEnd };

    const nodes = [];
    const current = currentId && list.tasks.find((t) => t.id === currentId);
    if (current) nodes.push(h('section', { class: 'section', 'aria-label': 'Next task' }, row(current, renderTodo)));

    for (const g of groups) {
      const rest = g.tasks.filter((t) => t.id !== currentId);
      if (!rest.length) continue;
      const box = h('section', { class: 'section' });
      if (g.name) {
        const open = !ui.collapsed[g.name];
        box.append(sectionHead(g.name, g.name, rest.length, open));
        if (open) rest.forEach((t) => box.append(row(t, renderTodo)));
      } else {
        rest.forEach((t) => box.append(row(t, renderTodo)));
      }
      nodes.push(box);
    }

    const shared = list.tasks.filter((t) => t.shared).sort((a, b) => b.shared.at - a.shared.at);
    if (!current && shared.length) {
      nodes.push(
        h(
          'div',
          { class: 'alldone' },
          h('span', { class: 'mark done', html: I.check }),
          h('div', {}, h('strong', {}, 'Everything is shared'), h('p', {}, 'Claude can read all of it. New tasks will appear at the top.'))
        )
      );
    }
    if (shared.length) {
      const unseen = shared.filter((t) => !t.seenAt).length;
      const box = h('section', { class: 'section shared' });
      box.append(sectionHead('__shared', 'Shared with Claude', shared.length, ui.sharedOpen, unseen ? `${unseen} not read yet` : 'All read'));
      if (ui.sharedOpen) shared.forEach((t) => box.append(row(t, renderShared, 's')));
      nodes.push(box);
    }

    for (const id of [...rendered.keys()]) if (!list.tasks.some((t) => t.id === id)) rendered.delete(id);
    $('#list').replaceChildren(...nodes);
    $('#empty').hidden = list.tasks.length > 0;

    if (focus) {
      const r = document.getElementById(`task-${focus.id}`);
      const target = r && (focus.tag === 'TEXTAREA' ? r.querySelector('textarea') : r.querySelector('.row'));
      if (target) {
        target.focus({ preventScroll: true });
        if (focus.tag === 'TEXTAREA' && typeof focus.start === 'number') target.setSelectionRange(focus.start, focus.end);
      }
    }
    arriveId = null;
  }

  function jump(id) {
    const t = list && list.tasks.find((x) => x.id === id);
    if (!t) return;
    if (t.shared) ui.sharedOpen = true;
    if (t.group) ui.collapsed[t.group] = false;
    ui.expanded[id] = true;
    saveUi();
    render();
    document.getElementById(`task-${id}`)?.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  }

  /* ---------------- shell ---------------- */
  document.body.innerHTML = `
    <main class="page">
      <header class="head">
        <h1 class="title" id="title"></h1>
        <div class="tools">
          <button class="icon-btn" id="hide" title="Hide. Show it again from the Claude checklists sidebar." aria-label="Hide checklist">${I.hide}</button>
          <button class="icon-btn" id="close" title="Close this checklist for good" aria-label="Close checklist">${I.close}</button>
        </div>
        <div class="sub"><span class="folder" id="folder">${I.folder}<span id="folder-name"></span></span><span id="task-count"></span></div>
      </header>
      <div class="progress" id="progress"><div class="bar" id="bar"></div><div class="progress-label" id="progress-label"></div></div>
      <div id="list"></div>
      <div class="empty" id="empty" hidden><strong>No tasks yet</strong><p>When Claude needs you to do something by hand, it appears here.</p></div>
    </main>
    <div class="dock" id="dock" aria-hidden="true"><div class="dock-in"><span id="dock-text"></span><button class="btn" id="share-all">${I.send}<span>Share all</span></button></div></div>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>`;

  $('#hide').onclick = () => post({ type: 'hide' });
  $('#close').onclick = () => post({ type: 'close' });
  $('#share-all').onclick = shareAllTicked;

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const r = (document.activeElement?.closest && document.activeElement.closest('.task')) || (lastHover && document.getElementById(`task-${lastHover}`));
    const t = r && list.tasks.find((x) => x.id === r.dataset.id);
    if (!t || t.shared) return toast('Click into a task first, then paste');
    e.preventDefault();
    attach(t.id, files);
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      const prevCurrent = currentId;
      const prevShared = list && list.tasks.find((t) => t.id === prevCurrent)?.shared;
      list = m.list;
      render();
      // The one authored moment: after sharing the current task, the next one opens in its place.
      const wasSharedNow = prevCurrent && !prevShared && list.tasks.find((t) => t.id === prevCurrent)?.shared;
      if (wasSharedNow && currentId && currentId !== prevCurrent && !reduced()) {
        arriveId = currentId;
        rendered.delete(currentId);
        render();
      }
    } else if (m.type === 'reveal' && m.taskId) jump(m.taskId);
    else if (m.type === 'toast') toast(m.text);
  });

  post({ type: 'ready' });
})();
