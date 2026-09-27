'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Engine, GameError } = require('./engine');
const ws = require('./ws');

const PUBLIC = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const CSP = "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'";

function createApp({ engine = new Engine(), allowedOrigins = [] } = {}) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    const rel = url === '/' ? '/index.html' : url;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('غير موجود'); }
      const ext = path.extname(file);
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
        'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      });
      res.end(data);
    });
  });

  const ACTIONS = new Set(['createTeam', 'removeTeam', 'moveTeam', 'selectTeam', 'nextTeam', 'setLeader', 'joinTeam',
    'setSentence', 'startRound', 'revealCard', 'reorder', 'finishEarly', 'setDraft', 'submitAnswer']);

  const sock = ws.attach(server, {
    allowedOrigins,
    onConnection(conn) {
      const ctx = { room: null, player: null, tokens: 60, last: Date.now() };
      const bind = (room, player) => {
        ctx.room = room; ctx.player = player;
        conn.sendJSON({ t: 'session', code: room.code, playerId: player.id, secret: player.secret });
        engine.attach(room, player, conn);
      };

      conn.on('message', (raw) => {
        const now = Date.now();
        ctx.tokens = Math.min(60, ctx.tokens + (now - ctx.last) / 1000 * 40);
        ctx.last = now;
        if (--ctx.tokens < 0) return; // تجاهل الفيضان
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
        try {
          if (m.t === 'ping') return conn.sendJSON({ t: 'pong' });
          if (m.t === 'create' || m.t === 'join' || m.t === 'resume') {
            if (ctx.player) return;
            const r = m.t === 'create' ? engine.createRoom(m.name)
              : m.t === 'join' ? engine.joinRoom(m.code, m.name)
                : engine.resume(m.code, m.playerId, m.secret);
            return bind(r.room, r.player);
          }
          if (!ctx.player || !ACTIONS.has(m.t)) return;
          engine[m.t](ctx.room, ctx.player, m);
        } catch (e) {
          if (e instanceof GameError) conn.sendJSON({ t: 'err', code: e.code, msg: e.message });
          else { console.error(e); conn.sendJSON({ t: 'err', code: 'internal', msg: 'حدث خطأ غير متوقع' }); }
        }
      });
      conn.on('close', () => { if (ctx.player) engine.detach(ctx.room, ctx.player, conn); });
    },
  });

  const sweeper = setInterval(() => engine.sweep(6 * 3600 * 1000), 10 * 60 * 1000);
  sweeper.unref();
  server.on('close', () => { clearInterval(sweeper); sock.stop(); });
  return { server, engine };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { server } = createApp({ allowedOrigins: allowed });
  server.listen(port, () => console.log(`رسالة مشفّرة تعمل على http://localhost:${port}`));
}

module.exports = { createApp };
