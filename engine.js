'use strict';
/**
 * محرك اللعبة — المصدر الوحيد للحقيقة. لا يعرف شيئًا عن الشبكة:
 * كل دالة تستقبل (room, player, payload) وتُطلق GameError عند الرفض.
 * الوقت والمؤقتات قابلة للحقن لتُختبر بدقة دون انتظار حقيقي.
 */
const crypto = require('crypto');
const { tokenize, answerMatches } = require('./arabic');
const { generateValidPuzzle, validatePuzzle, SYMBOLS, BOARD_SIZE, MAX_REVEALS, MIN_TOKENS, MAX_TOKENS } = require('./puzzle');

const LIMITS = {
  minDuration: 25, maxDuration: 90, defaultDuration: 35, revealMs: 1000,
  maxTeams: 12, maxPlayers: 150, maxRooms: 500, maxAnswerLen: 300, maxSentenceLen: 200,
};

class GameError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new GameError(code, message); };

const TRANSITIONS = {
  WAITING: ['ACTIVE'], ACTIVE: ['ANSWERING'], ANSWERING: ['CORRECT', 'WRONG'],
  CORRECT: ['FINISHED'], WRONG: ['FINISHED'], FINISHED: [],
};
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const cleanName = (s, max = 24) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

class Engine {
  constructor(env = {}) {
    this.now = env.now || (() => performance.now());
    this.wall = env.wall || (() => Date.now());
    this.setTimeout = env.setTimeout || ((f, ms) => setTimeout(f, ms));
    this.clearTimeout = env.clearTimeout || ((id) => clearTimeout(id));
    this.rand = env.random || Math.random;
    this.rooms = new Map();
  }

  // ───────────────────────── الغرف واللاعبون ─────────────────────────
  createRoom(name) {
    name = cleanName(name);
    if (!name) fail('bad_name', 'اكتب اسمك أولًا');
    if (this.rooms.size >= LIMITS.maxRooms) fail('busy', 'الخادم ممتلئ حاليًا، حاول لاحقًا');
    let code;
    do { code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (this.rooms.has(code));
    const room = { code, players: new Map(), teams: [], hostId: null, activeTeamId: null, allDone: false, lastActive: this.now() };
    const host = this._addPlayer(room, name, 'host');
    room.hostId = host.id;
    this.rooms.set(code, room);
    return { room, player: host };
  }

  joinRoom(code, name) {
    const room = this._room(code);
    name = cleanName(name);
    if (!name) fail('bad_name', 'اكتب اسمك أولًا');
    if (room.players.size >= LIMITS.maxPlayers) fail('full', 'الغرفة ممتلئة');
    const player = this._addPlayer(room, name, 'player');
    return { room, player };
  }

  resume(code, playerId, secret) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) fail('no_room', 'الغرفة غير موجودة أو انتهت');
    const player = room.players.get(playerId);
    const a = Buffer.from(String(secret || ''));
    const b = Buffer.from(player ? player.secret : '');
    if (!player || a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail('bad_session', 'الجلسة غير صالحة');
    return { room, player };
  }

  attach(room, player, conn) { player.conns.add(conn); this._touch(room); }
  detach(room, player, conn) { player.conns.delete(conn); this._touch(room); }

  sweep(maxIdleMs) {
    for (const [code, room] of this.rooms) {
      const online = [...room.players.values()].some((p) => p.conns.size > 0);
      if (!online && this.now() - room.lastActive > maxIdleMs) {
        for (const t of room.teams) if (t.round) this._clearTimers(t.round);
        this.rooms.delete(code);
      }
    }
  }

  _room(code) {
    const room = this.rooms.get(String(code || '').toUpperCase().trim());
    if (!room) fail('no_room', 'رمز الغرفة غير صحيح');
    return room;
  }

  _addPlayer(room, name, role) {
    let final = name, k = 2;
    const taken = new Set([...room.players.values()].map((p) => p.name));
    while (taken.has(final)) final = `${name} ${k++}`;
    const p = { id: newId(6), secret: newId(16), name: final, role, teamId: null, conns: new Set() };
    room.players.set(p.id, p);
    return p;
  }

  _touch(room) {
    room.lastActive = this.now();
    for (const p of room.players.values()) {
      if (!p.conns.size) continue;
      const msg = { t: 'state', s: this.snapshot(room, p) };
      for (const c of p.conns) { try { c.sendJSON(msg); } catch { /* الاتصال سيُزال عند إغلاقه */ } }
    }
  }

