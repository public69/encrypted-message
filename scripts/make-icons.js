// يولّد أيقونات PNG (180/192/512 + maskable) بلا اعتماديات: node scripts/make-icons.js
const zlib = require('zlib'), fs = require('fs'), path = require('path');
function crc(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); }
function png(S, safe) {
  const raw = Buffer.alloc((S * 4 + 1) * S);
  const u = S / 512, k = safe ? 0.72 : 1;
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    for (let x = 0; x < S; x++) {
      const nx = ((x + .5) / u - 256) / k + 256, ny = ((y + .5) / u - 256) / k + 256;
      let r = 4, g = 6, b = 13;
      const d = Math.hypot(nx - 256, ny - 256);
      if (d > 163 && d < 177) { r = 34; g = 230; b = 255; }
      if (nx > 176 && nx < 336 && ny > 238 && ny < 358) { r = 11; g = 27; b = 46; if (nx < 188 || nx > 324 || ny < 250 || ny > 346) { r = 34; g = 230; b = 255; } }
      const dh = Math.hypot(nx - 256, ny - 204);
      if ((ny <= 204 && dh > 45 && dh < 59) || (ny > 204 && ny < 240 && (Math.abs(nx - 204) < 7 || Math.abs(nx - 308) < 7))) { r = 155; g = 92; b = 255; }
      if (Math.hypot(nx - 256, ny - 288) < 14 || (Math.abs(nx - 256) < 6 && ny > 288 && ny < 330)) { r = 34; g = 230; b = 255; }
      const o = y * (S * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const out = path.join(__dirname, '..', 'public', 'icons');
fs.writeFileSync(path.join(out, 'icon-180.png'), png(180));
fs.writeFileSync(path.join(out, 'icon-192.png'), png(192));
fs.writeFileSync(path.join(out, 'icon-512.png'), png(512));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), png(512, true));
console.log('icons ok');
