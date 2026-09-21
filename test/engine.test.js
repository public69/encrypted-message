'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, normalize, answerMatches } = require('../server/arabic');
const { generateValidPuzzle, validatePuzzle, directCountFor, SYMBOLS, MAX_TOKENS } = require('../server/puzzle');
const { Engine, GameError } = require('../server/engine');

// ───── ساعة وهمية ─────
function fakeEnv() {
  let t = 1000, id = 1; const timers = new Map();
  return {
    now: () => t, wall: () => 1_700_000_000_000 + t,
    setTimeout(fn, ms) { const k = id++; timers.set(k, { at: t + ms, fn }); return k; },
    clearTimeout(k) { timers.delete(k); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = target;
    },
  };
}
const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof GameError && (!code || e.code === code));

// ───── العربية ─────
test('tokenizer: المثال المرجعي', () => {
  assert.deepEqual(tokenize('العلم نور والعمل أساس النجاح'), ['العلم', 'نور', 'و', 'العمل', 'أساس', 'النجاح']);
  assert.deepEqual(tokenize('العلم نور و العمل أساس النجاح'), ['العلم', 'نور', 'و', 'العمل', 'أساس', 'النجاح']);
});
test('tokenizer: لا يفكك الكلمات العادية ويدعم الفصل الصريح ومنعه', () => {
  assert.deepEqual(tokenize('وطن فهم بالغة'), ['وطن', 'فهم', 'بالغة']);
  assert.deepEqual(tokenize('بالعلم وبالعمل'), ['ب', 'العلم', 'و', 'ب', 'العمل']);
  assert.deepEqual(tokenize('بـ العلم لـ النجاح'), ['ب', 'العلم', 'ل', 'النجاح']);
  assert.deepEqual(tokenize('^والدين نور'), ['والدين', 'نور']);
  assert.deepEqual(tokenize('العِلْمُ، نورٌ!'), ['العلم', 'نور']);
});
test('normalizer: قواعد الإجابة من المواصفات', () => {
  const tk = tokenize('العلم نور والعمل أساس النجاح');
  assert.ok(answerMatches('العلم نور والعمل أساس النجاح', tk));
  assert.ok(answerMatches('العلم، نور والعمل أساس النجاح', tk));
  assert.ok(answerMatches('العِلمُ نُورٌ و العمل أساس النجاح.', tk));
  assert.ok(!answerMatches('العلم نور والعمل أساس النجا', tk));
  assert.ok(!answerMatches('العلم نور العمل', tk));
  assert.ok(!answerMatches('نور العلم والعمل أساس النجاح', tk));
  assert.ok(!answerMatches('', tk));
  assert.equal(normalize('  ا ب،ج '), 'ابج');
});

