'use strict';
/**
 * Arabic Tokenizer + Answer Normalizer — التنفيذ الوحيد المستخدم في:
 * إنشاء اللغز، إنشاء الشفرة، تحديد الإجابة الصحيحة، ومقارنة إجابة اللاعب.
 *
 * قواعد التحليل:
 *  1. تُزال علامات الترقيم والتشكيل وتُعتبر فواصل بين الكلمات.
 *  2. حروف الجر والعطف (و ف ب ك ل) تُفصل تلقائيًا فقط إذا التصقت بكلمة معرّفة بـ«ال»
 *     وبقي بعد «ال» ثلاثة أحرف على الأقل:  والعمل ← و | العمل ،  بالعلم ← ب | العلم.
 *     هذا الشرط يمنع تفكيك كلمات مثل «وطن» و«فهم» و«بالغة».
 *  3. الفصل الصريح: التطويلة «ـ» تفصل ما قبلها عمّا بعدها:  بـالعلم ← ب | العلم ، وكذلك «بـ العلم».
 *  4. منع الفصل الصريح: ابدأ الكلمة بالعلامة ^ مثل ^والدين فتبقى كلمة واحدة.
 */

const MARKS = /\p{M}/gu;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const TATWEEL = '\u0640';
const PREFIXES = ['و', 'ف', 'ب', 'ك', 'ل'];
const DEFINITE_AFTER_PREFIX = /^ال.{3,}$/u;

function splitImplicit(part, out) {
  // بادئات متراكمة مثل «وبالعمل» = و + ب + العمل: نبحث عن أطول سلسلة بادئات يليها «ال» + 3 أحرف
  for (let k = Math.min(3, part.length - 1); k >= 1; k--) {
    const head = part.slice(0, k);
    if ([...head].every((c) => PREFIXES.includes(c)) && DEFINITE_AFTER_PREFIX.test(part.slice(k))) {
      out.push(...head, part.slice(k));
      return;
    }
  }
  out.push(part);
}

function tokenize(sentence) {
  const src = String(sentence ?? '').normalize('NFC').replace(INVISIBLE, '').replace(MARKS, '');
  const out = [];
  for (const raw of src.split(/\s+/)) {
    if (!raw) continue;
    const noSplit = raw.startsWith('^');
    const cleaned = raw.replace(/[^\p{L}\p{N}\u0640]+/gu, ' ').trim();
    for (const word of cleaned.split(/\s+/)) {
      if (!word) continue;
      for (const part of word.split(TATWEEL)) {
        if (!part) continue;
        if (noSplit) out.push(part);
        else splitImplicit(part, out);
      }
    }
  }
  return out;
}

/** يتجاهل: المسافات، علامات الترقيم، التشكيل، التطويلة. لا يوحّد الهمزات ولا التاء المربوطة عمدًا. */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(MARKS, '')
    .replace(/\u0640/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function answerMatches(answer, tokens) {
  const expected = normalize(tokens.join(''));
  return expected.length > 0 && normalize(answer) === expected;
}

module.exports = { tokenize, normalize, answerMatches };
