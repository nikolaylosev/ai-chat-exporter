import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '../../../src/util/http';

export const ORIGIN = 'https://grok.com';
const DIR = join(import.meta.dirname, '../../fixtures/grok');

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), 'utf8')) as unknown;
}

interface ConversationFixture {
  meta: { conversation: { conversationId: string } };
  nodes: unknown;
  responses: { responses: { responseId: string }[] };
}

/** Conversation fixtures by their (fake) id. */
export function loadConversations(...names: string[]): Record<string, ConversationFixture> {
  const out: Record<string, ConversationFixture> = {};
  for (const name of names) {
    const c = fixture(`${name}.json`) as ConversationFixture;
    out[c.meta.conversation.conversationId] = c;
  }
  return out;
}

/** The page after `conversations-list.json`: one more chat, a repeat, no token. */
const SECOND_LIST_PAGE = {
  conversations: [
    {
      conversationId: '00000000-0000-4000-8000-0000000000ff',
      title: 'Older chat',
      createTime: '2026-10-01T10:00:00.000Z',
      modifyTime: '2026-10-02T10:00:00.000Z',
      workspaces: [],
    },
    (fixture('conversations-list.json') as { conversations: unknown[] }).conversations[0],
  ],
  nextPageToken: null,
};

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export const WORKSPACE = '00000000-0000-4000-8000-0000000000c0';

/** A fake grok.com answering the REST calls of docs/platforms-grok.md from fixtures. */
export function grokServer(
  conversations: Record<string, ConversationFixture>,
  { workspaces = true }: { workspaces?: boolean } = {},
) {
  const calls: Call[] = [];
  const json = (value: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(value), { status }));
  const fetchFn: FetchLike = (url, init) => {
    const u = new URL(url);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method: init?.method ?? 'GET', path: u.pathname + u.search, body });
    const path = u.pathname;
    if (path === '/rest/workspaces') {
      return workspaces ? json(fixture('workspaces.json')) : json({ error: 'gone' }, 404);
    }
    if (path === `/rest/workspaces/${WORKSPACE}`) return json(fixture('workspace.json'));
    if (path.startsWith('/rest/workspaces/')) return json({ error: 'not found' }, 404);
    if (path === '/rest/assets') {
      return json(
        u.searchParams.get('workspaceId') === WORKSPACE
          ? fixture('workspace-assets.json')
          : { assets: [] },
      );
    }
    if (path === '/rest/app-chat/conversations' && u.searchParams.has('workspaceId')) {
      return json(
        u.searchParams.get('workspaceId') === WORKSPACE
          ? fixture('workspace-chats.json')
          : { conversations: [] },
      );
    }
    if (path === '/rest/app-chat/conversations') {
      return json(
        u.searchParams.get('pageToken') === 'NEXT_PAGE_TOKEN'
          ? SECOND_LIST_PAGE
          : fixture('conversations-list.json'),
      );
    }
    let m = /^\/rest\/app-chat\/conversations_v2\/([^/]+)$/.exec(path);
    if (m?.[1]) {
      const c = conversations[m[1]];
      return c ? json(c.meta) : json({ error: 'not found' }, 404);
    }
    m = /^\/rest\/app-chat\/conversations\/([^/]+)\/(response-node|load-responses)$/.exec(path);
    if (m?.[1]) {
      const c = conversations[m[1]];
      if (!c) return json({ error: 'not found' }, 404);
      if (m[2] === 'response-node') return json(c.nodes);
      const ids = new Set((body as { responseIds: string[] }).responseIds);
      return json({ responses: c.responses.responses.filter((r) => ids.has(r.responseId)) });
    }
    return json({ error: 'unknown' }, 404);
  };
  return { fetchFn, calls };
}
