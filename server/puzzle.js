'use strict';
const { normalize } = require('./arabic');

// اللوحة الثابتة 5 أعمدة × 6 صفوف — الفهرس = الموضع (صف = floor(i/5) ، عمود = i%5)
const SYMBOLS = ['🧱', '🦅', '⚙️', '🛡️', '❤️', '🔑', '🐺', '🌀', '🚪', '👁️',
  '🌙', '🔮', '🚀', '🧬', '🗝️', '🕸️', '🧿', '⚡', '☢️', '🛰️',
  '🧩', '🦉', '🦂', '🦊', '🌐', '🪐', '🧭', '🔗', '💠', '♟️'];

const BOARD_SIZE = 30;
const COLS = 5;
const ROWS = 6;

// حماية وقت التحميل: صندوق الرموز = 30 رمزًا فريدًا بلا أي تكرار
if (SYMBOLS.length !== BOARD_SIZE || new Set(SYMBOLS).size !== SYMBOLS.length) {
  throw new Error('صندوق الرموز غير صالح: يجب أن يكون 30 رمزًا فريدًا');
}

const MAX_REVEALS = 2;
const DIRECT_RATIO = 0.6;
const MIN_TOKENS = 3;
const MAX_HOPS = 3;          // أقصى عدد رموز وسيطة في مسار واحد
const DECOY_TARGET = 4;      // نحاول إبقاء 4 بطاقات مضللة على الأقل

// أقصى عدد عناصر: n + (n - ceil(0.6n)) ≤ 30 يسمح حتى 22، ونحدّه بـ20 لضمان وجود بطاقات مضللة.
const MAX_TOKENS = 20;

const DECOY_WORDS = ['المستقبل', 'الطريق', 'الصحراء', 'القمر', 'الجبل', 'البحر', 'الريح', 'النجم', 'الظل', 'الزمن',
  'الحكمة', 'الصبر', 'الحلم', 'السفينة', 'الجسر', 'المفتاح', 'الباب', 'الغيمة', 'الرمل', 'الضوء', 'الليل', 'الفجر',
  'المطر', 'الوادي', 'الكتاب', 'القلم', 'الشمس', 'الذاكرة', 'اللغز', 'السر', 'الخريطة', 'الكنز', 'الرحلة', 'المدينة',
  'الحديقة', 'الشجرة', 'النهر', 'العاصفة', 'الوقت', 'الأمل', 'الصدى', 'البرق'];

const directCountFor = (n) => Math.ceil(n * DIRECT_RATIO);
const linkText = (target) => `افتح ${SYMBOLS[target]}`;

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generatePuzzle(tokens, rand = Math.random) {
  const n = tokens.length;
  if (n < MIN_TOKENS || n > MAX_TOKENS) throw new Error(`عدد عناصر الجملة يجب أن يكون بين ${MIN_TOKENS} و${MAX_TOKENS} (الحالي ${n})`);

  const direct = directCountFor(n);
  const indirect = n - direct;
  const order = shuffle([...Array(n).keys()], rand);
  const indirectIdx = order.slice(0, indirect);
  const hops = new Array(n).fill(0);
  for (const i of indirectIdx) hops[i] = 1;

  // إطالة بعض المسارات إن بقي متسع مع الحفاظ على بطاقات مضللة
  let extra = Math.max(0, BOARD_SIZE - n - indirect - DECOY_TARGET);
  extra = Math.floor(rand() * (extra + 1));
  for (let guard = 0; extra > 0 && indirectIdx.length && guard < 300; guard++) {
    const i = indirectIdx[Math.floor(rand() * indirectIdx.length)];
    if (hops[i] < MAX_HOPS) { hops[i]++; extra--; }
  }

  const pool = shuffle([...Array(BOARD_SIZE).keys()], rand);
  let p = 0;
  const code = [];
  for (let i = 0; i < n; i++) code.push(pool[p++]);

  const cards = new Array(BOARD_SIZE).fill(null);
  for (let i = 0; i < n; i++) {
    if (hops[i] === 0) { cards[code[i]] = { kind: 'word', text: tokens[i], role: 'code' }; continue; }
    let cur = code[i];
    for (let h = 0; h < hops[i]; h++) {
      const next = pool[p++];
      cards[cur] = { kind: 'link', target: next, text: linkText(next), role: h === 0 ? 'code' : 'mid' };
      cur = next;
    }
    cards[cur] = { kind: 'word', text: tokens[i], role: 'mid' };
  }

  const banned = new Set(tokens.map(normalize));
  const words = shuffle(DECOY_WORDS.filter((w) => !banned.has(normalize(w))), rand);
  const decoys = pool.slice(p);
  let wi = 0;
  for (const d of decoys) {
    if (decoys.length > 1 && rand() < 0.4) {
      let t;
      do { t = decoys[Math.floor(rand() * decoys.length)]; } while (t === d);
      cards[d] = { kind: 'link', target: t, text: linkText(t), role: 'decoy' };
    } else {
      cards[d] = { kind: 'word', text: words[wi++ % words.length], role: 'decoy' };
    }
  }

  let initialOrder = shuffle([...code], rand);
  for (let k = 0; k < 20 && n > 1 && initialOrder.every((v, i) => v === code[i]); k++) shuffle(initialOrder, rand);

  return { tokens: [...tokens], code, cards, initialOrder, maxReveals: MAX_REVEALS, revealCounts: new Array(BOARD_SIZE).fill(0) };
}