// ───── توليد الألغاز (اختبار عشوائي واسع) ─────
test('puzzle: 600 لغز عشوائي كلها صالحة وبنسبة 60/40 وكل البطاقات مملوءة', () => {
  const words = ['العلم', 'نور', 'و', 'العمل', 'أساس', 'النجاح', 'الصبر', 'مفتاح', 'الفرج', 'من', 'جد', 'وجد', 'ومن', 'زرع', 'حصد', 'الوقت', 'كالسيف', 'ذهب', 'الأمل', 'حياة', 'قوة', 'سر'];
  for (let n = 3; n <= MAX_TOKENS; n++) {
    for (let k = 0; k < 30; k++) {
      const tokens = Array.from({ length: n }, (_, i) => words[(i * 7 + k) % words.length]);
      const pz = generateValidPuzzle(tokens);
      assert.equal(validatePuzzle(pz).ok, true);
      assert.equal(pz.cards.length, 30);
      assert.ok(pz.cards.every(Boolean));
      const direct = pz.code.filter((c) => pz.cards[c].kind === 'word').length;
      assert.equal(direct, directCountFor(n));
      // كل الرموز المستخدمة في التعليمات موجودة في اللوحة
      pz.cards.forEach((c) => { if (c.kind === 'link') assert.ok(SYMBOLS[c.target]); });
    }
  }
});
test('puzzle: المدقق يكتشف الأعطال', () => {
  const tokens = tokenize('العلم نور والعمل أساس النجاح');
  const pz = generateValidPuzzle(tokens);
  const bad1 = structuredClone(pz); bad1.cards[bad1.code[0]] = { kind: 'word', text: 'خطأ', role: 'code' };
  assert.equal(validatePuzzle(bad1).ok, false);
  const bad2 = structuredClone(pz);
  const linkCode = bad2.code.find((c) => bad2.cards[c].kind === 'link');
  bad2.cards[linkCode].target = 99;
  assert.equal(validatePuzzle(bad2).ok, false);
  const bad3 = structuredClone(pz); bad3.code = bad3.code.slice(1);
  assert.equal(validatePuzzle(bad3).ok, false);
  const bad4 = structuredClone(pz); bad4.revealCounts[3] = 1;
  assert.equal(validatePuzzle(bad4).ok, false);
  const bad5 = structuredClone(pz); bad5.code[1] = bad5.code[0]; // رمز شفرة مكرر
  assert.equal(validatePuzzle(bad5).ok, false);
  const refd = new Set(pz.code);
  pz.cards.forEach((c) => { if (c.kind === 'link') refd.add(c.target); });
  const freeCard = [...Array(30).keys()].find((i) => !refd.has(i));
  const bad6 = structuredClone(pz); bad6.cards[freeCard] = null; // بطاقة ناقصة خارج كل المسارات
  assert.equal(validatePuzzle(bad6).ok, false);
});
test('puzzle: الشفرة الأولية ليست مرتبة، ومحتوى الفرق مختلف', () => {
  const tokens = tokenize('العلم نور والعمل أساس النجاح');
  const a = generateValidPuzzle(tokens), b = generateValidPuzzle(tokens);
  assert.notDeepEqual(a.initialOrder, a.code);
  assert.notDeepEqual(a.cards.map((c) => c.text), b.cards.map((c) => c.text));
});
test('puzzle: صندوق الرموز والشفرة — لا تكرار ولا رمز أو حرف من خارج الصندوق', () => {
  // صندوق الرموز: 30 رمزًا فريدًا بلا أي تكرار
  assert.equal(SYMBOLS.length, 30);
  assert.equal(new Set(SYMBOLS).size, 30);
  const words = ['العلم', 'نور', 'و', 'العمل', 'أساس', 'النجاح', 'الصبر', 'مفتاح', 'الفرج', 'من',
    'جد', 'وجد', 'ومن', 'زرع', 'حصد', 'الوقت', 'كالسيف', 'ذهب', 'الأمل', 'حياة'];
  for (let n = 3; n <= MAX_TOKENS; n++) {
    const pz = generateValidPuzzle(words.slice(0, n));
    // الشفرة: كل رمز موجود في صندوق الرموز، وبلا تكرار
    assert.equal(new Set(pz.code).size, pz.code.length, `رمز شفرة مكرر عند ${n}`);
    for (const i of pz.code) assert.ok(SYMBOLS[i], `رمز شفرة خارج صندوق الرموز: ${i}`);
    assert.equal(new Set(pz.code.map((i) => SYMBOLS[i])).size, pz.code.length);
    // البطاقات: مكتملة، وكل تعليمة تشير إلى رمز من الصندوق وتُسمّيه بالحرف نفسه
    assert.equal(pz.cards.length, 30);
    pz.cards.forEach((c, i) => {
      assert.ok(c, `بطاقة ناقصة ${i}`);
      assert.ok(['word', 'link'].includes(c.kind), `نوع غير معروف ${c.kind}`);
      assert.ok(['code', 'mid', 'decoy'].includes(c.role), `دور غير معروف ${c.role}`);
      if (c.kind !== 'link') return;
      assert.ok(Number.isInteger(c.target) && c.target >= 0 && c.target < 30);
      assert.ok(SYMBOLS[c.target], `هدف خارج صندوق الرموز: ${c.target}`);
      assert.equal(c.text, `افتح ${SYMBOLS[c.target]}`, 'نص التعليمة لا يطابق رمز هدفها');
    });
  }
});

// ───── سيناريو غرفة كامل ─────
function setup() {
  const env = fakeEnv();
  const engine = new Engine(env);
  const inbox = new Map();
  const mkConn = (p) => { const c = { msgs: [], sendJSON(m) { this.msgs.push(m); } }; p.conns.add(c); inbox.set(p.id, c); return c; };
  const { room, player: host } = engine.createRoom('المستضيف'); mkConn(host);
  const join = (name) => { const { player } = engine.joinRoom(room.code, name); mkConn(player); return player; };
  engine.createTeam(room, host, { name: 'أ' });
  engine.createTeam(room, host, { name: 'ب' });
  const [A, B] = room.teams;
  const la = join('قائد أ'), ma = join('عضو أ'), lb = join('قائد ب'), spec = join('مشاهد');
  engine.joinTeam(room, la, { teamId: A.id }); engine.joinTeam(room, ma, { teamId: A.id });
  engine.joinTeam(room, lb, { teamId: B.id });
  return { env, engine, room, host, A, B, la, ma, lb, spec, inbox };
}
const SENT = 'العلم نور والعمل أساس النجاح';