  // ───────────────────────── صلاحيات مساعدة ─────────────────────────
  _requireHost(room, player) { if (player.role !== 'host' || room.hostId !== player.id) fail('not_host', 'هذه العملية للمستضيف فقط'); }
  _team(room, id) { const t = room.teams.find((x) => x.id === id); if (!t) fail('no_team', 'الفريق غير موجود'); return t; }
  _active(room) { return room.teams.find((t) => t.id === room.activeTeamId) || null; }
  _inPlay(team) { return !!team.round && (team.round.status === 'ACTIVE' || team.round.status === 'ANSWERING'); }
  _anyInPlay(room) { return room.teams.some((t) => this._inPlay(t)); }

  _leaderRound(room, player) {
    const team = this._active(room);
    if (!team || !team.round) fail('no_round', 'لا توجد جولة نشطة');
    if (player.teamId !== team.id || team.leaderId !== player.id) fail('not_leader', 'هذه العملية لقائد الفريق الذي يلعب فقط');
    return { team, round: team.round };
  }

  _transition(round, to) {
    if (!TRANSITIONS[round.status].includes(to)) throw new Error(`انتقال غير مسموح ${round.status}→${to}`);
    round.status = to;
    round.history.push({ status: to, at: this.now() });
  }

  _clearTimers(round) {
    if (round.endTimer != null) { this.clearTimeout(round.endTimer); round.endTimer = null; }
    if (round.revealTimer != null) { this.clearTimeout(round.revealTimer); round.revealTimer = null; }
    round.activeReveal = null;
  }

  // ───────────────────────── إدارة الفرق (المستضيف) ─────────────────────────
  createTeam(room, player, { name }) {
    this._requireHost(room, player);
    name = cleanName(name, 30);
    if (!name) fail('bad_name', 'اكتب اسم الفريق');
    if (room.teams.length >= LIMITS.maxTeams) fail('too_many', `الحد الأقصى ${LIMITS.maxTeams} فريقًا`);
    if (room.teams.some((t) => t.name === name)) fail('dup', 'اسم الفريق مستخدم');
    room.teams.push({ id: newId(4), name, leaderId: null, sentence: '', tokens: null, puzzle: null, round: null });
    this._touch(room);
  }

  removeTeam(room, player, { teamId }) {
    this._requireHost(room, player);
    const team = this._team(room, teamId);
    if (this._inPlay(team)) fail('busy', 'لا يمكن حذف فريق يلعب الآن');
    for (const p of room.players.values()) if (p.teamId === team.id) p.teamId = null;
    room.teams = room.teams.filter((t) => t !== team);
    if (room.activeTeamId === team.id) room.activeTeamId = null;
    this._touch(room);
  }

  moveTeam(room, player, { teamId, dir }) {
    this._requireHost(room, player);
    const i = room.teams.findIndex((t) => t.id === teamId);
    if (i < 0) fail('no_team', 'الفريق غير موجود');
    const j = i + (dir === 'up' ? -1 : 1);
    if (j < 0 || j >= room.teams.length) return;
    [room.teams[i], room.teams[j]] = [room.teams[j], room.teams[i]];
    this._touch(room);
  }

  selectTeam(room, player, { teamId }) {
    this._requireHost(room, player);
    if (this._anyInPlay(room)) fail('busy', 'انتظر انتهاء الجولة الحالية');
    const team = this._team(room, teamId);
    if (team.round && team.round.status === 'FINISHED') fail('played', 'هذا الفريق أنهى جولته');
    room.activeTeamId = team.id;
    room.allDone = false;
    this._touch(room);
  }

  nextTeam(room, player) {
    this._requireHost(room, player);
    if (this._anyInPlay(room)) fail('busy', 'انتظر انتهاء الجولة الحالية');
    const cur = room.teams.findIndex((t) => t.id === room.activeTeamId);
    const n = room.teams.length;
    for (let k = 1; k <= n; k++) {
      const t = room.teams[(cur + k + n) % n];
      if (!t.round || t.round.status !== 'FINISHED') { room.activeTeamId = t.id; room.allDone = false; this._touch(room); return; }
    }
    room.allDone = true;
    this._touch(room);
  }

  setLeader(room, player, { teamId, playerId }) {
    this._requireHost(room, player);
    const team = this._team(room, teamId);
    const target = room.players.get(playerId);
    if (!target || target.teamId !== team.id) fail('bad_player', 'اللاعب ليس عضوًا في هذا الفريق');
    team.leaderId = target.id; // ينتقل فورًا حتى أثناء الجولة؛ القائد القديم يفقد الصلاحية فورًا لأن الفحص ديناميكي في _leaderRound
    this._touch(room);
  }

