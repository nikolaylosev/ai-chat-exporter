/** Failure reasons the UI explains to the user. Each has a `error_<code>` string in _locales. */
export type ErrorCode =
  | 'unsupported-page'
  | 'platform-not-ready'
  | 'not-a-chat'
  | 'not-signed-in'
  | 'format-changed'
  | 'platform-busy'
  | 'rate-limited'
  | 'chat-not-found'
  | 'tab-not-loaded'
  | 'busy'
  | 'save-dialog'
  | 'save-cancelled'
  | 'archive-lost'
  | 'folder-not-chosen'
  | 'folder-permission'
  | 'folder-missing'
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
 * Outcomes of what the user did, not failures: they are logged as information,
 * so Chrome does not list them on the extension's Errors page.
 */
const USER_OUTCOMES: ReadonlySet<ErrorCode> = new Set([
  'save-cancelled',
  // A cancelled file download: Chrome does not say whether a Save As dialog was shown.
  'save-dialog',
  'not-a-chat',
  'unsupported-page',
  'busy',
]);

export function isUserOutcome(code: ErrorCode): boolean {
  return USER_OUTCOMES.has(code);
}
