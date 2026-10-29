/**
 * An image's width and height from its first bytes, for PNG, JPEG, GIF and
 * WebP; null for anything else. Gemini gives images re-encoded and Takeout keeps
 * its own copies under other names, so the same image is told by its size.
 */
export function imageSize(bytes: Uint8Array): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i: number) => bytes[i] ?? 0;
  const ascii = (i: number, text: string) =>
    [...text].every((ch, k) => at(i + k) === ch.charCodeAt(0));
  try {
    if (at(0) === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR')) {
      return [view.getUint32(16), view.getUint32(20)];
    }
    if (ascii(0, 'GIF8')) return [view.getUint16(6, true), view.getUint16(8, true)];
    if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
      if (ascii(12, 'VP8 ')) {
        return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
      }
      if (ascii(12, 'VP8L')) {
        const b = view.getUint32(21, true);
        return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1];
      }
      if (ascii(12, 'VP8X')) {
        const w = at(24) | (at(25) << 8) | (at(26) << 16);
        const h = at(27) | (at(28) << 8) | (at(29) << 16);
        return [w + 1, h + 1];
      }
      return null;
    }
    if (at(0) === 0xff && at(1) === 0xd8) {
      // Walk the segments to a frame header (SOF0–SOF15 but DHT, JPG and DAC).
      let i = 2;
      while (i + 9 < bytes.length) {
        if (at(i) !== 0xff) return null;
        const marker = at(i + 1);
        if (marker === 0xff) {
          i++;
          continue;
        }
        const length = view.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return [view.getUint16(i + 7), view.getUint16(i + 5)];
        }
        i += 2 + length;
      }
    }
  } catch {
    // Cut short.
  }
  return null;
}
