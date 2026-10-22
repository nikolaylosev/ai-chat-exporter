// Makes the extension icons from the logo (assets/logo.png): the app icon on a
// transparent background, cropped to what it draws and scaled down to each size.
// The 128 one follows the Chrome Web Store's rules: 96×96 artwork in 16 px of
// transparent padding, with a faint light glow so the dark square shows on dark
// backgrounds. The toolbar sizes stay full-bleed. No image library: PNG is
// decoded and encoded here. Run: npm run icons
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const SOURCE = 'assets/logo.png';
const SIZES = [16, 32, 48, 128];
/** Transparent padding on each side, by icon size. */
const PADDING = { 128: 16 };
/** The glow: how far it reaches (box blur radius, twice) and how light it is. */
const GLOW_RADIUS = 3;
const GLOW_STRENGTH = 0.45;

function decode(buffer) {
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = body.subarray(8);
      if (depth !== 8 || interlace !== 0 || ![2, 6].includes(color)) {
        throw new Error(`${SOURCE}: only 8-bit RGB or RGBA without interlacing`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      row[i] = (line[i] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 4; k++) {
        out[(y * width + x) * 4 + k] = k < channels ? row[x * channels + k] : 255;
      }
    }
    previous = row;
  }
  return { width, height, pixels: out };
}

/** Premultiplied pixels and the box around everything that is not transparent. */
function prepare({ width, height, pixels }) {
  let [x0, y0, x1, y1] = [width, height, 0, 0];
  const result = new Float64Array(width * height * 4);
  for (let n = 0; n < width * height; n++) {
    const i = n * 4;
    const alpha = pixels[i + 3] / 255;
    if (alpha > 0.02) {
      const x = n % width;
      const y = (n - x) / width;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
    result.set([pixels[i] * alpha, pixels[i + 1] * alpha, pixels[i + 2] * alpha, alpha], i);
  }
  return { width, result, box: [x0, y0, x1 + 1, y1 + 1] };
}

/** Area-averaged scaling of the logo into a square icon. */
function icon(cut, size) {
  const [x0, y0, x1, y1] = cut.box;
  // Half a pixel on each side, so the rounded corners are not cut.
  const margin = 0.5 / size;
  const side = Math.max(x1 - x0, y1 - y0) / (1 - 2 * margin);
  const left = (x0 + x1) / 2 - side / 2;
  const top = (y0 + y1) / 2 - side / 2;
  const scale = side / size;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0, 0];
      let area = 0;
      const sx0 = left + px * scale;
      const sy0 = top + py * scale;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy0 + scale); sy++) {
        const h = Math.min(sy + 1, sy0 + scale) - Math.max(sy, sy0);
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx0 + scale); sx++) {
          const w = Math.min(sx + 1, sx0 + scale) - Math.max(sx, sx0);
          area += w * h;
          if (sx < 0 || sy < 0 || sx >= cut.width || sy * cut.width + sx >= cut.result.length / 4)
            continue;
          const i = (sy * cut.width + sx) * 4;
          for (let k = 0; k < 4; k++) acc[k] += cut.result[i + k] * w * h;
        }
      }
      const alpha = acc[3] / area;
      const o = (py * size + px) * 4;
      if (alpha > 0) for (let k = 0; k < 3; k++) out[o + k] = Math.round(acc[k] / area / alpha);
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encode(size, rgba) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One pass of a box blur over a size×size map, along x then y. */
function blur(map, size, r) {
  const along = (src, horizontal) => {
    const out = new Float64Array(size * size);
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) {
        let sum = 0;
        for (let d = -r; d <= r; d++) {
          const c = b + d;
          if (c < 0 || c >= size) continue;
          sum += src[horizontal ? a * size + c : c * size + a];
        }
        out[horizontal ? a * size + b : b * size + a] = sum / (2 * r + 1);
      }
    }
    return out;
  };
  return along(along(map, true), false);
}

/** The artwork centred on a larger transparent canvas, over a faint white glow. */
function padded(art, inner, size) {
  const pad = (size - inner) / 2;
  const alpha = new Float64Array(size * size);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++)
      alpha[(y + pad) * size + x + pad] = art[(y * inner + x) * 4 + 3] / 255;
  }
  const glow = blur(blur(alpha, size, GLOW_RADIUS), size, GLOW_RADIUS);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= pad && y >= pad && x < pad + inner && y < pad + inner;
      const i = inside ? ((y - pad) * inner + (x - pad)) * 4 : -1;
      const a = alpha[y * size + x];
      const g = Math.min(1, glow[y * size + x] * GLOW_STRENGTH) * (1 - a);
      const total = a + g;
      const o = (y * size + x) * 4;
      if (total <= 0) continue;
      for (let k = 0; k < 3; k++) {
        const c = inside ? art[i + k] : 0;
        out[o + k] = Math.round((c * a + 255 * g) / total);
      }
      out[o + 3] = Math.round(total * 255);
    }
  }
  return out;
}

const cut = prepare(decode(readFileSync(SOURCE)));
mkdirSync('public/icons', { recursive: true });
for (const size of SIZES) {
  const pad = PADDING[size] ?? 0;
  const inner = size - 2 * pad;
  const pixels = pad ? padded(icon(cut, inner), inner, size) : icon(cut, size);
  writeFileSync(`public/icons/icon-${size}.png`, encode(size, pixels));
  console.log(`public/icons/icon-${size}.png`);
}
