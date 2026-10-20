// Runs in the stage page. Draws everything that isn't the real panel: background, window, chat, camera, captions, cursor, end card.
// Everything is a pure function of t (plus a little cached layout), so frames are deterministic.
(() => {
  const L = window.LAYOUT; // { W, H, VX, VY, VW, CAP_Y, CAP_SIZE, SUB_SIZE }
  const $ = (s, r = document) => r.querySelector(s);
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const out = (k) => 1 - Math.pow(1 - k, 3);
  const back = (k) => { const c = 1.5; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
  const prog = (t, a, b) => clamp((t - a) / (b - a));

  /* ---------- camera ---------- */
  // Boxes in world coords: the camera fits box.w into the viewport width, with box.y at the top of the viewport.
  const BOX = {
    wide: { x: -10, y: -10, w: 920 },
    chat: { x: 44, y: 32, w: 436 },
    chatLow: { x: 44, y: 330, w: 436 },
    panel: { x: 480, y: 66, w: 420 },
    end: { x: 120, y: 100, w: 660 },
  };
  // The bottom of the chat, where new messages appear.
  BOX.chatEnd = { x: 44, y: 1180 - (L.H - L.VY) * 436 / L.VW + 6, w: 436 };
  const CAM = window.CAMERA; // [[time, box, moveDuration]]
  function camAt(t) {
    let cur = BOX[CAM[0][1]];
    for (const [at, name, dur] of CAM) {
      if (t < at) break;
      const k = ease(prog(t, at, at + dur));
      const to = typeof name === 'string' ? BOX[name] : name;
      cur = { x: lerp(cur.x, to.x, k), y: lerp(cur.y, to.y, k), w: lerp(cur.w, to.w, k) };
      if (k < 1) return cur;
    }
    return cur;
  }
  const camToScreen = (cam, x, y) => {
    const s = L.VW / cam.w;
    return [L.VX + (x - cam.x) * s, L.VY + (y - cam.y) * s];
  };

  /* ---------- captions ---------- */
  const CAPS = window.CAPTIONS; // [{ a, b, html, sub }]
  function drawCaptions(t) {
    const box = $('#caps');
    let html = '';
    for (const c of CAPS) {
      if (t < c.a - 0.01 || t > c.b + 0.4) continue;
      const kin = out(prog(t, c.a, c.a + 0.45));
      const kout = prog(t, c.b, c.b + 0.3);
      const op = kin * (1 - kout);
      const y = (1 - kin) * 18 - kout * 10;
      const subIn = c.subAt ? out(prog(t, c.subAt, c.subAt + 0.4)) : kin;
      html += `<div class="cap" style="opacity:${op};transform:translateY(${y}px)"><div class="cap-main">${c.html}</div>${c.sub ? `<div class="cap-sub" style="opacity:${subIn};transform:translateY(${(1 - subIn) * 10}px)">${c.sub}</div>` : ''}</div>`;
    }
    if (box.__h !== html) { box.innerHTML = html; box.__h = html; }
  }

  /* ---------- chat ---------- */
  const OLD = $('#old'), NEW = $('#new');
  let oldH = null;
  function drawOldChat(t) {
    // The long history: scroll up through it fast, then settle where the steps are buried.
    const vis = OLD.parentElement.clientHeight;
    if (oldH == null) oldH = OLD.scrollHeight;
    const settle = $('#buried').offsetTop - 140;
    const start = oldH - vis; // bottom
    const k = ease(prog(t, 0.35, 3.6));
    const y = lerp(start, settle, k);
    const v = Math.abs(start - settle) * (ease(prog(t + 0.02, 0.35, 3.6)) - ease(prog(t - 0.02, 0.35, 3.6))) / 0.04;
    OLD.style.transform = `translateY(${-y}px)`;
    OLD.style.filter = v > 300 ? `blur(${Math.min(2.2, v / 1400)}px)` : 'none';
    // Highlights on the buried steps, one by one.
    document.querySelectorAll('#old mark').forEach((m, i) => {
      const k2 = out(prog(t, 4.25 + i * 0.32, 4.55 + i * 0.32));
      m.style.backgroundSize = `${k2 * 100}% 100%`;
      m.style.color = k2 > 0.5 ? '#1b1b1f' : '';
      m.style.opacity = t > 5.6 ? String(1 - out(prog(t, 5.6, 6.0))) : '1';
    });
    const fade = prog(t, 7.55, 7.95);
    $('#chat-old').style.opacity = String(1 - fade);
    $('#chat-old').style.display = t > 8.0 ? 'none' : '';
  }

  // Chips that lift off the chat and scatter.
  let chipStart = null;
  function drawChips(t) {
    const layer = $('#chips');
    if (t < 5.5 || t > 8.2) { layer.innerHTML = ''; return; }
    if (!chipStart) {
      chipStart = [...document.querySelectorAll('#old mark')].map((m) => {
        const r = m.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, text: m.dataset.chip };
      });
    }
    const ends = [[30, 300, -8], [250, 360, 6], [40, 640, 5], [260, 720, -6]].map(([x, y, r]) => [x * L.W / 540, L.VY + (y - 250) * ((L.H - L.VY) / 710), r]);
    let html = '';
    chipStart.forEach((c, i) => {
      const k = back(prog(t, 5.6 + i * 0.12, 6.35 + i * 0.12));
      const drift = prog(t, 6.4, 8.0);
      const [ex, ey, er] = ends[i];
      const x = lerp(c.x, ex, k) + drift * (i % 2 ? 26 : -26);
      const y = lerp(c.y, ey, k) + drift * 30;
      const op = clamp(k * 3) * (1 - out(prog(t, 6.9 + i * 0.1, 7.7 + i * 0.1)));
      const blur = out(prog(t, 6.9 + i * 0.1, 7.7 + i * 0.1)) * 6;
      html += `<div class="chip-fly" style="left:${x}px;top:${y}px;opacity:${op};filter:blur(${blur}px);transform:rotate(${er * k}deg) scale(${lerp(0.9, 1.08, k)})">${c.text}</div>`;
    });
    layer.innerHTML = html;
  }

  // New chat: messages appear at their times; text streams in.
  const MSGS = window.CHAT; // [{ at, kind, text, dur, lines }]
  function streamText(s, k) {
    const n = Math.floor(s.length * k);
    return s.slice(0, n);
  }
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function drawNewChat(t) {
    const on = t >= 7.9;
    $('#chat-new').style.display = on ? '' : 'none';
    if (!on) return;
    $('#chat-new').style.opacity = String(out(prog(t, 7.9, 8.3)));
    let html = '';
    for (const m of MSGS) {
      if (t < m.at) continue;
      const k = m.dur ? clamp((t - m.at) / m.dur) : 1;
      const rise = out(prog(t, m.at, m.at + 0.3));
      const st = `style="opacity:${rise};transform:translateY(${(1 - rise) * 8}px)"`;
      if (m.kind === 'user') html += `<div class="m user" ${st}>${esc(m.text)}</div>`;
      else if (m.kind === 'text') html += `<div class="m text" ${st}>${esc(streamText(m.text, k))}${k < 1 ? '<span class="caret"></span>' : ''}</div>`;
      else if (m.kind === 'tool') {
        const done = t >= m.at + (m.wait || 0.5);
        const dot = done ? 'ok' : Math.floor(t * 4) % 2 ? 'run' : 'run dim';
        html += `<div class="m tool" ${st}><div><span class="dot ${dot}"></span><b>${m.name}</b> <span class="muted">${m.args || ''}</span></div>${done ? `<div class="res">⎿ ${m.result}</div>` : ''}</div>`;
      } else if (m.kind === 'edit') {
        const n = Math.floor(m.lines.length * k);
        html += `<div class="m tool" ${st}><div><span class="dot ${k < 1 ? 'run' : 'ok'}"></span><b>Edit</b> <span class="muted">${m.file}</span></div><div class="diff">${m.lines.slice(0, Math.max(1, n)).map((l) => `<div class="add"><i>+</i>${esc(l)}</div>`).join('')}</div></div>`;
      }
    }
    const log = $('#log');
    if (log.__h !== html) { log.innerHTML = html; log.__h = html; }
    // Input box: typed text before it is sent.
    const inp = window.INPUT; // { a, b, text }
    const typed = t >= inp.a && t < inp.b ? inp.text.slice(0, Math.floor(inp.text.length * prog(t, inp.a, inp.b - 0.25))) : '';
    $('#input-text').innerHTML = typed ? esc(typed) + '<span class="caret"></span>' : '<span class="ph">Ask Claude to edit, explain, or build…</span>';
  }

  /* ---------- right column: editor, then the checklist tab ---------- */
  function drawRight(t, view) {
    const k = out(prog(t, view.panelIn, view.panelIn + 0.55));
    $('#tab-check').style.display = t >= view.panelIn ? '' : 'none';
    $('#tab-check').style.opacity = String(k);
    $('#tab-code').classList.toggle('active', t < view.panelIn);
    $('#tab-check').classList.toggle('active', t >= view.panelIn);
    $('#panel').style.transform = `translateX(${(1 - k) * 60}px)`;
    $('#panel').style.opacity = String(k);
    $('#editor').style.opacity = String(1 - k);
  }

  /* ---------- end card ---------- */
  function drawEnd(t) {
    const a = window.END_AT;
    const k = prog(t, a, a + 0.7);
    const end = $('#end');
    end.style.display = t >= a ? '' : 'none';
    if (t < a) { $('#world-wrap').style.filter = 'none'; return; }
    end.style.opacity = String(out(k));
    $('#world-wrap').style.filter = `blur(${out(k) * 10}px) brightness(${1 - out(k) * 0.6})`;
    end.querySelectorAll('[data-in]').forEach((el) => {
      const s = a + parseFloat(el.dataset.in);
      const kk = out(prog(t, s, s + 0.55));
      el.style.opacity = String(kk);
      el.style.transform = `translateY(${(1 - kk) * 22}px) scale(${lerp(0.97, 1, kk)})`;
    });
    const typed = window.SEARCH;
    const ks = prog(t, a + 2.5, a + 3.5);
    $('#search-text').textContent = typed.slice(0, Math.floor(typed.length * ks));
    $('#search-caret').style.opacity = Math.floor(t * 2.2) % 2 ? '0' : '1';
    const res = out(prog(t, a + 3.65, a + 4.1));
    $('#result').style.opacity = String(res);
    $('#result').style.transform = `translateY(${(1 - res) * 10}px)`;
    // The step being shown lights up: open the panel, then search, then install.
    const step = t < a + 1.9 ? 0 : t < a + 2.45 ? 1 : t < a + 4.2 ? 2 : 3;
    end.querySelectorAll('.step').forEach((el) => el.classList.toggle('on', +el.dataset.step === step));
    // A soft pulse around Install.
    const p = prog(t, a + 4.25, a + 5.25);
    $('#install').style.boxShadow = p > 0 && p < 1 ? `0 0 0 ${p * 10}px rgba(0,120,212,${0.55 * (1 - p)})` : 'none';
  }

  /* ---------- per-frame entry point ---------- */
  window.renderFrame = (t, view) => {
    const cam = camAt(t);
    const s = L.VW / cam.w;
    $('#world').style.transform = `translate(${L.VX - cam.x * s}px, ${L.VY - cam.y * s}px) scale(${s})`;
    // A slow drift of the background glow.
    $('#bg').style.backgroundPosition = `${50 + Math.sin(t / 5) * 8}% ${40 + Math.cos(t / 6) * 6}%`;
    drawOldChat(t);
    drawChips(t);
    drawNewChat(t);
    drawRight(t, view);
    drawCaptions(t);
    drawEnd(t);
    // Cursor (world coords -> screen).
    const cur = $('#cursor');
    if (view.cursor && view.cursor.op > 0) {
      const [x, y] = camToScreen(cam, view.cursor.x, view.cursor.y);
      cur.style.display = '';
      cur.style.opacity = String(view.cursor.op);
      cur.style.transform = `translate(${x}px, ${y}px) scale(${view.cursor.press ? 0.86 : 1})`;
      const rip = $('#ripple');
      if (view.cursor.ripple != null) {
        const k = view.cursor.ripple;
        rip.style.display = '';
        rip.style.transform = `translate(${x}px, ${y}px) scale(${0.3 + k * 1.4})`;
        rip.style.opacity = String((1 - k) * 0.7);
      } else rip.style.display = 'none';
    } else {
      cur.style.display = 'none';
      $('#ripple').style.display = 'none';
    }
    // Keycap hint (e.g. Ctrl+V).
    const kc = $('#keycap');
    if (view.keycap) {
      const [x, y] = camToScreen(cam, view.keycap.x, view.keycap.y);
      kc.style.display = '';
      kc.textContent = view.keycap.text;
      kc.style.opacity = String(view.keycap.op);
      kc.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0) scale(${lerp(0.9, 1, view.keycap.op)})`;
    } else kc.style.display = 'none';
    // Notification pill ("Claude added 1 task").
    const nf = $('#notify');
    if (view.notify) {
      nf.style.display = '';
      nf.innerHTML = view.notify.html;
      nf.style.opacity = String(view.notify.op);
      nf.style.transform = `translate(-50%, ${(1 - view.notify.op) * -14}px)`;
    } else nf.style.display = 'none';
    // Fade from black at the start.
    $('#fade').style.opacity = String(1 - out(prog(t, 0, 0.35)));
  };
  window.worldToScreen = (t, x, y) => camToScreen(camAt(t), x, y);
})();
