(() => {
'use strict';
/* الواجهة لا تحمل أي أسرار: كل ما يظهر هنا يأتي من لقطة الخادم. أي تلاعب بالواجهة يُرفض في الخادم. */

const SESSION_KEY = 'rm_session_v1';
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

let S = null;              // آخر لقطة من الخادم
let ws = null, online = false, retry = 0, hb = null;
let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
let offset = 0;            // فرق ساعة الخادم عن ساعة الجهاز
let tab = 'teams';
let lastKey = '';
let duration = 35;
let pending = false;       // بطاقة أُرسل طلب كشفها ولم تصل لقطة بعد
let dragging = false;
let confirmFinish = 0;
const sentDrafts = {};
let teamsDirty = false;
let R = null;              // مراجع عناصر الغرفة
let H = null;              // مراجع الصفحة الرئيسية

// ───────────── أدوات ─────────────
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(kid)); }
  return el;
}
let toastTimer;
function toast(msg, info) {
  $toast.textContent = msg;
  $toast.className = 'show' + (info ? ' info' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = ''; }, 2600);
}
const nowSrv = () => Date.now() + offset;
const teamById = (id) => S.teams.find((t) => t.id === id);
const isHost = () => S.you.role === 'host';
const fmtSec = (ms) => (ms / 1000).toFixed(2);

// ───────────── الاتصال ─────────────
function send(msg) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
  toast('لا يوجد اتصال بالخادم — تتم إعادة المحاولة');
  return false;
}
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    online = true; retry = 0;
    if (session) send({ t: 'resume', code: session.code, playerId: session.playerId, secret: session.secret });
    clearInterval(hb);
    hb = setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 15000);
    update();
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'session') {
      session = { code: m.code, playerId: m.playerId, secret: m.secret };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* وضع خاص */ }
    } else if (m.t === 'state') {
      S = m.s; offset = S.serverNow - Date.now(); pending = false; update();
    } else if (m.t === 'err') {
      if (m.code === 'no_room' || m.code === 'bad_session') { if (session && !S) clearSession(); }
      toast(m.msg);
      pending = false;
    }
  };
  ws.onclose = () => {
    online = false; clearInterval(hb);
    setTimeout(connect, Math.min(4000, 400 * 2 ** retry++));
    update();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* */ } };
}
function clearSession() {
  session = null; S = null;
  try { localStorage.removeItem(SESSION_KEY); } catch { /* */ }
  update();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) { retry = 0; connect(); }
});
window.addEventListener('online', () => { if (!ws || ws.readyState > 1) connect(); });

