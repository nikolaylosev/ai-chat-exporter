export const GEMINI_ORIGIN = 'https://gemini.google.com';

/**
 * A Gemini page: `/app/<id>`, `/gem/<gem>/<id>`, each optionally after an
 * account prefix `/u/<n>` when the user is signed in to several Google accounts.
 */
const CHAT_PATH = /^(\/u\/\d+)?\/(?:app|gem\/([^/]+))\/([0-9a-f]{16})(?:\/|$)/;
const ACCOUNT_PREFIX = /^(\/u\/\d+)(?:\/|$)/;

export interface GeminiChatLocation {
  /** 16 hex digits; the API calls it `c_<id>`. */
  id: string;
  /** `/u/1` for a second account, '' for the default one. */
  accountPrefix: string;
  gemId: string | null;
}

export function parseGeminiUrl(url: string | undefined): GeminiChatLocation | null {
  if (!url) return null;
  try {
    const { origin, pathname } = new URL(url);
    if (origin !== GEMINI_ORIGIN) return null;
    const m = CHAT_PATH.exec(pathname);
    if (!m?.[3]) return null;
    return { id: m[3], accountPrefix: m[1] ?? '', gemId: m[2] ?? null };
  } catch {
    return null;
  }
}

/** Conversation id from a Gemini chat URL, or null for any other page. */
export function geminiConversationId(url: string | undefined): string | null {
  return parseGeminiUrl(url)?.id ?? null;
}

/** `/notebook/<uuid>`, optionally after the account prefix. */
const NOTEBOOK_PATH = /^(?:\/u\/\d+)?\/notebook\/([0-9a-f-]{36})(?:\/|$)/i;

/** The notebook of a notebook page, or null for any other page. */
export function geminiNotebookId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin, pathname } = new URL(url);
    if (origin !== GEMINI_ORIGIN) return null;
    return NOTEBOOK_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** `/u/1` when the page belongs to a second Google account, otherwise ''. */
export function accountPrefixOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return ACCOUNT_PREFIX.exec(new URL(url).pathname)?.[1] ?? '';
  } catch {
    return '';
  }
}
