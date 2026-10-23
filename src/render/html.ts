import { Marked, type Tokens } from 'marked';

/**
 * A note as a self-standing HTML page, made from its Markdown (render/markdown.ts):
 * the YAML properties become a table, callouts (`> [!type]- Title`) become
 * collapsible `<details>`, links to images show the image. It opens in any
 * browser and prints to PDF from there.
 *
 * The chat's text is not trusted: raw HTML in it is shown as text, and links
 * keep only http(s), mailto and relative targets, so the page runs nothing.
 */

const CALLOUT = /^> \[!(\w+)\][-+]? ?(.*)$/;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A link target the page may follow: web, mail or a file next to the note. */
function safeHref(href: string): string | null {
  const target = href.trim();
  if (/^(https?:|mailto:)/i.test(target)) return target;
  // Relative: no scheme at all (`files/x.png`, `#top`, `chats/…`).
  return /^[a-z][a-z0-9+.-]*:/i.test(target) ? null : target;
}

const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link): string {
      const text = this.parser.parseInline(tokens);
      const target = safeHref(href);
      if (!target) return text;
      const titled = title ? ` title="${escapeHtml(title)}"` : '';
      // A link to an image the note saved shows the image itself.
      if (!/^[a-z]+:/i.test(target) && IMAGE.test(target.split(/[?#]/)[0] ?? '')) {
        return `<a href="${escapeHtml(target)}"${titled}><img src="${escapeHtml(target)}" alt="${escapeHtml(text)}" loading="lazy"></a>`;
      }
      return `<a href="${escapeHtml(target)}"${titled}>${text}</a>`;
    },
    image({ href, title, text }: Tokens.Image): string {
      const target = safeHref(href);
      if (!target) return escapeHtml(text);
      const titled = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(target)}" alt="${escapeHtml(text)}"${titled} loading="lazy">`;
    },
  },
});

function parse(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

/** `key: value` lines of the YAML front matter; values are JSON-style scalars or `[a, b]`. */
function properties(yaml: string): [string, string][] {
  return yaml
    .split('\n')
    .map((line): [string, string] | null => {
      const m = /^([\w-]+):\s*(.*)$/.exec(line);
      if (!m?.[1]) return null;
      const raw = m[2] ?? '';
      let value = raw;
      if (raw === 'null') value = '';
      else if (raw.startsWith('"')) {
        try {
          value = JSON.parse(raw) as string;
        } catch {
          value = raw;
        }
      } else if (raw.startsWith('[')) value = raw.slice(1, -1);
      return [m[1], value];
    })
    .filter((p): p is [string, string] => p !== null && p[1] !== '');
}

/** The body: plain Markdown between callouts, each callout a `<details>`. */
function body(markdown: string): string {
  const out: string[] = [];
  const plain: string[] = [];
  const flush = () => {
    if (plain.length) out.push(parse(plain.join('\n')));
    plain.length = 0;
  };
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = CALLOUT.exec(lines[i] ?? '');
    if (!head) {
      plain.push(lines[i] ?? '');
      continue;
    }
    flush();
    const inner: string[] = [];
    while (i + 1 < lines.length && lines[i + 1]?.startsWith('>')) {
      inner.push((lines[++i] ?? '').replace(/^> ?/, ''));
    }
    const title = marked.parseInline(head[2] ?? '', { async: false });
    out.push(
      `<details class="callout ${escapeHtml(head[1] ?? '')}"><summary>${title}</summary>\n${parse(inner.join('\n'))}</details>`,
    );
  }
  flush();
  return out.join('\n');
}

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --text: #1d1d1f; --muted: #6b6b70; --line: #e3e3e6; --soft: #f5f5f7; --accent: #1f6feb; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1d24; --text: #e8e8e3; --muted: #9a9ca8; --line: #33364a; --soft: #24273a; --accent: #7aa7ff; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 32px 20px 64px; }
table.properties { border-collapse: collapse; font-size: 14px; color: var(--muted); margin-bottom: 24px; }
table.properties td { padding: 2px 16px 2px 0; vertical-align: top; }
table.properties td:first-child { color: var(--muted); opacity: 0.8; }
h1 { font-size: 30px; line-height: 1.25; } h2 { font-size: 19px; margin-top: 32px; border-top: 1px solid var(--line); padding-top: 20px; }
a { color: var(--accent); }
img { max-width: 100%; height: auto; border-radius: 6px; }
pre { background: var(--soft); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
code { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:not(pre) > code { background: var(--soft); padding: 1px 5px; border-radius: 4px; }
blockquote { margin: 0; padding: 4px 16px; border-left: 3px solid var(--line); color: var(--muted); }
details.callout { background: var(--soft); border-left: 3px solid var(--accent); border-radius: 6px; padding: 8px 14px; margin: 12px 0; }
details.callout > summary { cursor: pointer; color: var(--muted); }
table:not(.properties) { border-collapse: collapse; } table:not(.properties) td, table:not(.properties) th { border: 1px solid var(--line); padding: 4px 10px; }
@media print { details.callout { break-inside: avoid; } }
`;

/** The page for a note's Markdown. */
export function renderHtml(markdown: string, title: string): string {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  const rest = front ? markdown.slice(front[0].length) : markdown;
  const table = front
    ? `<table class="properties">${properties(front[1] ?? '')
        .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
        .join('')}</table>\n`
    : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${table}${body(rest)}
</main>
</body>
</html>
`;
}
