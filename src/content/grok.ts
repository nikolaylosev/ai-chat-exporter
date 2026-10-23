import { GrokAdapter } from '../adapters/grok/adapter';
import { CodedError } from '../shared/errors';
import { handle } from '../shared/messages';
import { coded, isAlive, listHandlers } from './common';
import { mountPageButton } from './page-button';
import { showPanel } from './panel';

/**
 * Content script for grok.com. Runs the adapter in the page's origin, so REST
 * requests carry the user's session cookies. The same guard as on claude.ai
 * keeps a stale copy from answering after the extension was reloaded.
 */
declare global {
  interface Window {
    __aiChatExporterGrokAlive?: () => boolean;
  }
}

if (!window.__aiChatExporterGrokAlive?.()) {
  window.__aiChatExporterGrokAlive = isAlive;
  const adapter = new GrokAdapter(
    (input, init) => fetch(input, init),
    () => location.href,
    location.origin,
  );

  handle('content', {
    ping: () => ({ platform: 'grok' as const }),
    'conversation:current-id': () => ({ id: adapter.getCurrentConversationId() }),
    'conversation:get': ({ id }) => coded(() => adapter.getConversation(id)),
    ...listHandlers('grok', adapter),
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
  mountPageButton(() => adapter.getCurrentConversationId() !== null);
}
