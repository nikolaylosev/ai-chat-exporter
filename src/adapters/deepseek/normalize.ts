import type { Attachment, Block, Branch, Conversation, Message } from '../../model/conversation';
import { withImageExtension } from '../../util/image-type';
import type { RawFile, RawFragment, RawMessage, RawSession } from './schema';
import { deepseekFileUrl } from './urls';

/** A run of citation marks in an answer: `[citation:3][citation:7]`. */
const CITATIONS = /(?:\[citation:\d+\])+/g;
const CITATION = /\[citation:(\d+)\]/g;

/** Parts of a message that are the web app's hints, not part of the chat. */
const SKIPPED = new Set(['TIP']);

interface Source {
  url: string;
  label: string;
}

/** Seconds since the epoch, as DeepSeek gives times, to ISO 8601. */
export function isoFromSeconds(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : null;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

function link(source: Source): string {
  return `[${source.label.replace(/([\\[\]])/g, '\\$1')}](${source.url})`;
}

/**
 * An answer's `[citation:N]` marks as links to the search results with
 * `cite_index` N, like `(… [Site](url), [Other](url))`; marks without a result are
 * dropped.
 */
export function linkCitations(markdown: string, sources: ReadonlyMap<number, Source>): string {
  return markdown.replace(CITATIONS, (run, offset: number) => {
    const seen = new Set<string>();
    const links: string[] = [];
    for (const [, n] of run.matchAll(CITATION)) {
      const source = sources.get(Number(n));
      if (!source || seen.has(source.url)) continue;
      seen.add(source.url);
      links.push(link(source));
    }
    if (!links.length) return '';
    const before = offset > 0 ? markdown[offset - 1] : '';
    return `${before && !/\s/.test(before) ? ' ' : ''}(${links.join(', ')})`;
  });
}

function attachment(file: RawFile, filesOrigin: string): Attachment {
  const name = file.file_name || file.id;
  const size = file.file_size ?? undefined;
  if (!file.signed_path) {
    return {
      id: file.id,
      name,
      ...(size ? { size } : {}),
      origin: 'user-upload',
      source: null,
      note: 'unavailable',
    };
  }
  const url = deepseekFileUrl(file.signed_path, file.is_image, filesOrigin);
  if (!file.is_image) {
    return {
      id: file.id,
      name,
      ...(size ? { size } : {}),
      origin: 'user-upload',
      source: { kind: 'url', url },
    };
  }
  // Only a JPEG preview of an image is served; its size is not the upload's.
  return {
    id: file.id,
    name: withImageExtension(name, 'image/jpeg'),
    mime: 'image/jpeg',
    origin: 'user-upload',
    source: { kind: 'url', url },
    note: 'preview',
  };
}

function sourcesOf(fragments: RawFragment[]): Map<number, Source> {
  const out = new Map<number, Source>();
  for (const f of fragments) {
    for (const r of f.results) {
      if (r.cite_index === null || r.cite_index === undefined || !r.url) continue;
      out.set(r.cite_index, { url: r.url, label: r.site_name || r.title || r.url });
    }
  }
  return out;
}

function webSearch(fragments: RawFragment[]): Block | null {
  const seen = new Set<string>();
  const results: { title: string; url: string }[] = [];
  for (const f of fragments) {
    if (f.type !== 'SEARCH') continue;
    for (const r of f.results) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      results.push({ title: r.title || r.site_name || r.url, url: r.url });
    }
  }
  return results.length ? { type: 'web-search', query: '', results } : null;
}

function toMessage(raw: RawMessage, filesOrigin: string): Message {
  const assistant = raw.role === 'ASSISTANT';
  const blocks: Block[] = [];
  const attachments: Attachment[] = [];
  const sources = sourcesOf(raw.fragments);
  let searched = false;
  for (const f of raw.fragments) {
    const content = asText(f.content);
    switch (f.type) {
      case 'REQUEST':
        if (content.trim()) blocks.push({ type: 'text', markdown: content });
        break;
      case 'RESPONSE': {
        const markdown = linkCitations(content, sources).trim();
        if (markdown) blocks.push({ type: 'text', markdown });
        break;
      }
      case 'THINK':
        if (content.trim()) {
          const seconds = f.elapsed_secs ?? undefined;
          blocks.push({
            type: 'thinking',
            markdown: content.trim(),
            ...(seconds ? { seconds } : {}),
          });
        }
        break;
      case 'SEARCH': {
        // One block for all of a message's searches, where the first one was.
        if (searched) break;
        searched = true;
        const search = webSearch(raw.fragments);
        if (search) blocks.push(search);
        break;
      }
      case 'TEMPLATE_RESPONSE':
        // The server's notice in place of an answer ("The server is busy…").
        if (content.trim()) blocks.push({ type: 'text', markdown: `*${content.trim()}*` });
        break;
      case 'FILE':
        for (const file of f.files) attachments.push(attachment(file, filesOrigin));
        break;
      default:
        if (!SKIPPED.has(f.type)) blocks.push({ type: 'unreadable', kind: f.type || 'unknown' });
    }
  }
  return {
    id: String(raw.message_id),
    role: assistant ? 'assistant' : 'user',
    createdAt: isoFromSeconds(raw.inserted_at),
    blocks,
    attachments,
    ...(assistant && raw.status === 'INCOMPLETE' ? { incomplete: true as const } : {}),
  };
}

