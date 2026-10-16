import type { Attachment, Block, Branch, Conversation, Message } from '../../model/conversation';
import type { RawConversationMeta, RawResponse, RawResponseNode } from './schema';

/** `<grok:render card_id="…" card_type="…" type="…"></grok:render>`: a card in an answer. */
const RENDER_TAG = /<grok:render\b([^>]*)>[\s\S]*?<\/grok:render>/g;
/**
 * Cards shown elsewhere in the note: generated images and files are attachments,
 * citations are dropped.
 */
const KNOWN_CARDS = new Set([
  'generated_image_card',
  'render_generated_image',
  'rendered_file_card',
  'render_file',
  'render_inline_citation',
  'citation_card',
]);

function attribute(attributes: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? null;
}

/** An answer's Markdown without card tags, and the kinds of cards that could not be shown. */
export function cleanAnswer(markdown: string): { markdown: string; unknownCards: string[] } {
  const unknownCards = new Set<string>();
  const cleaned = markdown.replace(RENDER_TAG, (_tag, attributes: string) => {
    const kind = attribute(attributes, 'card_type') ?? attribute(attributes, 'type') ?? 'card';
    const type = attribute(attributes, 'type');
    if (!KNOWN_CARDS.has(kind) && !(type && KNOWN_CARDS.has(type))) unknownCards.add(kind);
    return '';
  });
  return {
    markdown: cleaned
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    unknownCards: [...unknownCards],
  };
}

/** Grok project name from a `workspaces` entry (`{ workspaceId, name, … }`). */
export function workspaceName(workspaces: unknown[]): string | undefined {
  for (const w of workspaces) {
    if (w && typeof w === 'object') {
      const name = (w as Record<string, unknown>).name ?? (w as Record<string, unknown>).title;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  }
  return undefined;
}

interface CardFile {
  key: string;
  name?: string;
  mime?: string;
  size?: number;
  image: boolean;
}

/**
 * Files in a message's cards: generated images (`image_chunk`), and files the
 * model made (`rendered_file_card`: `file_name`, `mime_type`, `file_size`, and
 * `url`, a key on assets.grok.com; seen 2026-10-16).
 */
function cardFiles(response: RawResponse): CardFile[] {
  const out: CardFile[] = [];
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  for (const json of response.cardAttachmentsJson) {
    try {
      const card = JSON.parse(json) as {
        image_chunk?: { imageUrl?: unknown; mimeType?: unknown };
        cardType?: unknown;
        file_name?: unknown;
        mime_type?: unknown;
        file_size?: unknown;
        url?: unknown;
      };
      const image = str(card.image_chunk?.imageUrl);
      if (image) {
        const mime = str(card.image_chunk?.mimeType);
        out.push({ key: image, ...(mime ? { mime } : {}), image: true });
      }
      const file = card.cardType === 'rendered_file_card' ? str(card.url) : undefined;
      if (file) {
        const name = str(card.file_name);
        const mime = str(card.mime_type);
        out.push({
          key: file,
          ...(name ? { name } : {}),
          ...(mime ? { mime } : {}),
          ...(typeof card.file_size === 'number' ? { size: card.file_size } : {}),
          image: false,
        });
      }
    } catch {
      // A card that is not JSON has no file to save.
    }
  }
  return out;
}

/**
 * Files of a message: asset metadata first (it has the size and whether the model
 * made the file), then upload metadata and image cards it does not cover.
 */
function attachments(response: RawResponse, assetsOrigin: string): Attachment[] {
  const out: Attachment[] = [];
  const keys = new Set<string>();
  const fromModel = response.sender === 'assistant';
  const add = (
    key: string | null | undefined,
    name: string,
    mime: string | null | undefined,
    size: number | null | undefined,
    generated: boolean,
  ) => {
    if (key) {
      if (keys.has(key)) return;
      keys.add(key);
    }
    const isImage = mime?.startsWith('image/') ?? false;
    out.push({
      id: `${response.responseId}:file:${out.length}`,
      name: name || key?.split('/').filter(Boolean).at(-1) || 'file',
      ...(mime ? { mime } : {}),
      ...(size ? { size } : {}),
      origin: generated ? (isImage ? 'image' : 'model-generated') : 'user-upload',
      source: key ? { kind: 'url', url: `${assetsOrigin}/${key.replace(/^\/+/, '')}` } : null,
      ...(key ? {} : { note: 'unavailable' as const }),
    });
  };
  for (const a of response.fileAttachmentAssetMetadata) {
    add(a.key, a.name, a.mimeType, a.sizeBytes, a.isModelGenerated || fromModel);
  }
  for (const f of response.fileAttachmentsMetadata) {
    if (f.fileUri && keys.has(f.fileUri)) continue;
    add(f.fileUri, f.fileName, f.fileMimeType, null, fromModel);
  }
  for (const card of cardFiles(response)) {
    add(card.key, card.name ?? '', card.mime, card.size, true);
  }
  return out;
}

/** Reasoning steps as Markdown: headers in bold, other text as it is. */
function thinking(response: RawResponse): string {
  return response.steps
    .map((step) => {
      const body = step.text.join('\n').trim();
      if (!body) return '';
      return step.tags.includes('header') ? `**${body}**` : body;
    })
    .filter(Boolean)
    .join('\n\n');
}

function webSearch(response: RawResponse): Block | null {
  const seen = new Set<string>();
  const results: { title: string; url: string }[] = [];
  for (const r of [...response.webSearchResults, ...response.citedWebSearchResults]) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    results.push({ title: r.title || r.url, url: r.url });
  }
  return results.length ? { type: 'web-search', query: response.query ?? '', results } : null;
}

