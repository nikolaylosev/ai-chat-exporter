import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { renderDocx } from '../../src/render/docx';
import { imageSize } from '../../src/util/image-type';

const note = [
  '---',
  'title: "A <chat>"',
  'platform: claude',
  'project: null',
  'tags: [ai-chat, claude]',
  '---',
  '',
  '# A chat',
  '',
  '## User · 2026-10-20 10:00',
  '',
  'Hello <script>alert(1)</script> & [bad](javascript:alert(2)) and [ok](https://example.com) \u0001.',
  '',
  '> [!note]- Thinking',
  '> Let me **think**.',
  '>',
  '> Second paragraph.',
  '',
  '```js',
  'const a = "<b>";',
  '\tindented();',
  '```',
  '',
  '1. one',
  '2. two',
  '   - inner',
  '',
  '- [x] done',
  '',
  '| a | b |',
  '|---|--:|',
  '| `x` | **y** |',
  '',
  '**Attachments:**',
  '- [photo.png](files/my%20photo.png)',
  '- [anim.webp](files/anim.webp)',
  '- [report.pdf](files/report.pdf)',
].join('\n');

/** A 1000 × 500 png: only its header is read. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function open(markdown: string, images: Record<string, Uint8Array> = {}) {
  const files = unzipSync(renderDocx(markdown, 'A <chat>', (href) => images[href]));
  const text = (path: string) => strFromU8(files[path] ?? new Uint8Array());
  return { files, text, document: text('word/document.xml') };
}

describe('renderDocx', () => {
  it('is a Word package with its parts', () => {
    const { files, text } = open(note);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/core.xml',
        'word/document.xml',
        'word/styles.xml',
        'word/numbering.xml',
        'word/_rels/document.xml.rels',
      ]),
    );
    expect(text('docProps/core.xml')).toContain('<dc:title>A &lt;chat&gt;</dc:title>');
  });

  it('turns the front matter into a table without empty values', () => {
    const { document } = open(note);
    expect(document).toContain('>platform</w:t>');
    expect(document).toContain('>ai-chat, claude</w:t>');
    expect(document).not.toContain('>project</w:t>');
  });

  it('keeps headings, code with tabs and line breaks, and inline styles', () => {
    const { document } = open(note);
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('<w:pStyle w:val="Heading2"/>');
    expect(document).toContain('<w:pStyle w:val="Code"/>');
    expect(document).toContain('const a = &quot;&lt;b&gt;&quot;;</w:t><w:br/><w:tab/>');
    expect(document).toMatch(/<w:rStyle w:val="CodeChar"\/><\/w:rPr><w:t[^>]*>x</);
    expect(document).toMatch(/<w:b\/><\/w:rPr><w:t[^>]*>y</);
  });

  it('shows raw HTML as text, drops unsafe links and characters XML forbids', () => {
    const { document, text } = open(note);
    expect(document).toContain('&lt;script&gt;');
    expect(document).not.toContain('<script>');
    expect(document).not.toContain('\u0001');
    const rels = text('word/_rels/document.xml.rels');
    expect(rels).toContain('Target="https://example.com" TargetMode="External"');
    expect(rels).not.toContain('javascript:');
    expect(document).toContain('>bad</w:t>');
  });

  it('puts a callout into a shaded block under its title', () => {
    const { document } = open(note);
    expect(document).toMatch(/CalloutTitle"\/><\/w:pPr><w:r><w:t[^>]*>Thinking</);
    expect(document).toMatch(/Callout"\/><\/w:pPr><w:r><w:t[^>]*>Let me </);
    expect(document).toMatch(/Callout"\/><\/w:pPr><w:r><w:t[^>]*>Second paragraph/);
  });

  it('numbers ordered lists, nests bullets and ticks done tasks', () => {
    const { document, text } = open(note);
    expect(document).toContain('<w:ilvl w:val="0"/><w:numId w:val="1"/>');
    expect(document).toContain('<w:ilvl w:val="1"/><w:numId w:val="2"/>');
    expect(document).toContain('☑ ');
    const numbering = text('word/numbering.xml');
    expect(numbering).toContain(
      '<w:num w:numId="1"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>',
    );
    expect(numbering).toContain('<w:num w:numId="2"><w:abstractNumId w:val="0"/>');
  });

  it('keeps a table with its header row and alignment', () => {
    const { document } = open(note);
    expect(document).toContain('<w:tblStyle w:val="TableGrid"/>');
    expect(document).toContain('<w:tblHeader/>');
    expect(document).toContain('<w:jc w:val="right"/>');
  });

  it('embeds a saved png at its size, scaled to the page; other files stay links', () => {
    const { files, document, text } = open(note, { 'files/my photo.png': png(1000, 500) });
    expect(files['word/media/image1.png']).toBeDefined();
    // 1000 px is wider than the text: 17 cm wide, the height in proportion.
    expect(document).toContain('<wp:extent cx="6120000" cy="3060000"/>');
    const rels = text('word/_rels/document.xml.rels');
    expect(rels).toContain('Target="media/image1.png"');
    expect(rels).toContain('Target="files/anim.webp" TargetMode="External"');
    expect(rels).toContain('Target="files/report.pdf" TargetMode="External"');
  });

  it('links an image it was not given', () => {
    const { files, text } = open(note);
    expect(Object.keys(files).some((f) => f.startsWith('word/media/'))).toBe(false);
    expect(text('word/_rels/document.xml.rels')).toContain('Target="files/my%20photo.png"');
  });

  it('restarts a numbered list at its start', () => {
    const { text } = open('3. three\n4. four\n');
    expect(text('word/numbering.xml')).toContain('<w:startOverride w:val="3"/>');
  });
});

describe('imageSize', () => {
  it('reads png, gif and jpeg headers', () => {
    expect(imageSize(png(12, 34))).toEqual({ width: 12, height: 34 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 40, 0, 20, 0, 0, 0]);
    expect(imageSize(gif)).toEqual({ width: 40, height: 20 });
    // SOI, an APP0 segment of 4 bytes, then SOF0 with height 300 and width 400.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c,
      0x01, 0x90, 0x03, 0x00, 0x00, 0x00,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 400, height: 300 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
