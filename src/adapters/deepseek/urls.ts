export const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';

/** Where uploads are served: `/api` + a message file's `signed_path` (seen 2026-11-07). */
export const DEEPSEEK_FILES_ORIGIN = 'https://files.deepseeksvc.com';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `/a/chat/s/<uuid>`: an open chat. */
const CHAT_PATH = new RegExp(`^/a/chat/s/(${UUID})(?:/|$)`, 'i');

/** Conversation id from a DeepSeek chat URL, or null for any other page. */
export function deepseekConversationId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { origin, pathname } = new URL(url);
    if (origin !== DEEPSEEK_ORIGIN) return null;
    return CHAT_PATH.exec(pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function deepseekChatUrl(id: string, origin = DEEPSEEK_ORIGIN): string {
  return `${origin}/a/chat/s/${id}`;
}

/**
 * A file's link from its `signed_path` (`/file?file_id=…&state=…`). `ty` is
 * required: `r` gives a document's original bytes, `p` an image's preview (the
 * original of an image is refused with HTTP 400), `t` a thumbnail. `fmt=jpeg`
 * turns a preview from WebP into JPEG, which Word notes can show.
 */
export function deepseekFileUrl(
  signedPath: string,
  image: boolean,
  filesOrigin = DEEPSEEK_FILES_ORIGIN,
): string {
  const base = /^https?:\/\//.test(signedPath) ? signedPath : `${filesOrigin}/api${signedPath}`;
  const join = base.includes('?') ? '&' : '?';
  return `${base}${join}${image ? 'ty=p&fmt=jpeg' : 'ty=r'}`;
}
