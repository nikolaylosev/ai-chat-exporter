const PROJECT_PATH =
  /^\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** Project id from a claude.ai project page URL, or null for any other page. */
export function projectIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin, pathname } = new URL(url);
    if (origin !== 'https://claude.ai') return null;
    return PROJECT_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

const CHAT_PATH =
  /^\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** Conversation id from a claude.ai chat URL, or null for any other page. */
export function conversationIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin, pathname } = new URL(url);
    if (origin !== 'https://claude.ai') return null;
    return CHAT_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
