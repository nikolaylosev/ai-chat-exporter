import type { Attachment, Block, Conversation, Message } from '../model/conversation';

/**
 * A note as JSON, for people who process their chats themselves: the
 * conversation as the extension reads it, filtered by the same settings as the
 * Markdown. An attachment carries where it was saved (`path`, relative to the
 * note) or why it was not (`error`); never its download link, which can be a
 * signed URL.
 */

export const JSON_FORMAT = 'ai-chat-exporter/conversation@1';

export interface JsonOptions {
  includeThinking: boolean;
  includeToolCalls: boolean;
  includeBranches: boolean;
  exportedAt: Date;
  /** Saved files by attachment id: their path relative to the note. */
  attachmentPaths?: ReadonlyMap<string, string>;
  attachmentErrors?: ReadonlyMap<string, string>;
}

function keep(block: Block, o: JsonOptions): boolean {
  if (block.type === 'thinking') return o.includeThinking;
  if (block.type === 'tool-call' || block.type === 'web-search') return o.includeToolCalls;
  return true;
}

function attachment(a: Attachment, o: JsonOptions) {
  const path = o.attachmentPaths?.get(a.id);
  const error = o.attachmentErrors?.get(a.id);
  return {
    name: a.name,
    ...(a.mime ? { mime: a.mime } : {}),
    ...(a.size !== undefined ? { size: a.size } : {}),
    origin: a.origin,
    ...(a.note ? { note: a.note } : {}),
    ...(path ? { path } : {}),
    ...(error ? { error } : {}),
  };
}

function message(m: Message, o: JsonOptions) {
  return {
    id: m.id,
    role: m.role,
    createdAt: m.createdAt,
    blocks: m.blocks.filter((b) => keep(b, o)),
    attachments: m.attachments.map((a) => attachment(a, o)),
  };
}

export function renderJson(c: Conversation, o: JsonOptions): string {
  const doc = {
    format: JSON_FORMAT,
    exportedAt: o.exportedAt.toISOString(),
    conversation: {
      id: c.id,
      platform: c.platform,
      title: c.title,
      url: c.url,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      ...(c.model ? { model: c.model } : {}),
      ...(c.project ? { project: c.project } : {}),
      ...(c.archived ? { archived: true } : {}),
      messages: c.messages.map((m) => message(m, o)),
      branches: o.includeBranches
        ? c.branches.map((b) => ({
            forkAfterMessageId: b.forkAfterMessageId,
            messages: b.messages.map((m) => message(m, o)),
          }))
        : [],
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