// ───────────── الصفحة الرئيسية ─────────────
function buildHome() {
  const qs = new URLSearchParams(location.search);
  const name1 = h('input', { class: 'field', placeholder: 'اسمك', maxlength: 24, autocomplete: 'off', enterkeyhint: 'go' });
  const code = h('input', { class: 'field', placeholder: 'رمز الغرفة', maxlength: 5, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', dir: 'ltr', style: 'text-align:center;letter-spacing:6px;font-weight:800', value: (qs.get('room') || '').toUpperCase() });
  const name2 = h('input', { class: 'field', placeholder: 'اسمك', maxlength: 24, autocomplete: 'off', enterkeyhint: 'go' });
  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  const create = h('button', { class: 'btn primary', text: 'إنشاء غرفة', onclick: () => send({ t: 'create', name: name1.value }) });
  const join = h('button', { class: 'btn primary', text: 'دخول الغرفة', onclick: () => send({ t: 'join', code: code.value, name: name2.value }) });
  name1.addEventListener('keydown', (e) => { if (e.key === 'Enter') create.click(); });
  name2.addEventListener('keydown', (e) => { if (e.key === 'Enter') join.click(); });
  const el = h('div', { class: 'home col scroll' },
    h('div', { class: 'brand' }, h('div', { class: 'lock', text: '🔐' }), h('h1', { text: 'رسالة مشفّرة' }), h('p', { text: 'فكّ الجملة السرية قبل انتهاء الوقت' })),
    h('div', { class: 'panel glass' }, h('h2', { text: 'الانضمام إلى غرفة' }), code, name2, join),
    h('div', { class: 'panel glass' }, h('h2', { text: 'أنا المستضيف' }), name1, create),
    h('div', { class: 'net hidden', text: 'جارٍ الاتصال بالخادم…' }));
  H = { el, net: el.lastChild };
  if (qs.get('room')) name2.focus();
  return el;
}

// ───────────── إطار الغرفة ─────────────
function buildRoom() {
  const code = h('button', { class: 'roomcode', title: 'نسخ رابط الدعوة', onclick: copyLink });
  const me = h('span', { class: 'me muted' });
  const leave = h('button', { class: 'btn small icon', text: '⎋', 'aria-label': 'خروج', onclick: () => { if (confirm('الخروج من الغرفة؟')) { try { ws.close(); } catch { /* */ } clearSession(); } } });
  const net = h('div', { class: 'net hidden', text: 'انقطع الاتصال — جارٍ إعادة الاتصال…' });
  const tGame = h('button', { class: 'tab', text: '🎮 اللعبة', onclick: () => setTab('game') });
  const tTeams = h('button', { class: 'tab', text: '👥 الفرق', onclick: () => setTab('teams') });
  const vGame = h('div', { class: 'view' });
  const vTeams = h('div', { class: 'view scroll' });

  R = { code, me, net, tGame, tTeams, vGame, vTeams, idleKey: '', footKey: '' };
  buildIdle(); buildPlay();
  vTeams.addEventListener('focusout', () => setTimeout(() => { if (teamsDirty && !formActive()) { teamsDirty = false; updateTeams(); } }, 50));
  return h('div', { class: 'col hidden', style: 'flex:1;min-height:0;gap:0' },
    h('div', { class: 'topbar' }, h('span', { class: 'title', text: '🔐 رسالة مشفّرة' }), me, code, leave),
    net,
    h('div', { class: 'main' }, vGame, vTeams),
    h('div', { class: 'tabs' }, tGame, tTeams));
}
function copyLink() {
  const url = `${location.origin}/?room=${S.room.code}`;
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('تم نسخ رابط الدعوة', true), () => { prompt('رابط الدعوة', url); });
}
function setTab(t) { tab = t; applyTab(); if (t === 'teams') updateTeams(); else updateGame(); }
function applyTab() {
  R.vGame.classList.toggle('hidden', tab !== 'game');
  R.vTeams.classList.toggle('hidden', tab !== 'teams');
  R.tGame.classList.toggle('on', tab === 'game');
  R.tTeams.classList.toggle('on', tab === 'teams');
}
function formActive() { const a = document.activeElement; return !!a && R.vTeams.contains(a) && /INPUT|TEXTAREA/.test(a.tagName); }

// ───────────── تبويب اللعبة: الانتظار ─────────────
function buildIdle() { R.idle = h('div', { class: 'idle col scroll hidden' }); R.vGame.append(R.idle); }

function updateIdle() {
  const rd = S.round;
  const team = rd ? teamById(rd.teamId) : null;
  const key = JSON.stringify([S.room.allDone, rd && rd.teamId, team && [team.name, team.status, team.leaderId], isHost(), S.you.teamId, team && team.members.length]);
  if (key === R.idleKey) return;
  R.idleKey = key;
  const box = R.idle;
  box.replaceChildren();
  if (S.room.allDone) {
    box.append(h('div', { class: 'big', text: '🏁' }), h('h2', { text: 'انتهت جولات جميع الفرق' }), h('div', { class: 'muted', text: 'راجع النتائج في تبويب الفرق' }));
    return;
  }
  if (!team) {
    box.append(h('div', { class: 'big', text: '📡' }), h('h2', { text: isHost() ? 'اختر الفريق الذي سيلعب' : 'بانتظار المستضيف' }),
      h('div', { class: 'muted', text: isHost() ? 'أنشئ الفرق وأدخل الجمل السرية ثم اختر فريقًا من تبويب الفرق.' : 'سيبدأ المستضيف جولة قريبًا.' }));
    return;
  }
  const leader = team.members.find((m) => m.id === team.leaderId);
  box.append(h('div', { class: 'big', text: '⏳' }), h('h2', { text: 'بانتظار بدء الجولة' }),
    h('div', { style: 'font-size:20px;font-weight:800', text: team.name }),
    h('div', { class: 'muted', text: leader ? `👑 القائد: ${leader.name}` : 'لا يوجد قائد لهذا الفريق بعد' }));
  if (isHost()) {
    const lbl = h('b', { text: `${duration} ثانية` });
    const rng = h('input', { type: 'range', min: S.limits.min, max: S.limits.max, step: 1, value: duration });
    rng.addEventListener('input', () => { duration = +rng.value; lbl.textContent = `${duration} ثانية`; });
    const ready = team.status === 'READY';
    box.append(h('div', { class: 'ctrl glass col' },
      h('div', { class: 'row' }, h('span', { class: 'grow', text: 'مدة الجولة' }), lbl), rng,
      ready ? null : h('div', { class: 'pill warn', text: 'أدخل الجملة السرية لهذا الفريق من تبويب الفرق' }),
      h('button', { class: 'btn primary', text: 'بدء اللعب', disabled: !ready, onclick: () => send({ t: 'startRound', durationSec: duration }) })));
  }
}

// ───────────── تبويب اللعبة: الجولة ─────────────
function buildPlay() {
  const tname = h('div', { class: 'tname' });
  const badge = h('span', { class: 'pill' });
  const timer = h('div', { class: 'timer off', text: '--:--' });
  const chips = h('div', { class: 'chips' });
  const cards = [];
  const board = h('div', { class: 'board' });
  const foot = h('div', { class: 'foot' });
  const codebox = h('div', { class: 'codebox glass' }, h('div', { class: 'lbl', text: '🔐 الشفرة المطلوب فكها' }), chips);
  const play = h('div', { class: 'play hidden' },
    h('div', { class: 'gbar' }, h('div', { class: 'col', style: 'gap:4px;min-width:0' }, tname, badge), timer),
    codebox, board, foot);
  Object.assign(R, { play, tname, badge, timer, chips, board, foot, cards, revealKey: '' });
  R.vGame.append(play);

  for (let i = 0; i < 30; i++) {
    const txt = h('span', { class: 'txt' });
    const bar = h('em', { class: 'bar' });
    const pips = h('i', { class: 'pips' }, h('u'), h('u'));
    const sym = h('b', { text: '·', style: 'font-weight:400' });
    const el = h('button', { class: 'card', 'data-i': i, 'aria-label': `بطاقة ${i + 1}` },
      h('span', { class: 'inner' }, h('span', { class: 'face front' }, sym, pips), h('span', { class: 'face back' }, txt, bar)));
    cards.push({ el, txt, bar, pips, sym });
    board.append(el);
  }
  board.addEventListener('click', (e) => {
    const c = e.target.closest('.card'); if (!c) return;
    const rd = S && S.round;
    if (!rd || !canControl() || rd.active || pending) return;
    const i = +c.dataset.i;
    if (rd.counts[i] >= rd.maxReveals) return;
    pending = true;
    send({ t: 'revealCard', card: i });
  });
  initSort();
}

function amLeader() { const rd = S.round; if (!rd) return false; const t = teamById(rd.teamId); return !!t && t.leaderId === S.you.id && S.you.teamId === rd.teamId; }
function canControl() { return !!S && !!S.round && S.round.status === 'ACTIVE' && amLeader(); }

function updatePlay() {
  const rd = S.round, team = teamById(rd.teamId);
  const leader = amLeader();
  const control = canControl();
  R.tname.textContent = team.name;
  const st = rd.status;
  const b = R.badge;
  if (st === 'ACTIVE') { b.textContent = 'الجولة جارية'; b.className = 'pill live'; }
  else if (st === 'ANSWERING') { b.textContent = 'مرحلة الإجابة'; b.className = 'pill warn'; }
  else { const ok = rd.result && rd.result.verdict === 'CORRECT'; b.textContent = ok ? 'تم الحل' : 'انتهت الجولة'; b.className = 'pill ' + (ok ? 'ok' : 'bad'); }

  R.play.classList.toggle('watch', !control);
  R.board.classList.toggle('hidden', st !== 'ACTIVE');
  renderChips(rd.order, rd.n, control);

  // البطاقات
  rd.counts.forEach((cnt, i) => {
    const c = R.cards[i];
    if (c.sym.textContent !== S.symbols[i]) c.sym.textContent = S.symbols[i];
    c.pips.children[0].classList.toggle('used', cnt >= 1);
    c.pips.children[1].classList.toggle('used', cnt >= 2);
    c.el.classList.toggle('locked', cnt >= rd.maxReveals);
    c.el.classList.toggle('dis', !control);
    c.el.disabled = false;
    const shown = !!rd.active && rd.active.card === i && st === 'ACTIVE';
    c.el.classList.toggle('flip', shown);
  });
  const a = rd.active;
  const rk = a ? `${a.card}:${a.until}` : '';
  if (rk !== R.revealKey) {
    R.revealKey = rk;
    if (a) {
      const c = R.cards[a.card];
      c.txt.textContent = a.text;
      c.txt.style.fontSize = a.text.length <= 4 ? '22px' : a.text.length <= 7 ? '17px' : '13px';
      const left = Math.max(60, a.until - nowSrv());
      c.bar.classList.remove('run'); void c.bar.offsetWidth;
      c.bar.style.animationDuration = left + 'ms'; c.bar.classList.add('run');
    }
  }
  updateFoot(rd, team, leader);
  tick();
}

function updateFoot(rd, team, leader) {
  const st = rd.status;
  const key = [st, leader, isHost(), S.you.teamId === team.id, rd.result ? 1 : 0, S.room.allDone].join('|');
  if (key !== R.footKey) {
    R.footKey = key; confirmFinish = 0;
    const f = R.foot; f.replaceChildren();
    if (st === 'ACTIVE') {
      if (leader) {
        const btn = h('button', { class: 'btn danger', text: 'إنهاء ومحاولة الحل', onclick: () => {
          if (Date.now() < confirmFinish) { confirmFinish = 0; send({ t: 'finishEarly' }); return; }
          confirmFinish = Date.now() + 3000; btn.textContent = 'اضغط مرة أخرى للتأكيد';
          setTimeout(() => { if (btn.isConnected && Date.now() >= confirmFinish) { btn.textContent = 'إنهاء ومحاولة الحل'; } }, 3100);
        } });
        f.append(btn);
      } else f.append(h('div', { class: 'watchmsg', text: '👁️ وضع المشاهدة — قائد الفريق وحده يتحكم باللوحة' }));
    } else if (st === 'ANSWERING') {
      if (leader) {
        const input = h('input', { class: 'field', id: 'ans', placeholder: 'اكتب الجملة كاملة', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send', maxlength: 300 });
        let t; input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => send({ t: 'setDraft', text: input.value }), 200); });
        const go = h('button', { class: 'btn primary', text: 'إرسال الإجابة', onclick: () => { go.disabled = true; send({ t: 'submitAnswer', text: input.value }); setTimeout(() => { go.disabled = false; }, 1500); } });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
        f.append(h('div', { class: 'answer glass col' },
          h('h3', { text: rd.endReason === 'timeout' ? '⏱️ انتهى الوقت — أدخل الجملة النهائية' : 'أدخل الجملة النهائية' }),
          input, go, h('div', { class: 'muted', style: 'font-size:13px', text: 'محاولة واحدة فقط — لا تُحتسب المسافات والتشكيل وعلامات الترقيم.' })));
      } else {
        R.draftBox = h('div', { class: 'draft' });
        f.append(h('div', { class: 'answer glass col' }, h('div', { class: 'typing', text: '👑 القائد يقوم بكتابة الإجابة...' }), (isHost() || S.you.teamId === team.id) ? R.draftBox : null));
      }
    } else {
      const r = rd.result || {};
      const ok = r.verdict === 'CORRECT';
      f.append(h('div', { class: 'result glass col ' + (ok ? 'ok' : 'bad') },
        h('h3', { text: ok ? '✅ تم الحل بنجاح' : '❌ إجابة خاطئة' }),
        ok ? h('div', { class: 'time', text: `تم الحل في ${fmtSec(r.solveMs)} ثانية` }) : h('div', { class: 'muted', text: 'لا توجد محاولة ثانية — الجولة غير محلولة' }),
        h('div', { class: 'cmp' }, h('div', {}, h('b', { text: 'الجملة: ' }), r.sentence || ''), ok ? null : h('div', {}, h('b', { text: 'إجابة القائد: ' }), r.answer || '(فارغة)')),
        h('div', { class: 'muted', text: `كشف ${r.reveals} · بطاقات مستنفدة ${r.exhausted} · عمليات ${r.ops}` }),
        h('div', { class: 'pill', style: 'align-self:center', text: 'الجولة انتهت' }),
        isHost() ? h('button', { class: 'btn primary', text: 'بدء الفريق التالي', onclick: () => send({ t: 'nextTeam' }) }) : null));
    }
  }
  if (st === 'ANSWERING' && !leader && R.draftBox && R.draftBox.isConnected) R.draftBox.textContent = rd.draft || '…';
}

