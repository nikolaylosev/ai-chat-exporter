import { DeepseekAdapter } from '../adapters/deepseek/adapter';
import { CodedError } from '../shared/errors';
import { handle } from '../shared/messages';
import { coded, isAlive, listHandlers } from './common';
import { mountPageButton } from './page-button';
import { showPanel } from './panel';

/**
 * Content script for chat.deepseek.com. Runs the adapter in the page's origin:
 * the API wants the token the web app keeps in localStorage (`userToken`), which a
 * content script can read. It is read for each request and never stored or sent
 * anywhere else. The same guard as on claude.ai keeps a stale copy from answering
 * after the extension was reloaded.
 */
declare global {
  interface Window {
    __aiChatExporterDeepseekAlive?: () => boolean;
  }
}

/** The web app's token: `{"value":"…","__version":"0"}` in `userToken`. */
function pageToken(): string | null {
  try {
    const raw = localStorage.getItem('userToken');
    if (!raw) return null;
    const value: unknown = (JSON.parse(raw) as { value?: unknown }).value;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

if (!window.__aiChatExporterDeepseekAlive?.()) {
  window.__aiChatExporterDeepseekAlive = isAlive;
  const adapter = new DeepseekAdapter(
    (input, init) => fetch(input, init),
    () => location.href,
    pageToken,
    location.origin,
  );

  handle('content', {
    ping: () => ({ platform: 'deepseek' as const }),
    'conversation:current-id': () => ({ id: adapter.getCurrentConversationId() }),
    'conversation:get': ({ id }) => coded(() => adapter.getConversation(id)),
    ...listHandlers('deepseek', adapter),
    // Only Gemini needs search to reach chats its list does not return.
    'conversations:search': () => {
      throw new CodedError('platform-not-ready', 'No chat search on this platform');
    },
    'conversations:search-stop': () => null,
    'conversations:lookup': () => {
      throw new CodedError('platform-not-ready', 'No chat lookup on this platform');
    },
    'projects:list': () => {
      throw new CodedError('platform-not-ready', 'DeepSeek has no projects');
    },
    'project:get': () => {
      throw new CodedError('platform-not-ready', 'DeepSeek has no projects');
    },
    'project:current': () => null,
    'panel:show': (view) => {
      showPanel(view);
      return null;
    },
  });
  mountPageButton(() => adapter.getCurrentConversationId() !== null);
}
