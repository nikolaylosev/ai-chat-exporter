import { ChatNotFoundError, PlatformBusyError, PlatformFormatError } from '../adapters/errors';
import type { PlatformAdapter } from '../adapters/types';
import { CodedError } from '../shared/errors';
import { send } from '../shared/messages';
import type { Platform } from '../shared/platform';
import { HttpError } from '../util/http';

/** Whether this copy of the content script still talks to a live extension. */
export const isAlive = (): boolean => {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
};

export function toCodedError(error: unknown): unknown {
  if (error instanceof HttpError && error.isAuth) {
    return new CodedError('not-signed-in', error.message);
  }
  // Still 429 after the retries: the platform limits how often it is asked.
  if (error instanceof HttpError && error.status === 429) {
    return new CodedError('rate-limited', error.message);
  }
  // The message is the field path, shown to the user to report what changed.
  if (error instanceof PlatformFormatError) return new CodedError('format-changed', error.path);
  if (error instanceof PlatformBusyError) return new CodedError('platform-busy', error.message);
  // Gemini says so itself; the REST platforms answer 404 for a deleted chat.
  if (error instanceof ChatNotFoundError || (error instanceof HttpError && error.status === 404)) {
    return new CodedError('chat-not-found', error.message);
  }
  return error;
}

/** Runs an adapter call and turns its errors into codes the UI can explain. */
export async function coded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw toCodedError(error);
  }
}

/**
 * The chat list for the export page: progress after each page, and a stop that
 * ends it after the current page with the chats read so far.
 */
export function listHandlers(platform: Platform, adapter: PlatformAdapter) {
  let stopped = false;
  return {
    'conversations:list': ({ known }: { known?: [string, string | null][] }) => {
      stopped = false;
      return coded(() =>
        adapter.listConversations(
          (loaded) => {
            // Nobody may be listening (the export page was closed); that is fine.
            send('ui', 'list:progress', { platform, loaded }).catch(() => undefined);
          },
          () => stopped,
          known ? new Map(known) : undefined,
        ),
      );
    },
    'conversations:list-stop': () => {
      stopped = true;
      return null;
    },
    'conversation:file-link': ({
      conversationId,
      attachmentId,
    }: {
      conversationId: string;
      attachmentId: string;
    }) =>
      coded(async () => ({
        url: adapter.fileLink ? await adapter.fileLink(conversationId, attachmentId) : null,
      })),
  };
}
