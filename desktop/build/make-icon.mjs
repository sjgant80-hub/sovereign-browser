// make-icon.mjs — generate build/icon.png (1024²) with no image libraries: a pure
// SDF renderer + a minimal PNG encoder (zlib + CRC32). electron-builder derives the
// platform .ico/.icns from this. Design: a dark rounded-square with a teal "verified"
// ring + check — the sovereign-console identity. Run: node build/make-icon.mjs
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const S = 1024;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG_TOP = hex('#122032'), BG_BOT = hex('#0a0d13'), TEAL = hex('#38d6c6');
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// signed distance to a rounded rectangle centred at (cx,cy), half-size h, radius r
function sdRoundRect(px, py, cx, cy, h, r) {
  const qx = Math.abs(px - cx) - (h - r), qy = Math.abs(py - cy) - (h - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const rgba = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // rounded-square mask (transparent outside)
    const dRect = sdRoundRect(x + 0.5, y + 0.5, S / 2, S / 2, S / 2 - 24, 220);
    const inside = smooth(1.5, -1.5, dRect);          // 1 inside, AA at the edge
    // background vertical gradient
    let r = mix(BG_TOP[0], BG_BOT[0], y / S), g = mix(BG_TOP[1], BG_BOT[1], y / S), b = mix(BG_TOP[2], BG_BOT[2], y / S);
    // teal ring
    const ring = Math.abs(Math.hypot(x - S / 2, y - S / 2) - 300);
    const ringC = smooth(30, 24, ring);
    // teal check
    const chk = Math.min(sdSegment(x, y, 360, 540, 470, 650), sdSegment(x, y, 470, 650, 700, 400));
    const chkC = smooth(30, 24, chk);
    const teal = Math.max(ringC, chkC);
    r = mix(r, TEAL[0], teal); g = mix(g, TEAL[1], teal); b = mix(b, TEAL[2], teal);
    rgba[i] = r | 0; rgba[i + 1] = g | 0; rgba[i + 2] = b | 0; rgba[i + 3] = Math.round(255 * inside);
  }
}

// ── minimal PNG encoder ───────────────────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = join(dirname(fileURLToPath(import.meta.url)), 'icon.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${S}x${S}, ${png.length} bytes)`);
