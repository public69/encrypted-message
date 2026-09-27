'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(port) {
    this.state = null; this.errs = []; this.session = null; this.states = 0;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ready = new Promise((res) => this.ws.addEventListener('open', res));
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') { this.state = m.s; this.states++; }
      else if (m.t === 'session') this.session = m;
      else if (m.t === 'err') this.errs.push(m);
    });
  }
  async send(o) { await this.ready; this.ws.send(JSON.stringify(o)); await wait(40); }
  async until(fn, ms = 2000) { const t = Date.now(); while (Date.now() - t < ms) { if (this.state && fn(this.state)) return this.state; await wait(15); } throw new Error('timeout waiting for state'); }
  close() { this.ws.close(); }
}

test('multiplayer: مستضيف + قادة + أعضاء + مشاهد عبر WebSocket حقيقي', async () => {
  const { server } = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const all = [];
  const mk = () => { const c = new Client(port); all.push(c); return c; };
  try {
    const host = mk(), l1 = mk(), m1 = mk(), spec = mk(), l2 = mk();
    await host.send({ t: 'create', name: 'المستضيف' });
    const code = host.session.code;
    for (const [c, n] of [[l1, 'ليلى'], [m1, 'منى'], [spec, 'سعد'], [l2, 'ياسر']]) await c.send({ t: 'join', code, name: n });
    await host.send({ t: 'createTeam', name: 'الصقور' });
    await host.send({ t: 'createTeam', name: 'الذئاب' });
    const [T1, T2] = host.state.teams;
    await l1.send({ t: 'joinTeam', teamId: T1.id });
    await m1.send({ t: 'joinTeam', teamId: T1.id });
    await l2.send({ t: 'joinTeam', teamId: T2.id });

    // صلاحيات قبل البدء
    await m1.send({ t: 'createTeam', name: 'اختراق' });
    assert.equal(m1.errs.at(-1).code, 'not_host');

    const S1 = 'العلم نور والعمل أساس النجاح';
    await host.send({ t: 'setSentence', teamId: T1.id, sentence: S1 });
    await host.send({ t: 'setSentence', teamId: T2.id, sentence: 'الصبر مفتاح الفرج' });
    await host.send({ t: 'selectTeam', teamId: T1.id });
    await l1.until((s) => s.round && s.round.status === 'WAITING');
    assert.ok(!JSON.stringify(l1.state).includes('النجاح'));

    await host.send({ t: 'startRound', durationSec: 30 });
    for (const c of [l1, m1, spec, l2]) await c.until((s) => s.round.status === 'ACTIVE');

    // كشف بطاقة: الجميع يراها، وأعضاء غير القائد مرفوضون
    await m1.send({ t: 'revealCard', card: 3 });
    assert.equal(m1.errs.at(-1).code, 'not_leader');
    await spec.send({ t: 'revealCard', card: 3 });
    assert.equal(spec.errs.at(-1).code, 'not_leader');
    await l2.send({ t: 'revealCard', card: 3 });
    assert.equal(l2.errs.at(-1).code, 'not_leader');
    await l1.send({ t: 'revealCard', card: 3 });
    for (const c of [host, m1, spec, l2]) {
      const s = await c.until((x) => x.round.active);
      assert.equal(s.round.active.card, 3);
      assert.equal(s.round.counts[3], 1);
    }
    await l1.send({ t: 'revealCard', card: 4 }); // أثناء الثانية
    assert.equal(l1.errs.at(-1).code, 'busy');
    await m1.until((s) => !s.round.active, 2000);

    // ترتيب صندوق الشفرة ثابت الآن (البند 5): محاولة القائد إعادة الترتيب تُرفض دائمًا ولا يتغير الترتيب
    const fixedOrder = [...l1.state.round.order];
    await l1.send({ t: 'reorder', order: [...fixedOrder].reverse() });
    assert.equal(l1.errs.at(-1).code, 'locked');
    for (const c of [m1, spec, host]) assert.equal(c.state.round.order.join(), fixedOrder.join());

    // انقطاع اتصال العضو ثم عودته بنفس الحالة
    const { code: c0, playerId, secret } = m1.session;
    const endsAt = m1.state.round.endsAt;
    m1.close(); await wait(80);
    const m1b = mk();
    await m1b.send({ t: 'resume', code: c0, playerId, secret });
    const back = await m1b.until((s) => s.round && s.round.status === 'ACTIVE');
    assert.equal(back.round.endsAt, endsAt);
    assert.equal(back.round.counts[3], 1);

    // إنهاء مبكر → إجابة
    await l1.send({ t: 'finishEarly' });
    await spec.until((s) => s.round.status === 'ANSWERING');
    await l1.send({ t: 'setDraft', text: 'العلم' });
    await m1b.until((s) => s.round.draft === 'العلم');
    assert.equal(spec.state.round.draft, undefined);
    await m1b.send({ t: 'submitAnswer', text: S1 });
    assert.equal(m1b.errs.at(-1).code, 'not_leader');
    await l1.send({ t: 'submitAnswer', text: 'العلم نور والعمل أساس النجاح' });
    const sHost = await host.until((x) => x.round.status === 'FINISHED');
    assert.equal(sHost.round.result.verdict, 'CORRECT');
    assert.ok(sHost.round.result.solveMs > 0);
    for (const c of [m1b, spec, l2]) {
      const s = await c.until((x) => x.round.status === 'FINISHED');
      assert.equal(s.round.result, undefined); // إخفاء verdict عن الفريق المجيب والفرق الأخرى
    }

    // الفريق التالي
    await host.send({ t: 'nextTeam' });
    const s2 = await l2.until((s) => s.round && s.round.teamId === T2.id);
    assert.equal(s2.round.status, 'WAITING');
    assert.ok(!JSON.stringify(s2).includes('الفرج'));
  } finally {
    all.forEach((c) => c.close());
    await new Promise((r) => server.close(r));
  }
});

test('WebSocket: رفض Origin مختلف ورسائل تالفة لا تُسقط الخادم', async () => {
  const { server } = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const http = require('http');
    const status = await new Promise((res) => {
      const req = http.request({ port, host: '127.0.0.1', path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: 'https://evil.example' } });
      req.on('response', (r) => res(r.statusCode));
      req.on('upgrade', () => res(101));
      req.end();
    });
    assert.equal(status, 403);
    const c = new Client(port); await c.ready;
    c.ws.send('not json'); c.ws.send('{"t":123}'); c.ws.send('{"t":"revealCard","card":1}');
    await wait(60);
    await c.send({ t: 'create', name: 'x' });
    assert.ok(c.session);
    c.close();
  } finally { await new Promise((r) => server.close(r)); }
});