/** فحص مستقل لا يعتمد على منطق التوليد: يتتبّع كل مسار فعليًا من رمز الشفرة حتى الكلمة. */
function validatePuzzle(pz) {
  const errors = [];
  const { tokens, code, cards, initialOrder } = pz;
  const n = tokens.length;

  if (!Array.isArray(cards) || cards.length !== BOARD_SIZE) errors.push('عدد البطاقات ليس 30');
  else if (cards.some((c) => !c || (c.kind !== 'word' && c.kind !== 'link') || !['code', 'mid', 'decoy'].includes(c.role))) {
    errors.push('بطاقة ناقصة أو نوع/دور غير معروف');
  }
  if (code.length !== n) errors.push('عدد رموز الشفرة لا يساوي عدد عناصر الجملة');
  if (new Set(code).size !== code.length) errors.push('رمز شفرة مكرر');
  if (code.some((c) => !Number.isInteger(c) || c < 0 || c >= BOARD_SIZE)) errors.push('رمز شفرة خارج اللوحة');
  if (initialOrder.length !== n || [...initialOrder].sort((a, b) => a - b).join() !== [...code].sort((a, b) => a - b).join()) {
    errors.push('الترتيب الأولي ليس تبديلًا لرموز الشفرة');
  }
  if (pz.maxReveals !== MAX_REVEALS) errors.push('الحد الأقصى للكشف ليس 2');
  if (!pz.revealCounts || pz.revealCounts.length !== BOARD_SIZE || pz.revealCounts.some((v) => v !== 0)) errors.push('عدّاد الكشف ليس صفرًا');
  if (errors.length) return { ok: false, errors };

  const codeSet = new Set(code);
  const midRefs = new Map();
  let direct = 0;

  for (let i = 0; i < n; i++) {
    let cur = code[i];
    const seen = new Set();
    let hops = 0;
    let resolved = null;
    for (;;) {
      const card = cards[cur];
      if (!card) { errors.push(`بطاقة فارغة ${SYMBOLS[cur]}`); break; }
      if (card.kind === 'word') { resolved = card.text; break; }
      if (card.kind !== 'link') { errors.push('نوع بطاقة غير معروف'); break; }
      if (seen.has(cur)) { errors.push('حلقة في المسار'); break; }
      seen.add(cur);
      const t = card.target;
      if (!Number.isInteger(t) || t < 0 || t >= BOARD_SIZE) { errors.push('تعليمة تشير إلى رمز غير موجود'); break; }
      if (card.text !== linkText(t)) errors.push('نص التعليمة لا يطابق هدفها');
      if (codeSet.has(t)) { errors.push('مسار يمر عبر رمز شفرة آخر'); break; }
      midRefs.set(t, (midRefs.get(t) || 0) + 1);
      cur = t;
      hops++;
    }
    if (resolved === null) { if (!errors.length) errors.push('مسار مسدود'); continue; }
    if (resolved !== tokens[i]) errors.push(`المسار ${i + 1} ينتهي بعنصر خاطئ`);
    if (hops === 0) direct++;
  }

  for (const [t, c] of midRefs) if (c > 1) errors.push(`الرمز الوسيط ${SYMBOLS[t]} تستخدمه أكثر من مسار`);

  if (direct !== directCountFor(n)) errors.push(`نسبة المسارات المباشرة غير صحيحة (${direct}/${n})`);

  // لا تعليمة مضللة تشير إلى بطاقة من الحل، وكل تعليمة تشير لرمز موجود
  cards.forEach((card, idx) => {
    if (!card) return;
    if (card.kind === 'link') {
      if (!Number.isInteger(card.target) || card.target < 0 || card.target >= BOARD_SIZE) errors.push('تعليمة إلى رمز غير موجود');
      else if (card.role === 'decoy' && cards[card.target] && cards[card.target].role !== 'decoy') errors.push('بطاقة مضللة تشير إلى بطاقة من الحل');
    }
    if (card.role === 'decoy' && card.kind === 'word' && tokens.some((t) => normalize(t) === normalize(card.text))) {
      errors.push(`بطاقة مضللة تحمل عنصرًا من الجملة (${SYMBOLS[idx]})`);
    }
  });

  return { ok: errors.length === 0, errors };
}

function generateValidPuzzle(tokens, rand = Math.random, tries = 50) {
  let last = [];
  for (let i = 0; i < tries; i++) {
    const pz = generatePuzzle(tokens, rand);
    const v = validatePuzzle(pz);
    if (v.ok) return pz;
    last = v.errors;
  }
  throw new Error('تعذّر توليد لغز صالح: ' + last.join('، '));
}

module.exports = {
  SYMBOLS, BOARD_SIZE, COLS, ROWS, MAX_REVEALS, MIN_TOKENS, MAX_TOKENS, DIRECT_RATIO,
  directCountFor, generatePuzzle, validatePuzzle, generateValidPuzzle,
};
