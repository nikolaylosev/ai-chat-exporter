import type {
  Attachment,
  Block,
  Branch,
  Conversation,
  ConversationOptions,
  Message,
} from '../../model/conversation';
import {
  canvasFileName,
  canvasTitle,
  TextdocReplay,
  writingBlockText,
  type TextdocVersion,
} from './canvas';
import { assetPointerSchema, type RawConversation, type RawMessage } from './schema';
import { cleanAnswer, sandboxPaths, sourcesOf, type Source } from './text';

/**
 * How a file is fetched; the adapter turns it into a signed link
 * (docs/platforms-chatgpt.md, section 5).
 */
export type FileRef =
  | { kind: 'file'; fileId: string }
  /** A file made by code, linked as `sandbox:<path>` from the message `messageId`. */
  | { kind: 'sandbox'; messageId: string; path: string };

export interface ExtractedText {
  text: string;
  /** False when ChatGPT kept only the beginning (about 16,000 characters). */
  complete: boolean;
}

export interface Normalized {
  conversation: Conversation;
  /** Attachment id → where to fetch it. */
  files: Map<string, FileRef>;
  /**
   * Attachment id → the text ChatGPT extracted from it for the model: the
   * fallback for a file it no longer gives, such as a long pasted text.
   */
  extracted: Map<string, ExtractedText>;
}

export interface ChatgptContext {
  url: string;
  options: ConversationOptions;
}

/** Content that is the platform's context for the model, not part of the chat. */
const CONTEXT_TYPES = new Set(['user_editable_context', 'model_editable_context']);
/** Steps the page shows only as a status line. */
const SILENT_TYPES = new Set(['reasoning_recap', 'tether_browsing_display', 'tether_quote']);
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const iso = (seconds: number | null | undefined) =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;

