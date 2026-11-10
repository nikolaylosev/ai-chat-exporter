/** Failure reasons the UI explains to the user. Each has a `error_<code>` string in _locales. */
export type ErrorCode =
  | 'unsupported-page'
  | 'platform-not-ready'
  | 'platform-access'
  | 'obsidian-offline'
  | 'obsidian-key'
  | 'not-a-chat'
  | 'not-signed-in'
  | 'format-changed'
  | 'platform-busy'
  | 'rate-limited'
  | 'chat-not-found'
  | 'tab-not-loaded'
  | 'busy'
  | 'save-dialog'
  | 'download-cancelled'
  | 'save-cancelled'
  | 'archive-lost'
  | 'folder-not-chosen'
  | 'folder-permission'
  | 'folder-missing'
  | 'folder-unsupported'
  | 'failed';

/** An error with a code that survives extension messaging (see shared/messages.ts). */
export class CodedError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodedError';
  }
}

export function errorCode(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? (code as ErrorCode) : 'failed';
}

/**
 * An error message for people: without the request URL, which is long and says
 * nothing to the user (`HTTP 500 for https://claude.ai/api/...` → `HTTP 500`).
 */
export function userMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/ for https?:\/\/\S+/g, '');
}

/**
 * Outcomes of what the user did, or has yet to do, not failures: they are logged
 * as information, so Chrome does not list them on the extension's Errors page.
 * The user is told what to do instead.
 */
const USER_OUTCOMES: ReadonlySet<ErrorCode> = new Set([
  'save-cancelled',
  // A file saved elsewhere after a Save As dialog, or a cancelled file download.
  'save-dialog',
  'download-cancelled',
  'not-a-chat',
  'unsupported-page',
  'busy',
  // Access the user is asked for: Chrome asks again for the chosen folder after a
  // restart, and a platform allowed later (DeepSeek) waits for its button.
  'folder-not-chosen',
  'folder-permission',
  'platform-access',
]);

export function isUserOutcome(code: ErrorCode): boolean {
  return USER_OUTCOMES.has(code);
}