test('غرفة: أول عضو قائد افتراضيًا، والمستضيف وحده يدير', () => {
  const { engine, room, host, A, la, ma } = setup();
  assert.equal(A.leaderId, la.id);
  rejects(() => engine.createTeam(room, ma, { name: 'x' }), 'not_host');
  rejects(() => engine.setSentence(room, ma, { teamId: A.id, sentence: SENT }), 'not_host');
  engine.setLeader(room, host, { teamId: A.id, playerId: ma.id });
  assert.equal(A.leaderId, ma.id);
});

test('لا بدء دون جملة/قائد، والمدة 25..60 فقط', () => {
  const { engine, room, host, A, B } = setup();
  engine.selectTeam(room, host, { teamId: A.id });
  rejects(() => engine.startRound(room, host, { durationSec: 35 }), 'no_puzzle');
  rejects(() => engine.setSentence(room, host, { teamId: A.id, sentence: 'كلمتان فقط' }), 'bad_sentence');
  engine.setSentence(room, host, { teamId: A.id, sentence: SENT });
  for (const d of [24, 61, 30.5, '35', null]) rejects(() => engine.startRound(room, host, { durationSec: d }), 'bad_duration');
  engine.selectTeam(room, host, { teamId: B.id });
  engine.setSentence(room, host, { teamId: B.id, sentence: SENT });
  engine.setLeader(room, host, { teamId: B.id, playerId: room.teams[1].leaderId });
  engine.selectTeam(room, host, { teamId: A.id });
  engine.startRound(room, host, { durationSec: 25 });
  assert.equal(A.round.durationSec, 25);
});

test('السر لا يُرسل: اللقطة قبل الكشف لا تحتوي المحتوى ولا الجملة لغير المستضيف', () => {
  const { engine, room, host, A, la, ma, spec } = setup();
  engine.selectTeam(room, host, { teamId: A.id });
  engine.setSentence(room, host, { teamId: A.id, sentence: SENT });
  const before = JSON.stringify(engine.snapshot(room, la));
  assert.ok(!before.includes('النجاح'));
  engine.startRound(room, host, { durationSec: 35 });
  for (const p of [la, ma, spec]) {
    const s = JSON.stringify(engine.snapshot(room, p));
    for (const w of ['العلم', 'نور', 'أساس', 'النجاح', 'افتح']) assert.ok(!s.includes(w), `تسرّب ${w}`);
  }
  assert.ok(JSON.stringify(engine.snapshot(room, host)).includes('النجاح')); // المستضيف يعرف جملته
});

function startedA(opts = {}) {
  const ctx = setup();
  const { engine, room, host, A } = ctx;
  engine.selectTeam(room, host, { teamId: A.id });
  engine.setSentence(room, host, { teamId: A.id, sentence: SENT });
  engine.startRound(room, host, { durationSec: opts.d || 35 });
  return ctx;
}

test('كشف البطاقة: ثانية واحدة، منع بطاقة ثانية أثناءها، مرتان كحد أقصى، ثم قفل', () => {
  const { env, engine, room, la, A } = startedA();
  const card = A.puzzle.code[0];
  engine.revealCard(room, la, { card });
  assert.equal(engine.snapshot(room, la).round.active.card, card);
  rejects(() => engine.revealCard(room, la, { card: (card + 1) % 30 }), 'busy');
  env.advance(999);
  assert.ok(engine.snapshot(room, la).round.active);
  env.advance(2);
  assert.equal(engine.snapshot(room, la).round.active, null);
  engine.revealCard(room, la, { card });
  env.advance(1001);
  rejects(() => engine.revealCard(room, la, { card }), 'exhausted');
  assert.equal(engine.snapshot(room, la).round.counts[card], 2);
  engine.revealCard(room, la, { card: (card + 1) % 30 }); // بطاقة أخرى ممكنة
});

