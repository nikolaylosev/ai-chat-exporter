import type { Conversation, Message } from '../model/conversation';
import type { ChatOutline } from '../shared/messages';

/** The start of a message's text for the list of messages: no Markdown marks, one line. */
function preview(message: Message): string {
  const text = message.blocks
    .map((b) => (b.type === 'text' ? b.markdown : ''))
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

const PREVIEW_LENGTH = 400;

/** A chat's messages as the messages page lists them. */
export function outline(conversation: Conversation): ChatOutline {
  return {
    title: conversation.title,
    platform: conversation.platform,
    messages: conversation.messages.map((m) => ({
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      preview: preview(m),
      files: m.attachments.map((a) => a.name),
    })),
  };
}