function renderChips(order, n, control) {
  if (dragging) return;
  const cur = [...R.chips.children].map((c) => +c.dataset.i);
  if (cur.join() !== order.join()) R.chips.replaceChildren(...order.map((i) => h('div', { class: 'chip', 'data-i': i, text: S.symbols[i] })));
  R.chips.classList.toggle('can', control);
  R.chips.classList.toggle('sm', n > 12);
}

// ───────────── سحب وإفلات (لمس + ماوس، Pointer Events) ─────────────
function initSort() {
  const box = R.chips;
  let d = null, lastSend = 0;
  const push = (force) => {
    const now = Date.now();
    if (!force && now - lastSend < 90) return;
    lastSend = now;
    send({ t: 'reorder', order: [...box.children].map((c) => +c.dataset.i) });
  };
  box.addEventListener('pointerdown', (e) => {
    if (!canControl()) return;
    const chip = e.target.closest('.chip'); if (!chip) return;
    d = { chip, id: e.pointerId, x: e.clientX, y: e.clientY, started: false, ghost: null };
    try { box.setPointerCapture(e.pointerId); } catch { /* */ }
    e.preventDefault();
  });
  box.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
      d.started = true; dragging = true;
      const r = d.chip.getBoundingClientRect();
      d.ghost = d.chip.cloneNode(true);
      d.ghost.classList.add('float');
      d.ghost.style.width = r.width + 'px'; d.ghost.style.height = r.height + 'px';
      document.body.append(d.ghost);
      d.chip.classList.add('ghost');
      if (navigator.vibrate) navigator.vibrate(8);
    }
    const g = d.ghost;
    g.style.left = e.clientX - g.offsetWidth / 2 + 'px';
    g.style.top = e.clientY - g.offsetHeight / 2 - 18 + 'px';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under && under.closest ? under.closest('.chip') : null;
    if (target && target !== d.chip && box.contains(target)) {
      const kids = [...box.children];
      box.insertBefore(d.chip, kids.indexOf(target) > kids.indexOf(d.chip) ? target.nextSibling : target);
      push(false);
    }
  });
  const end = (e) => {
    if (!d || e.pointerId !== d.id) return;
    const was = d.started;
    if (d.ghost) d.ghost.remove();
    d.chip.classList.remove('ghost');
    d = null; dragging = false;
    if (was) push(true);
    else if (S) update();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// ───────────── المؤقت ─────────────
function tick() {
  if (!S || !R || !R.timer) return;
  const rd = S.round, T = R.timer;
  if (!rd || rd.status === 'WAITING') { T.textContent = '--:--'; T.className = 'timer off'; return; }
  let ms = 0;
  if (rd.status === 'ACTIVE') ms = Math.max(0, rd.endsAt - nowSrv());
  const sec = Math.ceil(ms / 1000);
  T.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  T.className = 'timer' + (rd.status !== 'ACTIVE' ? ' off' : sec <= 5 ? ' crit' : sec <= 10 ? ' low' : '');
}
setInterval(tick, 100);

// ───────────── تبويب الفرق ─────────────
const STATUS = { NO_SENTENCE: ['بلا جملة', ''], READY: ['جاهز', 'live'], ACTIVE: ['يلعب الآن', 'live'], ANSWERING: ['يجيب', 'warn'] };

function updateTeams() {
  if (formActive()) { teamsDirty = true; return; }
  const host = isHost();
  const el = h('div', { class: 'teams col' });
  el.append(h('div', { class: 'muted', style: 'font-size:13px', text: `المستضيف: ${S.host.name}` }));

  if (host) {
    const nm = h('input', { class: 'field grow', placeholder: 'اسم فريق جديد', maxlength: 30, enterkeyhint: 'done', value: sentDrafts.__newTeam || '' });
    nm.addEventListener('input', () => { sentDrafts.__newTeam = nm.value; });
    const add = () => { if (nm.value.trim()) { send({ t: 'createTeam', name: nm.value }); sentDrafts.__newTeam = ''; nm.value = ''; } };
    nm.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    el.append(h('div', { class: 'row' }, nm, h('button', { class: 'btn', text: '➕ فريق', onclick: add })));
  }
  if (!S.teams.length) el.append(h('div', { class: 'glass panel muted', text: host ? 'ابدأ بإنشاء فريق واحد على الأقل، ثم يختار اللاعبون فرقهم.' : 'لم ينشئ المستضيف فرقًا بعد.' }));

  const inPlay = S.teams.some((t) => t.status === 'ACTIVE' || t.status === 'ANSWERING');
  S.teams.forEach((t, idx) => {
    const [label, cls0] = STATUS[t.status] || ['', ''];
    let cls = cls0, text = label;
    if (t.status === 'FINISHED') { const ok = t.result && t.result.verdict === 'CORRECT'; text = ok ? 'حُلّت' : 'لم تُحل'; cls = ok ? 'ok' : 'bad'; }
    const mine = S.you.teamId === t.id;
    const card = h('div', { class: 'team glass col' + (S.room.activeTeamId === t.id ? ' current' : '') });
    card.append(h('div', { class: 'row' }, h('h3', { class: 'grow', text: t.name + (S.room.activeTeamId === t.id ? ' ◀' : '') }), h('span', { class: 'pill ' + cls, text })));

    const members = h('div', { class: 'members' });
    if (!t.members.length) members.append(h('div', { class: 'muted', style: 'font-size:14px', text: 'لا يوجد لاعبون' }));
    for (const m of t.members) {
      members.append(h('div', { class: 'member' }, h('span', { class: 'dot' + (m.online ? ' on' : '') }),
        h('span', { class: 'grow', text: (m.id === t.leaderId ? '👑 ' : '') + m.name + (m.id === S.you.id ? ' (أنت)' : '') }),
        host && m.id !== t.leaderId ? h('button', { class: 'btn small', text: 'اجعله قائدًا', onclick: () => send({ t: 'setLeader', teamId: t.id, playerId: m.id }) }) : null));
    }
    card.append(members);

    if (!host) {
      card.append(mine
        ? h('button', { class: 'btn small', text: 'مغادرة الفريق (مشاهد)', onclick: () => send({ t: 'joinTeam', teamId: null }) })
        : h('button', { class: 'btn small primary', text: 'انضمام إلى الفريق', onclick: () => send({ t: 'joinTeam', teamId: t.id }) }));
    } else {
      const ta = h('textarea', { class: 'field', placeholder: 'الجملة السرية لهذا الفريق…', dir: 'rtl', maxlength: 200, value: sentDrafts[t.id] ?? t.sentence ?? '', disabled: t.status === 'ACTIVE' || t.status === 'ANSWERING' || t.status === 'FINISHED' });
      ta.addEventListener('input', () => { sentDrafts[t.id] = ta.value; });
      card.append(ta);
      if (t.tokens) card.append(h('div', { class: 'tokens' }, t.tokens.map((k) => h('span', { class: 'tok', text: k }))), h('div', { class: 'muted', style: 'font-size:12px', text: `${t.tokens.length} عناصر في الشفرة (المسموح ${S.limits.tokensMin}–${S.limits.tokensMax}). ^ قبل الكلمة تمنع فصلها، والتطويلة ـ تفصل الحرف السابق.` }));
      const locked = t.status === 'ACTIVE' || t.status === 'ANSWERING' || t.status === 'FINISHED';
      card.append(h('div', { class: 'row' },
        h('button', { class: 'btn small primary grow', text: 'حفظ وتوليد اللغز', disabled: locked, onclick: () => { send({ t: 'setSentence', teamId: t.id, sentence: ta.value }); delete sentDrafts[t.id]; } }),
        h('button', { class: 'btn small', text: 'اختيار', disabled: inPlay || t.status === 'FINISHED' || S.room.activeTeamId === t.id, onclick: () => { send({ t: 'selectTeam', teamId: t.id }); tab = 'game'; applyTab(); } }),
        h('button', { class: 'btn small icon', text: '▲', 'aria-label': 'أعلى', disabled: idx === 0, onclick: () => send({ t: 'moveTeam', teamId: t.id, dir: 'up' }) }),
        h('button', { class: 'btn small icon', text: '▼', 'aria-label': 'أسفل', disabled: idx === S.teams.length - 1, onclick: () => send({ t: 'moveTeam', teamId: t.id, dir: 'down' }) }),
        h('button', { class: 'btn small icon danger', text: '✕', 'aria-label': 'حذف', disabled: t.status === 'ACTIVE' || t.status === 'ANSWERING', onclick: () => { if (confirm(`حذف فريق «${t.name}»؟`)) send({ t: 'removeTeam', teamId: t.id }); } })));
    }
    el.append(card);
  });

  if (S.spectators.length) {
    el.append(h('div', { class: 'sectitle', text: `مشاهدون (${S.spectators.length})` }),
      h('div', { class: 'glass panel' }, S.spectators.map((m) => h('div', { class: 'member' }, h('span', { class: 'dot' + (m.online ? ' on' : '') }), m.name + (m.id === S.you.id ? ' (أنت)' : '')))));
  }

  const done = S.teams.filter((t) => t.result);
  if (done.length) {
    const rows = done.map((t) => {
      const r = t.result, ok = r.verdict === 'CORRECT';
      return h('tr', {}, h('td', { text: t.name }), h('td', { text: ok ? '✅' : '❌' }), h('td', { text: ok ? fmtSec(r.solveMs) : '—' }), h('td', { text: r.reveals }), h('td', { text: r.exhausted }), h('td', { text: r.ops }));
    });
    const solved = done.filter((t) => t.result.verdict === 'CORRECT').length;
    el.append(h('div', { class: 'sectitle', text: `النتائج — حُلّت ${solved} من ${done.length}` }),
      h('div', { class: 'glass panel wrap-x' }, h('table', { class: 'res' },
        h('thead', {}, h('tr', {}, ['الفريق', 'الحل', 'الزمن (ث)', 'كشف', 'استنفاد', 'عمليات'].map((x) => h('th', { text: x })))), h('tbody', {}, rows)),
      h('div', { class: 'muted', style: 'font-size:12px', text: 'الأساس هو صحة الإجابة. الأعمدة الأخرى بيانات لكسر التعادل فقط، وقاعدة الحسم لم تُحدَّد بعد.' })));
  }
  R.vTeams.replaceChildren(el);
}

// ───────────── التحديث العام ─────────────
function updateGame() {
  const rd = S.round;
  const playing = rd && rd.status !== 'WAITING';
  R.idle.classList.toggle('hidden', !!playing);
  R.play.classList.toggle('hidden', !playing);
  if (playing) updatePlay(); else updateIdle();
}

function update() {
  if (!$app.firstChild) { $app.append(buildHome()); }
  if (!R && S) { const room = buildRoom(); R = Object.assign(R, { el: room }); $app.append(room); }
  if (!S) {
    if (R) { R.el.classList.add('hidden'); }
    H.el.classList.remove('hidden');
    H.net.classList.toggle('hidden', online);
    return;
  }
  H.el.classList.add('hidden');
  R.el.classList.remove('hidden');
  R.net.classList.toggle('hidden', online);
  R.code.textContent = S.room.code;
  const role = isHost() ? 'مستضيف' : S.you.teamId ? (amLeaderOfMyTeam() ? 'قائد' : 'عضو') : 'مشاهد';
  R.me.textContent = `${S.you.name} · ${role}`;

  const key = S.round ? `${S.round.teamId}:${S.round.status}` : 'none';
  if (key !== lastKey) {
    if (lastKey === '' && S.round && S.round.status !== 'WAITING') tab = 'game';
    else if (S.round && S.round.status === 'ACTIVE') tab = 'game';
    lastKey = key;
  }
  applyTab();
  updateGame();
  updateTeams();
}
function amLeaderOfMyTeam() { const t = S.you.teamId && teamById(S.you.teamId); return !!t && t.leaderId === S.you.id; }

// ───────────── لوحة المفاتيح على iOS ─────────────
if (window.visualViewport) {
  const fit = () => { $app.style.height = window.visualViewport.height + 'px'; window.scrollTo(0, 0); };
  window.visualViewport.addEventListener('resize', fit);
  window.visualViewport.addEventListener('scroll', fit);
}
document.addEventListener('gesturestart', (e) => e.preventDefault());

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
update();
connect();
})();