/** `sediment://file_…` or `file-service://file-…` → the file id. */
const fileIdOf = (pointer: string) => pointer.replace(/^[a-z-]+:\/\//i, '');

const isWebTool = (recipient: string) => /^(web|browser)(\.|$)/.test(recipient);

function shown(message: RawMessage | null | undefined): message is RawMessage {
  if (!message) return false;
  const role = message.author.role;
  if (role === 'system') return false;
  if (CONTEXT_TYPES.has(message.content.content_type)) return false;
  return !message.metadata.is_visually_hidden_from_conversation;
}

function textParts(message: RawMessage): string {
  return message.content.parts
    .filter((p): p is string => typeof p === 'string')
    .join('\n')
    .trim();
}

function imageParts(message: RawMessage) {
  return message.content.parts.flatMap((part) => {
    const parsed = assetPointerSchema.safeParse(part);
    return parsed.success && parsed.data.asset_pointer ? [parsed.data] : [];
  });
}

/** Search queries from a web tool call, if its input is JSON that names them. */
function searchQueries(input: string): string[] {
  try {
    const args = JSON.parse(input) as { search_query?: { q?: unknown }[]; query?: unknown };
    const queries = (args.search_query ?? []).map((q) => q.q).filter((q) => typeof q === 'string');
    if (typeof args.query === 'string') queries.push(args.query);
    return queries;
  } catch {
    return [];
  }
}

/** Python is shown as Python, JSON arguments as JSON, anything else (shell commands) as plain text. */
function inputLanguage(recipient: string, input: string): string | null {
  if (recipient === 'python') return 'python';
  try {
    JSON.parse(input);
    return 'json';
  } catch {
    return null;
  }
}

/** The image tool's call (`{"skipped_mainline":true}`) says nothing to the reader. */
function isInternalCall(input: string): boolean {
  try {
    const args = JSON.parse(input) as Record<string, unknown>;
    return Object.keys(args).length > 0 && Object.keys(args).every((k) => k.startsWith('skipped'));
  } catch {
    return false;
  }
}

/** Visible messages of a path, grouped into turns: a user message, or a run of the rest. */
function turns(path: RawMessage[]): RawMessage[][] {
  const out: RawMessage[][] = [];
  for (const message of path) {
    const last = out.at(-1);
    const isUser = message.author.role === 'user';
    if (!isUser && last && last[0]?.author.role !== 'user') last.push(message);
    else out.push([message]);
  }
  return out;
}

class Builder {
  readonly files = new Map<string, FileRef>();

  constructor(
    private readonly options: ConversationOptions,
    /** Canvas versions by the id of the tool call that made them. */
    private readonly textdocs: ReadonlyMap<string, TextdocVersion>,
    /** The newest version of each document: other versions are left out unless all are kept. */
    private readonly latestTextdocs: ReadonlySet<string>,
  ) {}

  message(turn: RawMessage[]): Message {
    const first = turn[0] as RawMessage;
    return first.author.role === 'user' ? this.userMessage(first) : this.assistantMessage(turn);
  }

  private file(
    attachments: Attachment[],
    messageId: string,
    fileId: string,
    fields: Omit<Attachment, 'id' | 'source'>,
  ) {
    const id = `${messageId}:${fileId}`;
    if (attachments.some((a) => a.id === id)) return;
    attachments.push({ id, ...fields, source: null });
    this.files.set(id, { kind: 'file', fileId });
  }

  private userMessage(message: RawMessage): Message {
    const attachments: Attachment[] = [];
    for (const a of message.metadata.attachments) {
      this.file(attachments, message.id, a.id, {
        name: a.name || a.id,
        ...(a.mime_type ? { mime: a.mime_type } : {}),
        ...(a.size ? { size: a.size } : {}),
        origin: 'user-upload',
      });
    }
    imageParts(message).forEach((image, i) => {
      const fileId = fileIdOf(image.asset_pointer);
      const ext = MIME_EXTENSIONS[image.mime_type ?? ''] ?? 'png';
      this.file(attachments, message.id, fileId, {
        name: `image-${i + 1}.${ext}`,
        ...(image.mime_type ? { mime: image.mime_type } : {}),
        ...(image.size_bytes ? { size: image.size_bytes } : {}),
        origin: 'user-upload',
      });
    });
    const text = textParts(message);
    return {
      id: message.id,
      role: 'user',
      createdAt: iso(message.create_time),
      blocks: text ? [{ type: 'text', markdown: text }] : [],
      attachments,
    };
  }

  private assistantMessage(turn: RawMessage[]): Message {
    const blocks: Block[] = [];
    const attachments: Attachment[] = [];
    const last = turn.at(-1) as RawMessage;
    const sources = new Map<string, Source>();
    for (const m of turn) {
      for (const group of m.metadata.search_result_groups) {
        for (const [key, source] of sourcesOf(group.entries)) {
          if (!sources.has(key)) sources.set(key, source);
        }
      }
    }
    let queries: string[] = [];
    const addThinking = (markdown: string) => {
      const previous = blocks.at(-1);
      if (previous?.type === 'thinking') previous.markdown += `\n\n${markdown}`;
      else blocks.push({ type: 'thinking', markdown });
    };

    for (const m of turn) {
      const type = m.content.content_type;
      const recipient = m.recipient ?? 'all';
      if (m.author.role === 'tool') {
        this.toolResult(m, blocks, attachments, queries);
        if (m.metadata.search_result_groups.length) queries = [];
        continue;
      }
      if (SILENT_TYPES.has(type)) continue;
      if (type === 'thoughts') {
        const text = m.content.thoughts
          .map((t) => {
            const body = t.content.trim();
            return body ? `**${t.summary.trim()}**\n\n${body}` : t.summary.trim();
          })
          .filter(Boolean)
          .join('\n\n');
        if (text) addThinking(text);
        continue;
      }
      const input = type === 'code' ? (m.content.text ?? '') : textParts(m);
      if (recipient !== 'all') {
        if (isWebTool(recipient)) queries.push(...searchQueries(input));
        else if (recipient.startsWith('canmore.')) this.textdoc(m, attachments);
        else if (!isInternalCall(input)) {
          const language = inputLanguage(recipient, input);
          blocks.push({
            type: 'tool-call',
            name: recipient,
            ...(input ? { input } : {}),
            ...(language ? { inputLanguage: language } : {}),
          });
        }
        continue;
      }
      if (type === 'text' || type === 'multimodal_text') {
        const raw = textParts(m);
        const markdown = cleanAnswer(raw, {
          sources,
          references: m.metadata.content_references,
          writingBlock: (id, variant, inner) => {
            const block = m.metadata.writing_blocks?.[id];
            this.writingBlock(
              m,
              id,
              block?.content ?? inner,
              block?.title ?? null,
              block?.language ?? variant,
              attachments,
            );
            return writingBlockText(block, variant, inner);
          },
        });
        if (markdown) blocks.push({ type: 'text', markdown });
        for (const path of sandboxPaths(raw)) {
          const id = `${m.id}:${path}`;
          attachments.push({
            id,
            name: path.split('/').filter(Boolean).at(-1) ?? 'file',
            origin: 'model-generated',
            source: null,
          });
          this.files.set(id, { kind: 'sandbox', messageId: m.id, path });
        }
        this.images(m, attachments);
        continue;
      }
      blocks.push({ type: 'unreadable', kind: type || 'unknown' });
    }
    return {
      id: last.id,
      role: 'assistant',
      createdAt: iso(turn[0]?.create_time),
      blocks,
      attachments,
    };
  }

  private toolResult(m: RawMessage, blocks: Block[], attachments: Attachment[], queries: string[]) {
    for (const a of m.metadata.attachments) {
      // A file a tool made, such as an image shown by `container.open_image`.
      this.file(attachments, m.id, a.id, {
        name: a.name || a.id,
        ...(a.mime_type ? { mime: a.mime_type } : {}),
        ...(a.size ? { size: a.size } : {}),
        origin: a.mime_type?.startsWith('image/') ? 'image' : 'model-generated',
      });
    }
    if (m.content.content_type === 'execution_output') {
      const call = [...blocks].reverse().find((b) => b.type === 'tool-call');
      if (call?.type === 'tool-call' && call.output === undefined && m.content.text) {
        call.output = m.content.text;
      }
      return;
    }
    const results = m.metadata.search_result_groups.flatMap((g) =>
      g.entries.filter((e) => e.url).map((e) => ({ title: e.title || e.url, url: e.url })),
    );
    if (results.length) {
      blocks.push({ type: 'web-search', query: queries.join('; '), results });
    }
    if (imageParts(m).length && m.author.name) {
      // The image tool has an internal name (`t2uay3k.sj1i4kz`); its call is named for what it does.
      for (const b of blocks)
        if (b.type === 'tool-call' && b.name === m.author.name) b.name = 'image_gen';
    }
    this.images(m, attachments, m.metadata.image_gen_title ?? null);
  }

  /** Images in a model's or a tool's message: generated ones, named by their title. */
  private images(m: RawMessage, attachments: Attachment[], title: string | null = null) {
    const images = imageParts(m);
    images.forEach((image, i) => {
      const ext = MIME_EXTENSIONS[image.mime_type ?? ''] ?? 'png';
      const base = (title ?? '').trim() || 'image';
      this.file(attachments, m.id, fileIdOf(image.asset_pointer), {
        name: `${base}${images.length > 1 ? `-${i + 1}` : ''}.${ext}`,
        ...(image.mime_type ? { mime: image.mime_type } : {}),
        ...(image.size_bytes ? { size: image.size_bytes } : {}),
        origin: 'image',
      });
    });
  }

  private writingBlock(
    m: RawMessage,
    id: string,
    content: string,
    title: string | null,
    type: string | null,
    attachments: Attachment[],
  ) {
    const name = canvasFileName(title ?? canvasTitle(content), type, null);
    attachments.push({
      id: `${m.id}:canvas:${id}`,
      name,
      mime: name.endsWith('.md') ? 'text/markdown' : 'text/plain',
      origin: 'artifact',
      source: { kind: 'text', text: content, mime: 'text/plain' },
    });
  }

  private textdoc(m: RawMessage, attachments: Attachment[]) {
    const version = this.textdocs.get(m.id);
    if (!version) return;
    const latest = this.latestTextdocs.has(m.id);
    if (this.options.artifactVersions === 'latest' && !latest) return;
    const numbered = this.options.artifactVersions === 'all' && !(latest && version.version === 1);
    attachments.push({
      id: `${m.id}:canvas`,
      name: canvasFileName(version.title, version.type, numbered ? version.version : null),
      origin: 'artifact',
      source: { kind: 'text', text: version.content, mime: 'text/plain' },
      note: 'rebuilt-from-chat',
    });
  }
}

/** Canvas versions made along a path, and which of them is each document's newest. */
function replayTextdocs(path: RawMessage[]) {
  const replay = new TextdocReplay();
  const versions = new Map<string, TextdocVersion>();
  const newest = new Map<number, string>();
  for (const m of path) {
    const recipient = m.recipient ?? '';
    if (!recipient.startsWith('canmore.') || m.content.content_type !== 'code') continue;
    const version = replay.apply(recipient, m.content.text ?? '');
    if (!version) continue;
    versions.set(m.id, version);
    newest.set(version.doc, m.id);
  }
  return { versions, latest: new Set(newest.values()) };
}

/** `Use ref_id "turn0file1" to reference this file.`: the header of a file's extracted text. */
const PARSED_HEADER = /Use ref_id "turn\d+file(\d+)"/;
/** Each extracted line starts with its number: `[L12] `. */
const LINE_MARK = /^\[L\d+\] ?/gm;
/** ChatGPT cuts the extracted text, line numbers included, at this length (seen 2026-10-15). */
const EXTRACT_LIMIT = 16384;

/**
 * Text ChatGPT extracted from the user's files for the model, from the tool
 * messages (hidden in the page) that follow the upload. `fileN` counts the
 * message's files that are not images. ChatGPT keeps the first 16,384
 * characters of each, line numbers included; a shorter text is complete
 * (docs/platforms-chatgpt.md, section 5).
 */
function extractedTexts(raw: RawConversation): Map<string, ExtractedText> {
  const out = new Map<string, ExtractedText>();
  const nodes = raw.mapping;
  for (const node of Object.values(nodes)) {
    const m = node.message;
    if (m?.author.role !== 'tool' || m.content.content_type !== 'multimodal_text') continue;
    const strings = m.content.parts.filter((p): p is string => typeof p === 'string');
    const header = strings.findIndex((p) => PARSED_HEADER.test(p));
    if (header < 0) continue;
    const index = Number(PARSED_HEADER.exec(strings[header] as string)?.[1]);
    let user: RawMessage | null = null;
    for (let at = node.parent; at && nodes[at]; at = nodes[at]?.parent) {
      const candidate = nodes[at]?.message;
      if (candidate?.author.role === 'user' && candidate.metadata.attachments.length) {
        user = candidate;
        break;
      }
    }
    const file = user?.metadata.attachments.filter((a) => !a.mime_type?.startsWith('image/'))[
      index
    ];
    if (!user || !file) continue;
    const body = strings
      .slice(header + 1)
      .reduce((all, p) => (all && !all.endsWith('\n') ? `${all}\n${p}` : all + p), '');
    const key = `${user.id}:${file.id}`;
    // The same file read again later says nothing new.
    if (out.has(key)) continue;
    out.set(key, { text: body.replace(LINE_MARK, ''), complete: body.length < EXTRACT_LIMIT });
  }
  return out;
}

/**
 * The `mapping` tree into the shared model. The page shows the path to
 * `current_node`; other leaves become branches, each starting after the last
 * turn it shares with what was already exported.
 */
export function toConversation(raw: RawConversation, ctx: ChatgptContext): Normalized {
  const nodes = raw.mapping;
  const pathTo = (leaf: string): RawMessage[] => {
    const out: RawMessage[] = [];
    const seen = new Set<string>();
    for (let at: string | null | undefined = leaf; at && nodes[at] && !seen.has(at);) {
      seen.add(at);
      const message = nodes[at]?.message;
      if (shown(message)) out.push(message);
      at = nodes[at]?.parent;
    }
    return out.reverse();
  };
  const age = (id: string) => nodes[id]?.message?.create_time ?? 0;
  const leaves = Object.keys(nodes).filter((id) => !nodes[id]?.children.length);
  const current =
    raw.current_node && nodes[raw.current_node]
      ? raw.current_node
      : leaves.reduce<string | null>(
          (best, id) => (!best || age(id) > age(best) ? id : best),
          null,
        );

  const builders: Builder[] = [];
  const build = (path: RawMessage[], from: number) => {
    const { versions, latest } = replayTextdocs(path);
    const builder = new Builder(ctx.options, versions, latest);
    builders.push(builder);
    return turns(path)
      .slice(from)
      .map((t) => builder.message(t));
  };

  const activePath = current ? pathTo(current) : [];
  const messages = build(activePath, 0);
  const emittedNodes = new Set(activePath.map((m) => m.id));
  const emittedMessages = new Set(messages.map((m) => m.id));

  const branches: Branch[] = [];
  const others = leaves
    .filter((id) => id !== current && !emittedNodes.has(id))
    .sort((a, b) => age(a) - age(b));
  for (const leaf of others) {
    const path = pathTo(leaf);
    const groups = turns(path);
    const fork = groups.findIndex((g) => g.some((m) => !emittedNodes.has(m.id)));
    if (fork < 0) continue;
    // The branch follows the last turn exported whole before it.
    let after: string | null = null;
    for (const g of groups.slice(0, fork).reverse()) {
      const id = (g.at(-1) as RawMessage).id;
      if (emittedMessages.has(id)) {
        after = id;
        break;
      }
    }
    const branchMessages = build(path, fork);
    path.forEach((m) => emittedNodes.add(m.id));
    branchMessages.forEach((m) => emittedMessages.add(m.id));
    if (branchMessages.length)
      branches.push({ forkAfterMessageId: after, messages: branchMessages });
  }

  const model = activePath
    .filter((m) => m.author.role === 'assistant')
    .map((m) => m.metadata.model_slug)
    .filter(Boolean)
    .at(-1);
  const files = new Map<string, FileRef>();
  for (const b of builders) for (const [id, ref] of b.files) files.set(id, ref);
  return {
    conversation: {
      id: raw.conversation_id,
      platform: 'chatgpt',
      title: raw.title ?? '',
      createdAt: iso(raw.create_time),
      updatedAt: iso(raw.update_time),
      url: ctx.url,
      messages,
      branches,
      ...(model ? { model } : {}),
    },
    files,
    extracted: extractedTexts(raw),
  };
}
