import { ChatgptAdapter } from '../adapters/chatgpt/adapter';
import { CodedError } from '../shared/errors';
import { handle } from '../shared/messages';
import { coded, isAlive, listHandlers } from './common';
import { showPanel } from './panel';

/**
 * Content script for chatgpt.com. Runs the adapter in the page's origin, where it
 * can ask the session for its access token. The same guard as on claude.ai
 * keeps a stale copy from answering after the extension was reloaded.
 */
declare global {
  interface Window {
    __aiChatExporterChatgptAlive?: () => boolean;
  }
}

if (!window.__aiChatExporterChatgptAlive?.()) {
  window.__aiChatExporterChatgptAlive = isAlive;
  const adapter = new ChatgptAdapter(
    (input, init) => fetch(input, init),
    () => location.href,
    location.origin,
  );

  handle('content', {
    ping: () => ({ platform: 'chatgpt' as const }),
    'conversation:current-id': () => ({ id: adapter.getCurrentConversationId() }),
    'conversation:get': ({ id, options }) => coded(() => adapter.getConversation(id, options)),
    ...listHandlers('chatgpt', adapter),
    // Only Gemini needs search to reach chats its list does not return.
    'conversations:search': () => {
      throw new CodedError('platform-not-ready', 'No chat search on this platform');
    },
    'conversations:search-stop': () => null,
    'projects:list': () => coded(() => adapter.listProjects()),
    'project:get': ({ id }) => coded(() => adapter.getProject(id)),
    'project:current': () => coded(() => adapter.getCurrentProject()),
    'panel:show': (view) => {
      showPanel(view);
      return null;
    },
  });
}
