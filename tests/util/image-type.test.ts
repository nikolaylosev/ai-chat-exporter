import { describe, expect, it } from 'vitest';
import type { Attachment, Conversation } from '../../src/model/conversation';
import { fixRecompressedNames, imageTypeOf, withImageExtension } from '../../src/util/image-type';

const bytes = (...b: (number | string)[]) =>
  new Uint8Array(
    b.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])),
  );

describe('imageTypeOf', () => {
  it.each([
    [bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    [bytes(0x89, 'PNG', 0x0d, 0x0a), 'image/png'],
    [bytes('GIF89a'), 'image/gif'],
    [bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '), 'image/webp'],
    [bytes('%PDF-1.4'), null],
    [bytes(), null],
  ])('%#', (head, mime) => {
    expect(imageTypeOf(head)?.mime ?? null).toBe(mime);
  });
});

describe('withImageExtension', () => {
  it.each([
    ['photo.png', 'image/jpeg', 'photo.jpg'],
    ['photo.PNG', 'image/jpeg', 'photo.jpg'],
    ['photo.jpeg', 'image/jpeg', 'photo.jpeg'],
    ['photo.jpg', 'image/jpeg', 'photo.jpg'],
    ['photo.heic', 'image/png', 'photo.png'],
    ['scan', 'image/png', 'scan.png'],
    // Not an image extension: kept, the real one added.
    ['v1.2', 'image/jpeg', 'v1.2.jpg'],
    ['photo.png', 'image/tiff', 'photo.png'],
  ])('%s as %s', (name, mime, expected) => {
    expect(withImageExtension(name, mime)).toBe(expected);
  });
});

describe('fixRecompressedNames', () => {
  const file = (name: string, extra: Partial<Attachment>): Attachment => ({
    id: name,
    name,
    origin: 'user-upload',
    source: { kind: 'url', url: `https://lh3.example/${name}` },
    ...extra,
  });

  it('renames only re-encoded images, after their real type', async () => {
    const uploads = [
      file('a.png', { note: 'recompressed', mime: 'image/png' }),
      file('b.png', { note: 'recompressed' }),
      file('c.png', {}),
      file('d.png', { note: 'recompressed' }),
    ];
    const conversation = {
      messages: [{ id: 'm', role: 'user', createdAt: null, blocks: [], attachments: uploads }],
      branches: [],
    } as unknown as Conversation;
    const asked: string[] = [];
    await fixRecompressedNames(conversation, (url) => {
      asked.push(url);
      if (url.endsWith('d.png')) return Promise.reject(new Error('offline'));
      return Promise.resolve(url.endsWith('b.png') ? 'image/png' : 'image/jpeg');
    });
    expect(uploads.map((a) => [a.name, a.mime ?? null])).toEqual([
      ['a.jpg', 'image/jpeg'],
      ['b.png', 'image/png'],
      ['c.png', null],
      ['d.png', null],
    ]);
    expect(asked).toHaveLength(3);
  });
});
