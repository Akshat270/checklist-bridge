// Checklist panel (runs inside the VS Code webview).
(function () {
  const vscode = acquireVsCodeApi();
  const ui = Object.assign({ expanded: {}, collapsed: {}, sharedOpen: false }, vscode.getState() || {});
  const saveUi = () => vscode.setState(ui);

  let list = null;
  let routes = { waiting: false, channel: false, terminal: false };
  const qDrafts = {}; // qid -> { picks, other, note } as typed here
  const qTimers = {};
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
    ask: svg('<circle cx="8" cy="8" r="6.2"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.4"/><circle cx="8" cy="11.4" r=".55" fill="currentColor" stroke="none"/>'),
    star: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 1.8l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.2l-3.7 2.1.8-4.2L2 6.2l4.2-.5z"/></svg>',
    paste: svg('<rect x="3.5" y="3" width="9" height="11" rx="1.5"/><path d="M6 3V2h4v1"/><path d="M6 7.5h4M6 10h3"/>'),
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
        const src = img.src || `data:${img.mime};base64,${img.data}`;
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
          noteTimers[t.id] = setTimeout(() => {
            delete noteTimers[t.id];
            post({ type: 'draft', taskId: t.id, note: notes[t.id] });
          }, 350);
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

  /* ---------------- questions ---------------- */
  const openQs = () => list.questions.filter((q) => !q.retired && (!q.answer || !q.seenAt));
  const qDraftOf = (q) => qDrafts[q.id] || (qDrafts[q.id] = { picks: [...q.draft.picks], other: q.draft.other, note: q.draft.note });
  const qReady = (q) => {
    const d = qDraftOf(q);
    return d.picks.some((p) => p !== 'other') || (d.picks.includes('other') && d.other.trim());
  };
  const optLabel = (q, id) => (id === 'other' ? 'Something else' : (q.options.find((o) => o.id === id) || {}).label || id);
  const answerText = (q, a) => [...a.picks.map((p) => optLabel(q, p)), ...(a.other ? [a.other] : [])].join(' + ');

  function saveQDraft(q, immediate) {
    clearTimeout(qTimers[q.id]);
    const d = qDraftOf(q);
    const go = () => post({ type: 'answerDraft', qid: q.id, picks: d.picks, other: d.other, note: d.note });
    if (immediate) go();
    else
      qTimers[q.id] = setTimeout(() => {
        delete qTimers[q.id];
        go();
      }, 350);
  }

  function renderQuestion(q) {
    const d = qDraftOf(q);
    const urgent = q.tags.includes('urgent');
    const el = h('div', { class: `qcard${urgent ? ' urgent' : ''}`, id: `task-${q.id}`, 'data-id': q.id, onmouseenter: () => (lastHover = q.id) });
    const tags = q.tags.length ? h('div', { class: 'meta' }, q.tags.map((g) => h('span', { class: `chip ${g}` }, g[0].toUpperCase() + g.slice(1)))) : null;

    el.append(
      h('div', { class: 'qhead' },
        h('span', { class: 'qicon', html: I.ask }),
        h('div', {}, h('div', { class: 'qtext', id: `qt-${q.id}` }, q.question), q.why && h('p', { class: 'qwhy' }, q.why), tags)
      )
    );

    const role = q.multi ? 'checkbox' : 'radio';
    const opts = h('div', { class: 'opts', role: q.multi ? 'group' : 'radiogroup', 'aria-labelledby': `qt-${q.id}` });
    const choose = (id) => {
      if (q.multi) d.picks = d.picks.includes(id) ? d.picks.filter((x) => x !== id) : [...d.picks, id];
      else d.picks = [id];
      saveQDraft(q, true);
      paint();
      if (id === 'other' && d.picks.includes('other')) setTimeout(() => el.querySelector('.other')?.focus(), 0);
    };
    const all = [...q.options, ...(q.allowOther ? [{ id: 'other', label: 'Something else' }] : [])];
    for (const o of all) {
      const rec = q.recommended === o.id;
      const row = h(
        'div',
        { class: `opt${rec ? ' rec' : ''}`, 'data-opt': o.id },
        h(
          'button',
          { class: 'opt-main', role, 'aria-checked': 'false', onclick: () => choose(o.id) },
          h('span', { class: `pick ${q.multi ? 'multi' : 'single'}` }),
          h(
            'span',
            { class: 'opt-text' },
            h('span', { class: 'opt-label' }, o.label, rec && h('span', { class: 'chip rec-chip', title: q.reason || 'Claude recommends this', html: `${I.star}<span>Claude's pick</span>` })),
            o.summary && h('span', { class: 'opt-sum' }, o.summary),
            rec && q.reason && h('span', { class: 'opt-why' }, q.reason)
          )
        ),
        o.details && h('details', { class: 'opt-details' }, h('summary', {}, 'Details'), h('p', {}, o.details))
      );
      opts.append(row);
    }
    el.append(opts);

    const other = h('textarea', {
      class: 'note other',
      rows: '2',
      placeholder: 'Your answer…',
      'aria-label': 'Something else',
      oninput: (e) => {
        d.other = e.target.value;
        saveQDraft(q);
        paint();
      },
    });
    other.value = d.other;
    const otherWrap = h('div', { class: 'other-wrap' }, other);

    const note = h('textarea', {
      class: 'note',
      rows: '2',
      placeholder: 'Add a note…',
      'aria-label': `Note for ${q.question}`,
      oninput: (e) => {
        d.note = e.target.value;
        saveQDraft(q);
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          shareQ(q);
        }
      },
    });
    note.value = d.note;
    const noteOpen = !!d.note || q.draft.images.length > 0 || ui.expanded[q.id];
    const noteWrap = h('div', { class: 'note-wrap', hidden: !noteOpen }, note, shots(q.draft.images, true, q.id));
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true, onchange: (e) => attach(q.id, e.target.files) });
    const shareBtn = h('button', { class: 'btn share-q', html: `${I.send}<span>Share answer</span>`, onclick: () => shareQ(q) });

    el.append(
      otherWrap,
      noteWrap,
      h(
        'div',
        { class: 'actions' },
        h('button', {
          class: 'ghost add-note',
          hidden: noteOpen,
          html: `${I.note}<span>Note</span>`,
          onclick: (e) => {
            ui.expanded[q.id] = true;
            saveUi();
            noteWrap.hidden = false;
            e.currentTarget.hidden = true;
            note.focus();
          },
        }),
        h('button', { class: 'ghost', title: 'Attach a screenshot (or paste one into the note)', html: `${I.image}<span>Image</span>`, onclick: () => file.click() }),
        file,
        h('span', { class: 'grow' }),
        shareBtn
      )
    );

    function paint() {
      for (const row of el.querySelectorAll('.opt')) {
        const on = d.picks.includes(row.dataset.opt);
        row.classList.toggle('on', on);
        row.querySelector('.opt-main').setAttribute('aria-checked', String(on));
      }
      otherWrap.hidden = !d.picks.includes('other');
      shareBtn.disabled = !qReady(q);
      shareBtn.title = qReady(q) ? 'Claude can read your answer once you share it' : 'Pick an option first';
    }
    paint();
    el.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      attach(q.id, e.dataTransfer.files);
    });
    return el;
  }

  function shareQ(q) {
    if (!qReady(q)) return toast('Pick an option first');
    clearTimeout(qTimers[q.id]);
    const d = qDraftOf(q);
    post({ type: 'shareAnswer', qid: q.id, picks: d.picks, other: d.other, note: d.note });
    delete qDrafts[q.id];
    delete ui.expanded[q.id];
    saveUi();
  }

  /** Label and action for "Send now", depending on how this chat can be reached. */
  function sendControl(compact) {
    if (routes.waiting) return h('span', { class: 'status seen', html: `${I.check}<span>Claude is waiting and gets it right away</span>` });
    if (routes.channel || routes.terminal)
      return h('button', { class: `btn${compact ? ' small' : ''}`, title: 'Hand this to Claude now instead of waiting for its next read', html: `${I.send}<span>Send now</span>`, onclick: () => post({ type: 'sendNow' }) });
    return h('button', {
      class: 'ghost',
      title: 'Claude can\'t be reached from here while it\'s idle. Copies a one-line message to paste into the Claude chat.',
      html: `${I.paste}<span>Copy for chat</span>`,
      onclick: () => post({ type: 'sendNow' }),
    });
  }

  /** An answered question Claude hasn't read yet: stays in Decide, with Send now. */
  function renderAnsweredQ(q) {
    const a = q.answer;
    const el = h('div', { class: 'qcard answered', id: `task-${q.id}`, 'data-id': q.id });
    el.append(
      h('div', { class: 'qhead' },
        h('span', { class: 'mark done small', html: I.check }),
        h('div', {}, h('div', { class: 'qtext muted' }, q.question), h('div', { class: 'qanswer' }, answerText(q, a), a.picks.length === 1 && !a.other && (q.options.find((o) => o.id === a.picks[0]) || {}).summary && h('span', { class: 'qsum' }, q.options.find((o) => o.id === a.picks[0]).summary)), a.note && h('p', { class: 'said' }, a.note), shots(a.images, false, q.id))
      ),
      h(
        'div',
        { class: 'actions' },
        q.pushedAt
          ? h('span', { class: 'status', html: `${I.send}<span>Sent to Claude</span>` })
          : routes.waiting
            ? h('span', { class: 'status seen', html: `${I.check}<span>Claude is waiting and gets it right away</span>` })
            : h('span', { class: 'status', html: `${I.clock}<span>Shared. Claude reads it on its next turn</span>` }),
        h('span', { class: 'grow' }),
        h('button', { class: 'ghost', title: 'Hide your answer from Claude again so you can change it', html: `${I.undo}<span>Take back</span>`, onclick: () => post({ type: 'unshareAnswer', qid: q.id }) }),
        !q.pushedAt && !routes.waiting && sendOnCard && sendControl(true)
      )
    );
    return el;
  }

  /** A read (or withdrawn) question, in the Shared section. */
  function renderSharedQ(q) {
    const open = isOpen(q);
    const el = h('div', { class: `task shared-row q-row${open ? ' open' : ''}${q.retired ? ' retired' : ''}`, id: `task-${q.id}`, 'data-id': q.id });
    const answer = q.answer ? answerText(q, q.answer) : '';
    el.append(
      h(
        'div',
        { class: 'row', role: 'button', tabindex: '0', 'aria-expanded': String(open), onclick: () => toggle(q) },
        h('span', { class: `mark ${q.retired ? 'retired' : 'decided'}`, html: q.retired ? I.minus : I.ask }),
        h('div', {}, h('div', { class: 'text' }, q.question), h('div', { class: 'meta' }, q.retired ? h('span', { class: 'chip soft' }, 'No longer needed') : h('span', { class: 'chip decided' }, answer))),
        h('div', { class: 'right' }, q.retired ? null : h('span', { class: 'status seen', title: 'Claude has read this', html: I.eye }))
      )
    );
    if (open)
      el.append(
        h(
          'div',
          { class: 'more' },
          q.retired && q.retired.reason && h('p', { class: 'detail' }, `Claude: ${q.retired.reason}`),
          q.answer && q.answer.note && h('p', { class: 'said' }, q.answer.note),
          q.answer && shots(q.answer.images, false, q.id),
          q.answer &&
            h('div', { class: 'actions' }, h('span', { class: 'status seen', html: `${I.eye}<span>Claude has read this</span>` }), h('span', { class: 'grow' }),
              h('button', { class: 'ghost', html: `${I.undo}<span>Take back</span>`, onclick: () => post({ type: 'unshareAnswer', qid: q.id }) }))
        )
      );
    return el;
  }

  /** Shared items Claude hasn't read yet (tasks and answers), for the Send now bar. */
  function unreadShared() {
    return [
      ...list.tasks.filter((t) => t.shared && !t.seenAt && !t.pushedAt),
      ...list.questions.filter((q) => q.answer && !q.seenAt && !q.pushedAt && !q.retired),
    ];
  }

  /* ---------------- page parts ---------------- */
  function renderProgress() {
    if (!list) return;
    const qs = list.questions.filter((q) => !q.retired);
    const total = list.tasks.length + qs.length;
    const n = total || 1;
    const decided = qs.filter((q) => q.answer).length;
    const done = list.tasks.filter((t) => t.shared && t.shared.done).length + decided;
    const notdone = list.tasks.filter((t) => t.shared && !t.shared.done).length;
    const pct = (x) => `${(100 * x) / n}%`;
    // The bar shows only what Claude can see, so it always agrees with "x of y shared".
    $('#bar').replaceChildren(
      h('span', { class: 'b-done', style: `width:${pct(done)}` }),
      h('span', { class: 'b-notdone', style: `width:${pct(notdone)}` })
    );
    const todo = list.tasks.filter((t) => !t.shared).length;
    const decide = qs.length - decided;
    const leftBits = [todo && `<b>${todo}</b> to do`, decide && `<b>${decide}</b> to decide`].filter(Boolean);
    $('#progress-label').innerHTML = total
      ? `<span>${leftBits.join(', ') || 'Nothing left'}</span><span><b>${done + notdone}</b> of ${total} shared</span>`
      : '';
    $('#progress').hidden = !total;
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

  let sendOnCard = false;
  function render() {
    if (!list) return;
    $('#title').textContent = list.title;
    document.title = list.title;
    $('#folder-name').textContent = list.folder;
    $('#folder').hidden = !list.folder;
    const liveQs = list.questions.filter((q) => !q.retired).length;
    $('#task-count').textContent = [list.tasks.length && plural(list.tasks.length, 'task', 'tasks'), liveQs && plural(liveQs, 'question', 'questions')].filter(Boolean).join(', ');

    const groups = todoGroups();
    currentId = pickCurrent(groups);
    renderProgress();
    renderDock();

    // Keep focus and caret across re-renders.
    const active = document.activeElement;
    const activeRow = active && active.closest && active.closest('.task');
    const activeCard = active && active.closest && (active.closest('.task') || active.closest('.qcard'));
    const focus = activeCard && { id: activeCard.dataset.id, tag: active.tagName, cls: active.classList.contains('other') ? '.other' : 'textarea:not(.other)', start: active.selectionStart, end: active.selectionEnd };

    const nodes = [];
    $('#waiting').hidden = !routes.waiting;
    // "Send now" hands over everything not read yet in one go, so show exactly one control:
    // on the answer card when that answer is the only thing waiting, otherwise in the bar.
    const pending = unreadShared();
    sendOnCard = pending.length === 1 && 'options' in pending[0];

    const decideQs = openQs();
    if (decideQs.length) {
      const box = h('section', { class: 'section decide' });
      const waitingCount = decideQs.filter((q) => !q.answer).length;
      box.append(
        h('div', { class: 'section-title' }, h('span', {}, 'Decide'), waitingCount ? h('span', { class: 'count' }, String(waitingCount)) : null)
      );
      const sorted = [...decideQs].sort((a, b) => (a.answer ? 1 : 0) - (b.answer ? 1 : 0) || (b.tags.includes('urgent') ? 1 : 0) - (a.tags.includes('urgent') ? 1 : 0));
      for (const q of sorted) box.append(row(q, q.answer ? renderAnsweredQ : renderQuestion, `q|${q.answer ? 'a' : 'o'}|${q.pushedAt || 0}|${sendOnCard}|${JSON.stringify(routes)}`));
      nodes.push(box);
    }

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
    const sharedQs = list.questions.filter((q) => (q.answer && q.seenAt) || q.retired);
    if (pending.length && !sendOnCard && !routes.waiting) {
      const nt = pending.filter((x) => !('options' in x)).length, na = pending.length - nt;
      const what = [nt && plural(nt, 'task', 'tasks'), na && plural(na, 'answer', 'answers')].filter(Boolean).join(' and ');
      nodes.push(
        h('div', { class: 'sendbar' },
          h('span', {}, `${what} not read yet`),
          sendControl(true))
      );
    }
    if (!current && !decideQs.length && shared.length) {
      nodes.push(
        h(
          'div',
          { class: 'alldone' },
          h('span', { class: 'mark done', html: I.check }),
          h('div', {}, h('strong', {}, 'Everything is shared'), h('p', {}, 'Claude can read all of it. New tasks will appear at the top.'))
        )
      );
    }
    if (shared.length || sharedQs.length) {
      const unseen = shared.filter((t) => !t.seenAt).length;
      const box = h('section', { class: 'section shared' });
      box.append(sectionHead('__shared', 'Shared with Claude', shared.length + sharedQs.length, ui.sharedOpen, unseen ? `${unseen} not read yet` : 'All read'));
      if (ui.sharedOpen) {
        sharedQs.forEach((q) => box.append(row(q, renderSharedQ, 'sq')));
        shared.forEach((t) => box.append(row(t, renderShared, 's')));
      }
      nodes.push(box);
    }

    for (const id of [...rendered.keys()]) if (!list.tasks.some((t) => t.id === id) && !list.questions.some((q) => q.id === id)) rendered.delete(id);
    $('#list').replaceChildren(...nodes);
    $('#empty').hidden = list.tasks.length + list.questions.length > 0;

    if (focus) {
      const r = document.getElementById(`task-${focus.id}`);
      const target = r && (focus.tag === 'TEXTAREA' ? r.querySelector(focus.cls) : r.querySelector('.row, .opt-main'));
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
      <div class="waiting" id="waiting" hidden role="status"><span class="pulse"></span>Claude is waiting for you. Whatever you share reaches it right away.</div>
      <div class="progress" id="progress"><div class="bar" id="bar"></div><div class="progress-label" id="progress-label"></div></div>
      <div id="list"></div>
      <div class="empty" id="empty" hidden><strong>Nothing here yet</strong><p>When Claude needs you to do something by hand, or to decide something, it appears here.</p></div>
    </main>
    <div class="dock" id="dock" aria-hidden="true"><div class="dock-in"><span id="dock-text"></span><button class="btn" id="share-all">${I.send}<span>Share all</span></button></div></div>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>`;

  $('#hide').onclick = () => post({ type: 'hide' });
  $('#close').onclick = () => post({ type: 'close' });
  $('#share-all').onclick = shareAllTicked;

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const r = (document.activeElement?.closest && (document.activeElement.closest('.task') || document.activeElement.closest('.qcard'))) || (lastHover && document.getElementById(`task-${lastHover}`));
    const t = r && (list.tasks.find((x) => x.id === r.dataset.id) || list.questions.find((x) => x.id === r.dataset.id));
    if (!t || t.shared || t.answer) return toast('Click into a task or question first, then paste');
    e.preventDefault();
    attach(t.id, files);
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      const prevCurrent = currentId;
      const prevShared = list && list.tasks.find((t) => t.id === prevCurrent)?.shared;
      list = m.list;
      list.questions = list.questions || [];
      // Lets VS Code hand this tab back to the right checklist after a reload.
      if (ui.listId !== list.id) {
        ui.listId = list.id;
        saveUi();
      }
      routes = m.routes || routes;
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

  // Send typed-but-not-yet-saved notes right away when the panel loses focus or goes away,
  // so a reload straight after typing doesn't lose them.
  function flushDrafts() {
    for (const id of Object.keys(noteTimers)) {
      clearTimeout(noteTimers[id]);
      delete noteTimers[id];
      if (id in notes) post({ type: 'draft', taskId: id, note: notes[id] });
    }
    for (const id of Object.keys(qTimers)) {
      clearTimeout(qTimers[id]);
      delete qTimers[id];
      const d = qDrafts[id];
      if (d) post({ type: 'answerDraft', qid: id, picks: d.picks, other: d.other, note: d.note });
    }
  }
  window.addEventListener('blur', flushDrafts);
  window.addEventListener('pagehide', flushDrafts);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushDrafts());

  post({ type: 'ready' });
})();
