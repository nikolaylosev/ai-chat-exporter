import type { RawContentReference, RawSearchEntry } from './schema';

/**
 * Cleans ChatGPT's answer Markdown (docs/platforms-chatgpt.md, section 4). The
 * web app renders a few inline tags; older answers (2025) carry the same marks
 * as private-use characters, `citeturn0search0`, which
 * `content_references` describe.
 */

export interface Source {
  title: string;
  url: string;
  attribution?: string | null | undefined;
}

export interface CleanContext {
  /** Search results of the answer, by `search<N>` (ref type and index). */
  sources: ReadonlyMap<string, Source>;
  references: readonly RawContentReference[];
  /** What a `<WritingBlock>` (canvas) becomes; gets its id, variant and the text inside. */
  writingBlock: (id: string, variant: string | null, inner: string) => string;
}

const MARKER = /([^]*)?([^]*)/g;
const WRITING_BLOCK = /<WritingBlock\b([^>]*)>([\s\S]*?)<\/WritingBlock>/g;
const CITE = /<Cite\s+refs=\{(\[[^\]]*\])\}\s*\/>/g;
const ENTITY = /<Entity\b([^>]*?)\/>/g;
const FILE_CITE = /<FileCite\b[^>]*?\/>/g;
/** `[Download x](sandbox:/mnt/data/x)`: a file made by code, saved as an attachment. */
const SANDBOX_LINK = /\[([^\]]*)\]\(sandbox:([^)\s]+)\)/g;
/** `onClick={() => … ("sandbox:/mnt/data/x")}`: the same file, from a layout button. */
const SANDBOX_QUOTED = /["'`]sandbox:([^"'`\s]+)["'`]/g;
/**
 * The layout of a rich answer (seen 2026-10-16): `<row>` and `<box>` hold
 * `<text>`, `<icon/>` and `<button onClick={…}>`. Attribute values may hold `>`.
 */
const LAYOUT_TAG = /<\/?(?:row|box|text|button|icon)\b(?:[^>"{]|"[^"]*"|\{[^}]*\})*>/g;
const LAYOUT_BLOCK = /^<(row|box)\b/;

function attribute(attributes: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? null;
}

/** `turn0search3` → `search3`: the turn number does not match the results' (seen 2026-10-15). */
export function sourceKey(ref: string): string | null {
  const m = /([a-z_]+?)(\d+)$/i.exec(ref.replace(/^turn\d+/, ''));
  return m ? `${m[1]}${m[2]}` : null;
}

export function sourcesOf(entries: readonly RawSearchEntry[]): Map<string, Source> {
  const out = new Map<string, Source>();
  for (const e of entries) {
    if (!e.ref_id || !e.url) continue;
    const key = `${e.ref_id.ref_type}${e.ref_id.ref_index}`;
    if (!out.has(key)) out.set(key, { title: e.title, url: e.url, attribution: e.attribution });
  }
  return out;
}

function link(source: Source): string {
  const label = source.attribution || source.title || source.url;
  return `[${label.replace(/([\\[\]])/g, '\\$1')}](${source.url})`;
}

function citation(refs: string[], sources: ReadonlyMap<string, Source>): string {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const ref of refs) {
    const key = sourceKey(ref);
    const source = key ? sources.get(key) : undefined;
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    links.push(link(source));
  }
  return links.length ? `(${links.join(', ')})` : '';
}

/** A reference's replacement: its own text if it has one, else links to its pages. */
function referenceText(ref: RawContentReference): string {
  if (ref.alt?.trim()) return ref.alt.trim();
  const links = ref.items.filter((i) => i.url).map((i) => link(i));
  return links.length ? `(${links.join(', ')})` : '';
}

/** Paths of files made by code that an answer links to (`/mnt/data/…`). */
export function sandboxPaths(markdown: string): string[] {
  return [
    ...new Set([
      ...[...markdown.matchAll(SANDBOX_LINK)].map((m) => m[2] as string),
      ...[...markdown.matchAll(SANDBOX_QUOTED)].map((m) => m[1] as string),
    ]),
  ];
}

/**
 * A rich answer's layout as plain Markdown: the tags go, the text in them stays,
 * each line of a `<row>` or `<box>` a paragraph of its own (unindented, or it
 * would read as code). Code blocks are left as they are.
 */
export function flattenLayout(markdown: string): string {
  let depth = 0;
  let fence = false;
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    if (depth === 0 && /^\s*(```|~~~)/.test(line)) fence = !fence;
    const tags = fence ? null : line.match(LAYOUT_TAG);
    if (!tags && depth === 0) {
      out.push(line);
      continue;
    }
    const inside = depth > 0;
    for (const tag of tags ?? []) {
      if (tag.startsWith('</')) {
        if (LAYOUT_BLOCK.test(tag.replace('</', '<'))) depth = Math.max(0, depth - 1);
      } else if (LAYOUT_BLOCK.test(tag) && !tag.endsWith('/>')) depth++;
    }
    const text = line.replace(LAYOUT_TAG, '').trim();
    if (inside || depth > 0) {
      if (text) out.push('', text, '');
    } else out.push(text);
  }
  return out.join('\n');
}

export function cleanAnswer(markdown: string, ctx: CleanContext): string {
  let out = flattenLayout(markdown);
  // Only marks are replaced: other references (code blocks) point at real Markdown.
  for (const ref of ctx.references) {
    if (ref.matched_text.includes('')) {
      out = out.split(ref.matched_text).join(referenceText(ref));
    }
  }
  out = out
    .replace(WRITING_BLOCK, (_m, attributes: string, inner: string) => {
      const id = attribute(attributes, 'id') ?? '';
      return ctx.writingBlock(id, attribute(attributes, 'variant'), inner);
    })
    .replace(CITE, (_m, refs: string) => {
      try {
        return citation(JSON.parse(refs) as string[], ctx.sources);
      } catch {
        return '';
      }
    })
    .replace(ENTITY, (_m, attributes: string) => attribute(attributes, 'value') ?? '')
    .replace(FILE_CITE, '')
    .replace(MARKER, (_m, kind: string, body: string) => {
      if (kind === 'cite') return citation(body.split(''), ctx.sources);
      if (kind === 'entity') {
        // `["organization","Statistics Iceland","…"]`: the name is the second item.
        try {
          const value = (JSON.parse(body) as unknown[])[1];
          return typeof value === 'string' ? value : '';
        } catch {
          return '';
        }
      }
      return '';
    })
    .replace(SANDBOX_LINK, '$1');
  return out
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
