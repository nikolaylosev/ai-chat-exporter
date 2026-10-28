import { GeminiAdapter } from '../adapters/gemini/adapter';
import { handle, send } from '../shared/messages';
import { coded, isAlive, listHandlers } from './common';
import { mountPageButton } from './page-button';
import { showPanel } from './panel';

/**
 * Content script for gemini.google.com. Runs the adapter in the page's origin, so
 * `batchexecute` requests carry the user's session cookies. The same guard as on
 * claude.ai keeps a stale copy from answering after the extension was reloaded.
 */
declare global {
  interface Window {
    __aiChatExporterGeminiAlive?: () => boolean;
  }
}

if (!window.__aiChatExporterGeminiAlive?.()) {
  window.__aiChatExporterGeminiAlive = isAlive;
  let searchStopped = false;
  const adapter = new GeminiAdapter(
    (input, init) => fetch(input, init),
    () => location.href,
    location.origin,
  );

  handle('content', {
    ping: () => ({ platform: 'gemini' as const }),
    'conversation:current-id': () => ({ id: adapter.getCurrentConversationId() }),
    'conversation:get': ({ id }) => coded(() => adapter.getConversation(id)),
    ...listHandlers('gemini', adapter),
    'conversations:search': ({ knownIds, resume }) => {
      searchStopped = false;
      return coded(() =>
        adapter.searchConversations(new Set(knownIds), {
          ...(resume ? { resume } : {}),
          shouldStop: () => searchStopped,
          // Each query's new chats go to the page at once, so a stop or a failure keeps them.
          onProgress: ({ found, queries, conversations, state }) => {
            send('ui', 'search:progress', {
              platform: 'gemini',
              found,
              queries,
              conversations,
              ...(state ? { state } : {}),
            }).catch(() => undefined);
          },
          scriptUrls: () => [
            ...new Set([
              ...[...document.scripts].map((s) => s.src).filter(Boolean),
              ...performance
                .getEntriesByType('resource')
                .map((e) => e.name)
                .filter((u) => /\.js(\?|$)/.test(u)),
            ]),
          ],
        }),
      );
    },
    'conversations:search-stop': () => {
      searchStopped = true;
      return null;
    },
    // Gemini's notebooks are exported like Claude's projects; Gems are recorded on each chat.
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