  joinTeam(room, player, { teamId }) {
    if (player.role === 'host') fail('host_cannot', 'المستضيف لا يلعب ضمن فريق');
    const cur = player.teamId ? room.teams.find((t) => t.id === player.teamId) : null;
    const dest = teamId ? this._team(room, teamId) : null;
    if ((cur && this._inPlay(cur)) || (dest && this._inPlay(dest))) fail('busy', 'لا يمكن تغيير الفريق أثناء جولة نشطة');
    if (cur) {
      player.teamId = null;
      if (cur.leaderId === player.id) {
        const next = [...room.players.values()].find((p) => p.teamId === cur.id);
        cur.leaderId = next ? next.id : null;
      }
    }
    if (dest) {
      player.teamId = dest.id;
      if (!dest.leaderId) dest.leaderId = player.id; // أول عضو يصبح قائدًا افتراضيًا ويستطيع المستضيف تغييره
    }
    this._touch(room);
  }

  kickPlayer(room, player, { playerId }) {
    this._requireHost(room, player);
    const target = room.players.get(playerId);
    if (!target) fail('no_player', 'اللاعب غير موجود');
    if (target.id === room.hostId) fail('bad_player', 'لا يمكن طرد المستضيف');
    const team = target.teamId ? this._team(room, target.teamId) : null;
    if (team && team.leaderId === target.id) {
      const next = [...room.players.values()].find((p) => p.teamId === team.id && p.id !== target.id);
      team.leaderId = next ? next.id : null;
    }
    room.players.delete(target.id);
    for (const c of target.conns) { try { c.sendJSON({ t: 'kicked' }); c.close(4001); } catch { /* تجاهل */ } }
    target.conns.clear();
    this._touch(room);
  }

  // إعادة كل الفرق إلى حالة ما قبل الجولة: تصفير الجملة/اللغز/عدادات الكشف، مع إبقاء الفرق واللاعبين والقادة كما هم
  _resetAllRounds(room) {
    for (const t of room.teams) {
      if (t.round) this._clearTimers(t.round);
      t.sentence = ''; t.tokens = null; t.puzzle = null; t.round = null;
    }
    room.activeTeamId = null;
    room.allDone = false;
  }

  returnToLobby(room, player) {
    this._requireHost(room, player);
    if (this._anyInPlay(room)) fail('busy', 'انتظر انتهاء الجولة الحالية أولًا');
    this._resetAllRounds(room);
    this._touch(room);
  }

  replay(room, player) {
    this._requireHost(room, player);
    if (!room.allDone) fail('not_finished', 'يجب أن تنتهي جميع الفرق أولًا لإعادة اللعب');
    this._resetAllRounds(room);
    this._touch(room);
  }

  // قاعدة الترتيب الوحيدة: النقاط أولًا (حل صحيح = 1)، ثم وقت الحل لكسر التعادل — لا يُستخدم عدد العمليات/الكشف كمعيار مستقل إطلاقًا
  _ranking(room) {
    return room.teams
      .filter((t) => t.round && t.round.status === 'FINISHED')
      .map((t) => ({ teamId: t.id, name: t.name, verdict: t.round.result.verdict, score: t.round.result.score, solveMs: t.round.result.solveMs }))
      .sort((a, b) => (b.score - a.score) || ((a.solveMs ?? Infinity) - (b.solveMs ?? Infinity)));
  }

  // ───────────────────────── الجملة واللغز ─────────────────────────
  setSentence(room, player, { teamId, sentence }) {
    this._requireHost(room, player);
    const team = this._team(room, teamId);
    if (team.round && team.round.status !== 'WAITING') fail('locked', 'لا يمكن تغيير الجملة بعد بدء الجولة');
    sentence = String(sentence ?? '').trim();
    if (!sentence || sentence.length > LIMITS.maxSentenceLen) fail('bad_sentence', 'الجملة فارغة أو طويلة جدًا');
    const tokens = tokenize(sentence);
    if (tokens.length < MIN_TOKENS || tokens.length > MAX_TOKENS) {
      fail('bad_sentence', `عدد عناصر الجملة ${tokens.length}؛ المسموح من ${MIN_TOKENS} إلى ${MAX_TOKENS} عنصرًا`);
    }
    let puzzle;
    try { puzzle = generateValidPuzzle(tokens, this.rand); } catch (e) { fail('bad_puzzle', e.message); }
    team.sentence = sentence;
    team.tokens = tokens;
    team.puzzle = puzzle;
    team.round = {
      status: 'WAITING', history: [{ status: 'WAITING', at: this.now() }],
      durationSec: null, startMono: null, endsMono: null, answeringAt: null, endReason: null,
      code: puzzle.code, cards: puzzle.cards, order: [...puzzle.initialOrder],
      counts: new Array(BOARD_SIZE).fill(0), activeReveal: null, reveals: [], reorders: 0,
      draft: '', submitted: false, result: null, endTimer: null, revealTimer: null,
    };
    this._touch(room);
  }

