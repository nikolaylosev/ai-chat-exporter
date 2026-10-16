export const CHATGPT_ORIGIN = 'https://chatgpt.com';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `/c/<uuid>`, also inside a custom GPT's or a project's path (`/g/<gizmo>/c/<uuid>`). */
const CHAT_PATH = new RegExp(`(?:^|/)c/(${UUID})(?:/|$)`, 'i');

/** Conversation id from a ChatGPT chat URL, or null for any other page. */
export function chatgptConversationId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin, pathname } = new URL(url);
    if (origin !== CHATGPT_ORIGIN) return null;
    return CHAT_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** `/g/g-p-<32 hex>[-<slug>]/…`: a project's page or one of its chats. */
const PROJECT_PATH = /^\/g\/(g-p-[0-9a-f]{32})(?:-[^/]*)?(?:\/|$)/i;

/** Project id (`g-p-<32 hex>`) from a project page or a project chat's URL, or null. */
export function chatgptProjectId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin, pathname } = new URL(url);
    if (origin !== CHATGPT_ORIGIN) return null;
    return PROJECT_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