test('الصلاحيات: العضو/المشاهد/قائد فريق آخر/المستضيف لا يتحكمون', () => {
  const { engine, room, host, A, la, ma, lb, spec } = startedA();
  for (const p of [ma, spec, lb, host]) {
    rejects(() => engine.revealCard(room, p, { card: 0 }), 'not_leader');
    rejects(() => engine.reorder(room, p, { order: A.puzzle.code }), 'not_leader');
    rejects(() => engine.finishEarly(room, p), 'not_leader');
    rejects(() => engine.submitAnswer(room, p, { text: SENT }), 'not_leader');
  }
  rejects(() => engine.revealCard(room, la, { card: 30 }), 'bad_card');
  rejects(() => engine.revealCard(room, la, { card: '1' }), 'bad_card');
  rejects(() => engine.revealCard(room, la, { card: -1 }), 'bad_card');
  rejects(() => engine.startRound(room, host, { durationSec: 30 }), 'busy');
  rejects(() => engine.selectTeam(room, host, { teamId: room.teams[1].id }), 'busy');
});

test('ترتيب الشفرة: تبديل صالح فقط ويُزامن', () => {
  const { engine, room, la, A, inbox } = startedA();
  const order = [...A.puzzle.code];
  engine.reorder(room, la, { order });
  assert.deepEqual(engine.snapshot(room, la).round.order, order);
  rejects(() => engine.reorder(room, la, { order: order.slice(1) }), 'bad_order');
  rejects(() => engine.reorder(room, la, { order: [...order.slice(1), 29 === order[0] ? 28 : 29] }), 'bad_order');
  const last = inbox.get(room.players.keys().next().value); // المستضيف
  assert.ok(last.msgs.length > 0);
});

test('المؤقت: ACTIVE→ANSWERING تلقائيًا وتتوقف كل التفاعلات', () => {
  const { env, engine, room, la, A } = startedA({ d: 30 });
  env.advance(29_999);
  assert.equal(A.round.status, 'ACTIVE');
  env.advance(2);
  assert.equal(A.round.status, 'ANSWERING');
  assert.equal(A.round.endReason, 'timeout');
  rejects(() => engine.revealCard(room, la, { card: 0 }), 'not_active');
  rejects(() => engine.reorder(room, la, { order: A.puzzle.code }), 'not_active');
  rejects(() => engine.finishEarly(room, la), 'not_active');
});

test('المؤقت لا يتأثر بالكشف ولا يتوقف، والفحص الكسول يمنع الكشف بعد الانتهاء', () => {
  const { env, engine, room, la, A } = startedA({ d: 25 });
  engine.revealCard(room, la, { card: 0 });
  env.advance(24_500);
  assert.equal(A.round.status, 'ACTIVE');
  env.advance(600);
  assert.equal(A.round.status, 'ANSWERING');
  assert.equal(A.round.activeReveal, null);
});

test('إجابة صحيحة بعد انتهاء الوقت: CORRECT→FINISHED مع بيانات كسر التعادل', () => {
  const { env, engine, room, la, ma, A } = startedA({ d: 25 });
  engine.revealCard(room, la, { card: 4 }); env.advance(1100);
  engine.revealCard(room, la, { card: 4 }); env.advance(1100);
  engine.reorder(room, la, { order: A.puzzle.code });
  env.advance(30_000);
  assert.equal(A.round.status, 'ANSWERING');
  rejects(() => engine.submitAnswer(room, ma, { text: SENT }), 'not_leader');
  engine.setDraft(room, la, { text: 'العلم' });
  assert.equal(engine.snapshot(room, ma).round.draft, 'العلم');
  assert.equal(engine.snapshot(room, room.players.get(room.hostId)).round.draft, 'العلم');
  assert.equal(engine.snapshot(room, room.teams[1] && [...room.players.values()].find((p) => p.name === 'مشاهد')).round.draft, undefined);
  engine.submitAnswer(room, la, { text: 'العلم، نور والعمل أساس النجاح' });
  assert.equal(A.round.status, 'FINISHED');
  assert.deepEqual(A.round.history.map((h) => h.status), ['WAITING', 'ACTIVE', 'ANSWERING', 'CORRECT', 'FINISHED']);
  const r = A.round.result;
  assert.equal(r.verdict, 'CORRECT');
  assert.equal(r.reveals, 2); assert.equal(r.exhausted, 1); assert.equal(r.endReason, 'timeout');
  assert.ok(r.solveMs >= 30_000);
  rejects(() => engine.submitAnswer(room, la, { text: SENT }), 'not_answering'); // لا محاولة ثانية
});