  // ───────────────────────── دورة الجولة ─────────────────────────
  startRound(room, player, { durationSec }) {
    this._requireHost(room, player);
    const team = this._active(room);
    if (!team) fail('no_team', 'اختر الفريق الذي سيلعب أولًا');
    if (this._anyInPlay(room)) fail('busy', 'هناك جولة جارية');
    const round = team.round;
    if (!round || round.status !== 'WAITING') fail('no_puzzle', 'أدخل الجملة السرية لهذا الفريق أولًا');
    const leader = team.leaderId ? room.players.get(team.leaderId) : null;
    if (!leader) fail('no_leader', 'لا يوجد قائد لهذا الفريق');
    if (!leader.conns.size) fail('leader_offline', 'قائد الفريق غير متصل حاليًا');
    const d = durationSec === undefined ? LIMITS.defaultDuration : durationSec;
    if (!Number.isInteger(d) || d < LIMITS.minDuration || d > LIMITS.maxDuration) fail('bad_duration', `المدة من ${LIMITS.minDuration} إلى ${LIMITS.maxDuration} ثانية`);
    const v = validatePuzzle({ ...team.puzzle, revealCounts: round.counts, initialOrder: round.order });
    if (!v.ok) fail('bad_puzzle', 'اللغز غير صالح: ' + v.errors.join('، '));

    round.durationSec = d;
    round.startMono = this.now();
    round.endsMono = round.startMono + d * 1000;
    round.endsWall = this.wall() + d * 1000;
    this._transition(round, 'ACTIVE');
    round.endTimer = this.setTimeout(() => {
      round.endTimer = null;
      if (round.status === 'ACTIVE') { this._enterAnswering(round, 'timeout'); this._touch(room); }
    }, d * 1000);
    this._touch(room);
  }

  _enterAnswering(round, reason) {
    this._clearTimers(round);
    this._transition(round, 'ANSWERING');
    round.answeringAt = this.now();
    round.endReason = reason;
  }

  _expireIfDue(room, round) {
    if (round.status === 'ACTIVE' && this.now() >= round.endsMono) { this._enterAnswering(round, 'timeout'); this._touch(room); }
  }

  revealCard(room, player, { card }) {
    const { round } = this._leaderRound(room, player);
    this._expireIfDue(room, round);
    if (round.status !== 'ACTIVE') fail('not_active', 'الجولة ليست في مرحلة كشف البطاقات');
    if (!Number.isInteger(card) || card < 0 || card >= BOARD_SIZE) fail('bad_card', 'بطاقة غير صالحة');
    if (round.activeReveal) fail('busy', 'انتظر حتى تُغلق البطاقة المكشوفة');
    if (round.counts[card] >= MAX_REVEALS) fail('exhausted', 'هذه البطاقة استُنفدت');

    round.counts[card]++;
    const c = round.cards[card];
    const rev = { card, kind: c.kind, text: c.text, until: this.now() + LIMITS.revealMs, untilWall: this.wall() + LIMITS.revealMs };
    round.activeReveal = rev;
    round.reveals.push({ card, playerId: player.id, number: round.counts[card], at: this.now() - round.startMono });
    round.revealTimer = this.setTimeout(() => {
      round.revealTimer = null;
      if (round.activeReveal === rev) { round.activeReveal = null; this._touch(room); }
    }, LIMITS.revealMs);
    this._touch(room);
  }

  reorder(room, player, { order }) { // eslint-disable-line no-unused-vars
    this._leaderRound(room, player); // تحقق من الهوية فقط (لأجل رسائل خطأ متسقة مثل not_leader/not_active)
    fail('locked', 'ترتيب صندوق الشفرة ثابت ويطابق ترتيب الجملة الأصلية دائمًا ولا يمكن تغييره');
  }