function toMessage(response: RawResponse, assetsOrigin: string): Message {
  const blocks: Block[] = [];
  if (response.sender === 'assistant') {
    const reasoning = thinking(response);
    if (reasoning) blocks.push({ type: 'thinking', markdown: reasoning });
    const search = webSearch(response);
    if (search) blocks.push(search);
    const { markdown, unknownCards } = cleanAnswer(response.message);
    if (markdown) blocks.push({ type: 'text', markdown });
    for (const kind of unknownCards) blocks.push({ type: 'unreadable', kind });
  } else if (response.message.trim()) {
    blocks.push({ type: 'text', markdown: response.message });
  }
  return {
    id: response.responseId,
    role: response.sender === 'assistant' ? 'assistant' : 'user',
    createdAt: response.createTime ?? null,
    blocks,
    attachments: attachments(response, assetsOrigin),
  };
}

export interface GrokContext {
  url: string;
  assetsOrigin: string;
  /** `?rid=` of the open page: the answer the user sees at its fork. */
  responseId?: string | null;
}

/**
 * The tree of responses into the shared model. Where a message has several
 * answers (Regenerate) or versions, the page shows the one in `?rid=`, otherwise
 * the newest; the others become branches.
 */
export function toConversation(
  meta: RawConversationMeta,
  nodes: RawResponseNode[],
  responses: RawResponse[],
  ctx: GrokContext,
): Conversation {
  const byId = new Map(responses.map((r) => [r.responseId, r]));
  // A node without its response cannot be shown; the tree keeps only the others.
  const known = nodes.filter((n) => byId.has(n.responseId));
  const ids = new Set(known.map((n) => n.responseId));
  const order = new Map(known.map((n, i) => [n.responseId, i]));
  const parents = new Map(known.map((n) => [n.responseId, n.parentResponseId]));
  const parentOf = (id: string) => {
    const parent = parents.get(id);
    return parent && ids.has(parent) ? parent : null;
  };
  const children = new Map<string | null, string[]>();
  for (const n of known) {
    const parent = parentOf(n.responseId);
    children.set(parent, [...(children.get(parent) ?? []), n.responseId]);
  }
  const age = (id: string) => byId.get(id)?.createTime ?? '';
  const newest = (list: string[]) =>
    list.reduce<string | undefined>((best, id) => {
      if (!best) return id;
      const cmp = age(id).localeCompare(age(best));
      return cmp > 0 || (cmp === 0 && (order.get(id) ?? 0) > (order.get(best) ?? 0)) ? id : best;
    }, undefined);

  const pathTo = (id: string) => {
    const path: string[] = [];
    const seen = new Set<string>();
    for (let at: string | null = id; at && !seen.has(at); at = parentOf(at)) {
      seen.add(at);
      path.push(at);
    }
    return path.reverse();
  };
  const descend = (path: string[]) => {
    const seen = new Set(path);
    for (let next = newest(children.get(path.at(-1) ?? null) ?? []); next && !seen.has(next);) {
      seen.add(next);
      path.push(next);
      next = newest(children.get(next) ?? []);
    }
    return path;
  };

  const active = descend(ctx.responseId && ids.has(ctx.responseId) ? pathTo(ctx.responseId) : []);
  const emitted = new Set(active);
  const convert = (id: string) => toMessage(byId.get(id) as RawResponse, ctx.assetsOrigin);

  const branches: Branch[] = [];
  const leaves = known
    .map((n) => n.responseId)
    .filter((id) => !children.has(id) && !emitted.has(id))
    .sort((a, b) => age(a).localeCompare(age(b)));
  for (const leaf of leaves) {
    const path = pathTo(leaf);
    let forkIndex = -1;
    path.forEach((id, i) => {
      if (emitted.has(id)) forkIndex = i;
    });
    const rest = path.slice(forkIndex + 1);
    rest.forEach((id) => emitted.add(id));
    if (rest.length) {
      branches.push({ forkAfterMessageId: path[forkIndex] ?? null, messages: rest.map(convert) });
    }
  }

  const messages = active.map(convert);
  const model = active
    .map((id) => byId.get(id)?.model)
    .filter(Boolean)
    .at(-1);
  const project = workspaceName(meta.workspaces);
  return {
    id: meta.conversationId,
    platform: 'grok',
    title: meta.title,
    createdAt: meta.createTime ?? null,
    updatedAt: meta.modifyTime ?? null,
    url: ctx.url,
    messages,
    branches,
    ...(model ? { model } : {}),
    ...(project ? { project } : {}),
  };
}
