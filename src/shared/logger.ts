const PREFIX = '[ai-chat-exporter]';

export const log = {
  debug: (...args: unknown[]) => console.debug(PREFIX, ...args),
  info: (...args: unknown[]) => console.info(PREFIX, ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
