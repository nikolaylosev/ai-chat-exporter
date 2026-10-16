import type { Attachment, Block, Branch, Conversation, Message } from '../../model/conversation';
import {
  fileEntrySchema,
  knowledgeItemSchema,
  legacyAttachmentSchema,
  localResourceSchema,
  parseOrThrow,
  PlatformFormatError,
  textBlockSchema,
  thinkingBlockSchema,
  toolResultBlockSchema,
  toolUseBlockSchema,
  type RawConversation,
  type RawMessage,
} from './schema';

/** Parent id of the first message in a conversation. */
export const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';
/** Tools that only set up the sandbox; messages made of them are not part of the dialogue. */
const SERVICE_TOOLS = new Set(['prepare_session']);
const WEB_SEARCH_TOOLS = new Set(['web_search', 'WebSearch']);

export interface NormalizeContext {
  /** `https://claude.ai` */
  origin: string;
  orgId: string;
  projectName?: string;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/** Path from the root to `leafId`, following parent links. */
function pathTo(leafId: string, byId: Map<string, RawMessage>): RawMessage[] {
  const path: RawMessage[] = [];
  const seen = new Set<string>();
  for (let m = byId.get(leafId); m && !seen.has(m.uuid); m = byId.get(m.parent_message_uuid)) {
    seen.add(m.uuid);
    path.push(m);
  }
  return path.reverse();
}

/** Leaf of the branch the user sees; the newest message when the platform's leaf is unknown. */
function activeLeafId(raw: RawConversation): string | undefined {
  if (raw.chat_messages.some((m) => m.uuid === raw.current_leaf_message_uuid)) {
    return raw.current_leaf_message_uuid;
  }
  return raw.chat_messages.reduce<RawMessage | undefined>(
    (best, m) => (!best || m.index > best.index ? m : best),
    undefined,
  )?.uuid;
}

/** Raw messages of the branch the user sees, root first. */
export function activePath(raw: RawConversation): RawMessage[] {
  const leaf = activeLeafId(raw);
  return leaf ? pathTo(leaf, new Map(raw.chat_messages.map((m) => [m.uuid, m]))) : [];
}

export function normalizeConversation(raw: RawConversation, ctx: NormalizeContext): Conversation {
  const byId = new Map(raw.chat_messages.map((m) => [m.uuid, m]));
  const hasChildren = new Set(raw.chat_messages.map((m) => m.parent_message_uuid));
  const activeLeaf = activeLeafId(raw);

  const convert = (m: RawMessage) => normalizeMessage(m, raw.uuid, ctx);
  const active = activePath(raw);
  const emitted = new Set(active.map((m) => m.uuid));

  const branches: Branch[] = [];
  const otherLeaves = raw.chat_messages
    .filter((m) => !hasChildren.has(m.uuid) && m.uuid !== activeLeaf)
    .sort((a, b) => a.index - b.index);
  for (const leaf of otherLeaves) {
    const path = pathTo(leaf.uuid, byId);
    let forkIndex = -1;
    path.forEach((m, i) => {
      if (emitted.has(m.uuid)) forkIndex = i;
    });
    const rest = path.slice(forkIndex + 1);
    rest.forEach((m) => emitted.add(m.uuid));
    const messages = rest.map(convert).filter((m): m is Message => m !== null);
    if (messages.length === 0) continue;
    branches.push({ forkAfterMessageId: path[forkIndex]?.uuid ?? null, messages });
  }

  const conversation: Conversation = {
    id: raw.uuid,
    platform: 'claude',
    title: raw.name,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: `${ctx.origin}/chat/${raw.uuid}`,
    messages: active.map(convert).filter((m): m is Message => m !== null),
    branches,
  };
  if (raw.model) conversation.model = raw.model;
  if (ctx.projectName) conversation.project = ctx.projectName;
  return conversation;
}

/** Returns null for service messages that are not part of the dialogue. */
export function normalizeMessage(
  m: RawMessage,
  conversationId: string,
  ctx: NormalizeContext,
): Message | null {
  if (m.sender !== 'human' && m.sender !== 'assistant') return null;
  const where = `chat_messages[${m.index}]`;
  const isService =
    m.content.length > 0 &&
    m.content.every(
      (b) =>
        (b.type === 'tool_use' || b.type === 'tool_result') &&
        SERVICE_TOOLS.has(String((b as { name?: unknown }).name)),
    );
  if (isService) return null;

  const files = `${ctx.origin}/api/organizations/${ctx.orgId}`;
  const blocks: Block[] = [];
  const attachments: Attachment[] = [];
  const toolCalls = new Map<string, Block>();

  const addAttachment = (a: Attachment) => {
    if (!attachments.some((x) => x.id === a.id)) attachments.push(a);
  };

  // Entries are checked one by one: an odd entry is skipped, not the whole conversation.
  for (const entry of m.files ?? []) {
    const parsed = fileEntrySchema.safeParse(entry);
    if (!parsed.success) continue;
    const f = parsed.data;
    addAttachment({
      id: f.file_uuid,
      name: f.file_name,
      ...(f.size_bytes !== undefined ? { size: f.size_bytes } : {}),
      origin: f.file_kind === 'image' ? 'image' : 'user-upload',
      source: { kind: 'url', url: `${files}/files/${f.file_uuid}/contents` },
    });
  }
  for (const entry of m.attachments ?? []) {
    const parsed = legacyAttachmentSchema.safeParse(entry);
    if (!parsed.success) continue;
    const a = parsed.data;
    addAttachment({
      id: a.id,
      name: a.file_name || 'pasted-text',
      ...(a.file_size !== undefined ? { size: a.file_size } : {}),
      origin: 'user-upload',
      source:
        a.extracted_content !== undefined
          ? { kind: 'text', text: a.extracted_content, mime: 'text/plain' }
          : null,
      note: 'extracted-text-only',
    });
  }

  m.content.forEach((raw, i) => {
    const at = `${where}.content[${i}]`;
    try {
      readBlock(raw, at);
    } catch (error) {
      // A block in an unexpected shape is marked in the note instead of failing the chat.
      if (!(error instanceof PlatformFormatError)) throw error;
      console.warn('[ai-chat-exporter] Unreadable block', error.message);
      blocks.push({ type: 'unreadable', kind: raw.type });
    }
  });

  function readBlock(raw: RawMessage['content'][number], at: string): void {
    switch (raw.type) {
      case 'text': {
        const b = parseOrThrow(textBlockSchema, raw, at);
        if (b.text.trim()) blocks.push({ type: 'text', markdown: b.text });
        break;
      }
      case 'thinking': {
        const b = parseOrThrow(thinkingBlockSchema, raw, at);
        if (b.thinking.trim()) blocks.push({ type: 'thinking', markdown: b.thinking });
        break;
      }
      case 'tool_use': {
        const b = parseOrThrow(toolUseBlockSchema, raw, at);
        let block: Block;
        if (WEB_SEARCH_TOOLS.has(b.name)) {
          const query = (b.input as { query?: unknown } | null)?.query;
          block = {
            type: 'web-search',
            query: typeof query === 'string' ? query : '',
            results: [],
          };
        } else {
          block = { type: 'tool-call', name: b.name };
          if (b.message) block.label = b.message;
          const input = stringify(b.input);
          if (input !== undefined) block.input = input;
        }
        toolCalls.set(b.id, block);
        blocks.push(block);
        break;
      }
      case 'tool_result': {
        const b = parseOrThrow(toolResultBlockSchema, raw, at);
        const call = toolCalls.get(b.tool_use_id);
        if (call?.type === 'web-search') {
          for (const item of b.content) {
            const k = knowledgeItemSchema.safeParse(item);
            if (k.success) call.results.push({ title: k.data.title, url: k.data.url });
          }
        } else if (call?.type === 'tool-call') {
          const text = b.content
            .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
            .filter(Boolean)
            .join('\n');
          if (text) call.output = text;
          if (b.is_error) call.isError = true;
        }
        for (const d of b.file_deliveries ?? []) {
          addAttachment({
            id: d.file_uuid,
            name: basename(d.path),
            origin: 'model-generated',
            source: { kind: 'url', url: `${files}/files/${d.file_uuid}/contents` },
          });
        }
        if (b.name === 'present_files') {
          b.content.forEach((item, j) => {
            if (item.type !== 'local_resource') return;
            const r = parseOrThrow(localResourceSchema, item, `${at}.content[${j}]`);
            const query = new URLSearchParams({ path: r.file_path });
            addAttachment({
              id: `${conversationId}:${r.file_path}`,
              name: basename(r.file_path),
              ...(r.mime_type ? { mime: r.mime_type } : {}),
              origin: 'model-generated',
              source: {
                kind: 'url',
                url: `${files}/conversations/${conversationId}/wiggle/download-file?${query.toString()}`,
              },
            });
          });
        }
        break;
      }
      default:
        // image blocks duplicate entries of `files`; other types are not exported.
        break;
    }
  }

  return {
    id: m.uuid,
    role: m.sender === 'human' ? 'user' : 'assistant',
    createdAt: m.created_at,
    blocks,
    attachments,
  };
}