test('إنهاء مبكر + إجابة صحيحة: زمن دقيق، والجولة تنتهي فورًا', () => {
  const { env, engine, room, la, A } = startedA();
  env.advance(21_840);
  engine.finishEarly(room, la);
  assert.equal(A.round.status, 'ANSWERING');
  engine.submitAnswer(room, la, { text: SENT });
  assert.equal(A.round.result.solveMs, 21_840);
  assert.equal(A.round.result.endReason, 'early');
  assert.equal(A.round.timers, undefined);
  env.advance(60_000);
  assert.equal(A.round.status, 'FINISHED'); // المؤقت الملغى لا يغيّر شيئًا
});

test('إجابة خاطئة: لا محاولة ثانية ولا وقت حل', () => {
  const { engine, room, la, A } = startedA();
  engine.finishEarly(room, la);
  engine.submitAnswer(room, la, { text: 'نور العلم والعمل أساس النجاح' });
  assert.equal(A.round.result.verdict, 'WRONG');
  assert.equal(A.round.result.solveMs, null);
  rejects(() => engine.submitAnswer(room, la, { text: SENT }), 'not_answering');
});

test('الانتقال للفريق التالي: لا يرى لغزه قبل البدء، وجولات مستقلة، ثم انتهاء الجميع', () => {
  const { engine, room, host, A, B, la, lb } = startedA();
  engine.finishEarly(room, la);
  engine.submitAnswer(room, la, { text: SENT });
  rejects(() => engine.selectTeam(room, host, { teamId: A.id }), 'played');
  engine.setSentence(room, host, { teamId: B.id, sentence: 'الصبر مفتاح الفرج' });
  engine.nextTeam(room, host);
  assert.equal(room.activeTeamId, B.id);
  const snap = engine.snapshot(room, lb);
  assert.equal(snap.round.status, 'WAITING');
  assert.equal(snap.round.order, undefined);
  assert.ok(!JSON.stringify(snap).includes('مفتاح'));
  rejects(() => engine.revealCard(room, lb, { card: 0 }), 'not_active');
  engine.startRound(room, host, { durationSec: 40 });
  assert.notDeepEqual(A.puzzle.cards.map((c) => c.text), B.puzzle.cards.map((c) => c.text));
  engine.finishEarly(room, lb);
  engine.submitAnswer(room, lb, { text: 'الصبر مفتاح الفرج' });
  engine.nextTeam(room, host);
  assert.equal(room.allDone, true);
});

test('إعادة الاتصال: نفس الحالة دون تصفير المؤقت أو الكشف', () => {
  const { env, engine, room, la, A } = startedA({ d: 40 });
  engine.revealCard(room, la, { card: 7 }); env.advance(1100);
  const before = engine.snapshot(room, la).round;
  la.conns.clear();
  env.advance(5000);
  const { player } = engine.resume(room.code, la.id, la.secret);
  const after = engine.snapshot(room, player).round;
  assert.equal(after.endsAt, before.endsAt);
  assert.equal(after.counts[7], 1);
  rejects(() => engine.resume(room.code, la.id, 'خطأ'), 'bad_session');
});

test('قائد غير متصل يمنع البدء', () => {
  const { engine, room, host, A, la } = setup();
  engine.selectTeam(room, host, { teamId: A.id });
  engine.setSentence(room, host, { teamId: A.id, sentence: SENT });
  la.conns.clear();
  rejects(() => engine.startRound(room, host, { durationSec: 35 }), 'leader_offline');
});

test('لا تغيير للجملة أو للفريق أثناء الجولة', () => {
  const { engine, room, host, A, ma } = startedA();
  rejects(() => engine.setSentence(room, host, { teamId: A.id, sentence: 'الصبر مفتاح الفرج' }), 'locked');
  rejects(() => engine.joinTeam(room, ma, { teamId: null }), 'busy');
  rejects(() => engine.setLeader(room, host, { teamId: A.id, playerId: ma.id }), 'busy');
});

test('ترتيب الشفرة: تكرار رمز أو رمز من خارج الصندوق مرفوض', () => {
  const { engine, room, la, A } = startedA();
  const code = A.round.code;
  const reversed = [...code].reverse();
  engine.reorder(room, la, { order: reversed });
  assert.deepEqual(A.round.order, reversed);
  rejects(() => engine.reorder(room, la, { order: [code[0], ...code.slice(1, -1), code[0]] }), 'bad_order'); // تكرار
  rejects(() => engine.reorder(room, la, { order: code.slice(0, -1) }), 'bad_order');                          // ناقص
  rejects(() => engine.reorder(room, la, { order: [...code.slice(0, -1), 99] }), 'bad_order');                // خارج الصندوق
  assert.deepEqual(A.round.order, reversed); // الرفض لا يغيّر الترتيب
});
