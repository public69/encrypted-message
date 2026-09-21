'use strict';
/** خادم WebSocket بلا اعتماديات (RFC 6455): تجزئة الإطارات، ping/pong، حدود الحجم، فحص Origin. */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;
const MAX_BUFFER = 256 * 1024;

class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.closed = false;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_BUFFER) return this.close(1009);
    while (!this.closed && this._parse()) { /* استهلك كل الإطارات المكتملة */ }
  }

  _parse() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = !!(b[0] & 0x80);
    const op = b[0] & 0x0f;
    const masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return false; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return false;
      if (b.readUInt32BE(2) !== 0) { this.close(1009); return false; }
      len = b.readUInt32BE(6); off = 10;
    }
    if (!masked) { this.close(1002); return false; }
    if (len > MAX_PAYLOAD) { this.close(1009); return false; }
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);

    switch (op) {
      case 0x8: this.close(1000); return false;
      case 0x9: this._frame(0xA, payload); return true;
      case 0xA: this.alive = true; return true;
      case 0x1: case 0x2:
        if (fin) this.emit('message', payload.toString('utf8'));
        else this.frag = [payload];
        return true;
      case 0x0:
        if (!this.frag) { this.close(1002); return false; }
        this.frag.push(payload);
        if (this.frag.reduce((a, c) => a + c.length, 0) > MAX_PAYLOAD) { this.close(1009); return false; }
        if (fin) { const full = Buffer.concat(this.frag); this.frag = null; this.emit('message', full.toString('utf8')); }
        return true;
      default: this.close(1002); return false;
    }
  }

  _frame(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    this.socket.write(Buffer.concat([head, payload]));
    if (this.socket.writableLength > 1024 * 1024) this.terminate();
  }

  send(text) { this._frame(0x1, Buffer.from(text, 'utf8')); }
  sendJSON(obj) { this.send(JSON.stringify(obj)); }
  ping() { this._frame(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    try { this._frame(0x8, p); this.socket.end(); } catch { /* تجاهل */ }
    setTimeout(() => this.socket.destroy(), 500).unref();
    this._onClose();
  }

  terminate() { this.socket.destroy(); this._onClose(); }
}

function attach(server, { path = '/ws', onConnection, allowedOrigins = [] }) {
  const conns = new Set();
  server.on('upgrade', (req, socket) => {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== path || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let ok = allowedOrigins.includes(origin);
      try { if (!ok) ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
      if (!ok) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new Conn(socket);
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    onConnection(conn, req);
  });
  const hb = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.terminate(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 20000);
  hb.unref();
  return { conns, stop() { clearInterval(hb); for (const c of conns) c.terminate(); } };
}

module.exports = { attach, Conn };