export interface DeepseekContext {
  url: string;
  filesOrigin: string;
}

/**
 * The message tree into the shared model. The branch the user sees ends at the
 * session's `current_message_id`; without it, at the newest message. Editing a
 * prompt makes a sibling (the first prompt's sibling is another root) and a
 * regenerated answer a sibling answer; each other leaf becomes a branch.
 */
export function toConversation(
  session: RawSession,
  rawMessages: RawMessage[],
  ctx: DeepseekContext,
): Conversation {
  const byId = new Map(rawMessages.map((m) => [m.message_id, m]));
  const parentOf = (id: number): number | null => {
    const parent = byId.get(id)?.parent_id;
    return parent !== null && parent !== undefined && byId.has(parent) ? parent : null;
  };
  const hasChildren = new Set<number>();
  for (const m of rawMessages) {
    const parent = parentOf(m.message_id);
    if (parent !== null) hasChildren.add(parent);
  }
  const age = (id: number) => byId.get(id)?.inserted_at ?? 0;
  const pathTo = (id: number): number[] => {
    const path: number[] = [];
    const seen = new Set<number>();
    for (let at: number | null = id; at !== null && !seen.has(at); at = parentOf(at)) {
      seen.add(at);
      path.push(at);
    }
    return path.reverse();
  };

  const leaves = rawMessages
    .map((m) => m.message_id)
    .filter((id) => !hasChildren.has(id))
    .sort((a, b) => age(a) - age(b) || a - b);
  const pointed = session.current_message_id;
  const current = typeof pointed === 'number' && byId.has(pointed) ? pointed : leaves.at(-1);
  const active = current === undefined ? [] : pathTo(current);
  const emitted = new Set(active);
  const convert = (id: number) => toMessage(byId.get(id) as RawMessage, ctx.filesOrigin);

  const branches: Branch[] = [];
  for (const leaf of leaves) {
    if (emitted.has(leaf)) continue;
    const path = pathTo(leaf);
    let forkIndex = -1;
    path.forEach((id, i) => {
      if (emitted.has(id)) forkIndex = i;
    });
    const rest = path.slice(forkIndex + 1);
    rest.forEach((id) => emitted.add(id));
    if (rest.length) {
      const fork = path[forkIndex];
      branches.push({
        forkAfterMessageId: fork === undefined ? null : String(fork),
        messages: rest.map(convert),
      });
    }
  }

  const model = modeOf(
    session,
    active.map((id) => byId.get(id) as RawMessage),
  );
  return {
    id: session.id,
    platform: 'deepseek',
    title: session.title,
    createdAt: isoFromSeconds(session.inserted_at),
    updatedAt: isoFromSeconds(session.updated_at),
    url: ctx.url,
    messages: active.map(convert),
    branches,
    ...(model ? { model } : {}),
  };
}

/**
 * What the chat ran with, for the note's `model`: DeepSeek names no model, only
 * the session's `model_type` (`default`, `expert`, `vision`) and the DeepThink and
 * Search switches of each message. For example "DeepThink, Search".
 */
function modeOf(session: RawSession, path: RawMessage[]): string | undefined {
  const parts: string[] = [];
  if (session.model_type && session.model_type !== 'default') parts.push(session.model_type);
  const answers = path.filter((m) => m.role === 'ASSISTANT');
  if (answers.some((m) => m.thinking_enabled)) parts.push('DeepThink');
  if (answers.some((m) => m.search_enabled)) parts.push('Search');
  return parts.length ? parts.join(', ') : undefined;
}