  finishEarly(room, player) {
    const { round } = this._leaderRound(room, player);
    this._expireIfDue(room, round);
    if (round.status !== 'ACTIVE') fail('not_active', 'الجولة ليست نشطة');
    this._enterAnswering(round, 'early');
    this._touch(room);
  }

  setDraft(room, player, { text }) {
    const { round } = this._leaderRound(room, player);
    if (round.status !== 'ANSWERING' || round.submitted) return;
    if (typeof text !== 'string') return;
    round.draft = text.slice(0, LIMITS.maxAnswerLen);
    this._touch(room);
  }

  submitAnswer(room, player, { text }) {
    const { team, round } = this._leaderRound(room, player);
    if (round.status !== 'ANSWERING' || round.submitted) fail('not_answering', 'لا يمكن إرسال إجابة الآن');
    if (typeof text !== 'string' || text.length > LIMITS.maxAnswerLen) fail('bad_answer', 'الإجابة غير صالحة');
    const correct = answerMatches(text, team.tokens);
    const t = this.now();
    round.submitted = true;
    round.draft = text;
    const reveals = round.reveals.length;
    round.result = {
      verdict: correct ? 'CORRECT' : 'WRONG',
      score: correct ? 1 : 0,
      answer: text,
      sentence: team.sentence,
      solveMs: correct ? Math.round(t - round.startMono) : null,
      reachedAnswerMs: Math.round(round.answeringAt - round.startMono),
      submittedAtMs: Math.round(t - round.startMono),
      endReason: round.endReason,
      reveals,
      exhausted: round.counts.filter((c) => c >= MAX_REVEALS).length,
      ops: reveals + round.reorders + (round.endReason === 'early' ? 1 : 0),
    };
    this._transition(round, correct ? 'CORRECT' : 'WRONG');
    this._transition(round, 'FINISHED');
    this._touch(room);
  }

  // ───────────────────────── اللقطة المخصصة لكل لاعب (إخفاء الأسرار) ─────────────────────────
  _teamStatus(t) {
    if (!t.round) return t.puzzle ? 'READY' : 'NO_SENTENCE';
    return t.round.status === 'WAITING' ? 'READY' : t.round.status;
  }

  snapshot(room, viewer) {
    const isHost = viewer.role === 'host';
    const reveal = isHost || room.allDone; // بعد انتهاء جميع الفرق تُكشف النتائج للجميع؛ قبل ذلك للمستضيف فقط
    const players = [...room.players.values()];
    const active = this._active(room);
    const snap = {
      serverNow: this.wall(),
      symbols: SYMBOLS,
      limits: { min: LIMITS.minDuration, max: LIMITS.maxDuration, def: LIMITS.defaultDuration, tokensMin: MIN_TOKENS, tokensMax: MAX_TOKENS },
      room: { code: room.code, activeTeamId: room.activeTeamId, allDone: room.allDone },
      you: { id: viewer.id, name: viewer.name, role: viewer.role, teamId: viewer.teamId },
      host: { name: players.find((p) => p.id === room.hostId)?.name || '' },
      teams: room.teams.map((t) => ({
        id: t.id, name: t.name, leaderId: t.leaderId, status: this._teamStatus(t),
        members: players.filter((p) => p.teamId === t.id).map((p) => ({ id: p.id, name: p.name, online: p.conns.size > 0 })),
        sentence: isHost ? t.sentence : undefined,
        tokens: isHost ? t.tokens : undefined,
        result: reveal && t.round && t.round.status === 'FINISHED' ? t.round.result : undefined,
      })),
      spectators: players.filter((p) => p.role !== 'host' && !p.teamId).map((p) => ({ id: p.id, name: p.name, online: p.conns.size > 0 })),
      round: null,
      ranking: room.allDone ? this._ranking(room) : undefined,
    };
    if (active) {
      const r = active.round;
      const view = { teamId: active.id, status: r ? r.status : 'WAITING' };
      if (r && r.status !== 'WAITING') {
        Object.assign(view, {
          durationSec: r.durationSec, endsAt: r.endsWall, n: r.code.length,
          order: [...r.order], counts: [...r.counts], maxReveals: MAX_REVEALS,
          active: r.activeReveal ? { card: r.activeReveal.card, kind: r.activeReveal.kind, text: r.activeReveal.text, until: r.activeReveal.untilWall } : null,
          endReason: r.endReason,
        });
        if (isHost || viewer.teamId === active.id) view.draft = r.draft;
        if (reveal) view.result = r.result;
      }
      snap.round = view;
    }
    return snap;
  }
}

module.exports = { Engine, GameError, LIMITS };
