import { ClaudeAdapter } from '../adapters/claude/adapter';
import { CodedError } from '../shared/errors';
import { handle } from '../shared/messages';
import { coded, isAlive, listHandlers } from './common';
import { showPanel } from './panel';

/**
 * Content script for claude.ai. Runs the adapter in the page's origin, so API
 * requests carry the user's session cookies.
 *
 * The service worker injects this script again when a tab does not answer, for
 * example after the extension was reloaded. A previous copy may still be in the
 * page with a dead extension context, so the guard asks it whether it is alive
 * instead of trusting a plain flag.
 */
declare global {
  interface Window {
    __aiChatExporterClaudeAlive?: () => boolean;
  }
}

if (!window.__aiChatExporterClaudeAlive?.()) {
  window.__aiChatExporterClaudeAlive = isAlive;
  const adapter = new ClaudeAdapter(
    (input, init) => fetch(input, init),
    () => location.href,
    location.origin,
  );

  handle('content', {
    ping: () => ({ platform: 'claude' as const }),
    'conversation:current-id': () => ({ id: adapter.getCurrentConversationId() }),
    'conversation:get': ({ id, options }) => coded(() => adapter.getConversation(id, options)),
    ...listHandlers('claude', adapter),
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
