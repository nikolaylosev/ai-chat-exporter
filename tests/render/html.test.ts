import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../src/render/html';

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
  'Hello <script>alert(1)</script> and [bad](javascript:alert(2)) and [ok](https://example.com).',
  '',
  '> [!note]- Thinking',
  '> Let me **think**.',
  '>',
  '> Second paragraph.',
  '',
  '```js',
  'const a = "<b>";',
  '```',
  '',
  '**Attachments:**',
  '- [photo.png](files/my%20photo.png)',
  '- [report.pdf](files/report.pdf)',
].join('\n');

describe('renderHtml', () => {
  const html = renderHtml(note, 'A <chat>');

  it('is a page with the title and the properties as a table', () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>A &lt;chat&gt;</title>');
    expect(html).toContain('<tr><td>title</td><td>A &lt;chat&gt;</td></tr>');
    expect(html).toContain('<tr><td>tags</td><td>ai-chat, claude</td></tr>');
    // An empty property is left out.
    expect(html).not.toContain('<td>project</td>');
  });

  it('runs nothing from the chat', () => {
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a href="https://example.com">ok</a>');
    expect(html).toContain('const a = &quot;&lt;b&gt;&quot;;');
  });

  it('makes callouts collapsible and shows saved images', () => {
    expect(html).toMatch(
      /<details class="callout note"><summary>Thinking<\/summary>\n<p>Let me <strong>think<\/strong>.<\/p>\n<p>Second paragraph.<\/p>/,
    );
    expect(html).toContain('<img src="files/my%20photo.png"');
    expect(html).toContain('<a href="files/report.pdf">report.pdf</a>');
  });
});
