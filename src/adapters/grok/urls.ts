export const GROK_ORIGIN = 'https://grok.com';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `/c/<uuid>`, possibly inside a longer path. */
const CHAT_PATH = new RegExp(`(?:^|/)c/(${UUID})(?:/|$)`, 'i');
/** `/project/<uuid>`: a project's page; its chats open there as `?chat=<uuid>`. */
const PROJECT_PATH = new RegExp(`^/project/(${UUID})(?:/|$)`, 'i');
const ID = new RegExp(`^${UUID}$`, 'i');

export interface GrokChatLocation {
  id: string;
  /** `?rid=`: the answer the page shows where a message has several. */
  responseId: string | null;
}

export function parseGrokUrl(url: string | undefined): GrokChatLocation | null {
  if (!url) return null;
  try {
    const { origin, pathname, searchParams } = new URL(url);
    if (origin !== GROK_ORIGIN) return null;
    const chat = searchParams.get('chat');
    const id =
      CHAT_PATH.exec(pathname)?.[1] ??
      (PROJECT_PATH.test(pathname) && chat && ID.test(chat) ? chat : undefined);
    if (!id) return null;
    const rid = searchParams.get('rid');
    return { id: id.toLowerCase(), responseId: rid && ID.test(rid) ? rid : null };
  } catch {
    return null;
  }
}

/** Project id from a project page or a chat open in it, or null for any other page. */
export function grokProjectId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin, pathname } = new URL(url);
    if (origin !== GROK_ORIGIN) return null;
    return PROJECT_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Conversation id from a Grok chat URL, or null for any other page. */
export function grokConversationId(url: string | undefined): string | null {
  return parseGrokUrl(url)?.id ?? null;
}

/** Where a file key from a response (`users/<id>/<asset>/content`) is served. */
export const GROK_ASSETS_ORIGIN = 'https://assets.grok.com';
