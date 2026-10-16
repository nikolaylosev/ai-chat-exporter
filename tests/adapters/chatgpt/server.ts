import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '../../../src/util/http';

export const ORIGIN = 'https://chatgpt.com';
export const TOKEN = 'test-access-token';
const DIR = join(import.meta.dirname, '../../fixtures/chatgpt');

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), 'utf8')) as unknown;
}

/** Conversation fixtures by their (fake) id. */
export function loadConversations(...names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const c = fixture(`${name}.json`) as { conversation_id: string };
    out[c.conversation_id] = c;
  }
  return out;
}

export interface ServerOptions {
  /** The session has no token: a signed-out user. */
  signedOut?: boolean;
  /** List items to serve instead of `conversations-list.json`. */
  listItems?: unknown[];
  /** File ids ChatGPT no longer has. */
  missingFiles?: string[];
  /** The first request with the token answers 401, as for an expired one. */
  expireTokenOnce?: boolean;
  /** Archived chats (`is_archived=true`); none by default. */
  archivedItems?: unknown[];
  /** Sidebar entries, one page each, and each project's chats, one page each. */
  sidebarPages?: unknown[][];
  projectChats?: Record<string, unknown[][]>;
  /** Project details (`gizmos/{id}`) by id; any other id answers 404. */
  projects?: Record<string, unknown>;
  /** The sidebar answers with something unreadable. */
  sidebarBroken?: boolean;
  /** How many API requests answer 429 before the rest pass; Infinity for all. */
  rateLimited?: number;
  /** File links always answer 429. */
  fileLinksRateLimited?: boolean;
}

/**
 * A fake chatgpt.com answering the requests of docs/platforms-chatgpt.md from
 * fixtures. Like the real one, the list without a token is empty, not an error.
 */
export function chatgptServer(conversations: Record<string, unknown>, opts: ServerOptions = {}) {
  const calls: { path: string; auth: string | null }[] = [];
  let expire = opts.expireTokenOnce ?? false;
  let limited = opts.rateLimited;
  const json = (value: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(value), { status }));
  const fetchFn: FetchLike = (url, init) => {
    const u = new URL(url);
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ path: u.pathname + u.search, auth });
    if (u.pathname === '/api/auth/session') {
      return json(opts.signedOut ? {} : { accessToken: TOKEN, user: { id: 'user-x' } });
    }
    const authorized = auth === `Bearer ${TOKEN}`;
    if (authorized && (limited ?? 0) > 0) {
      limited = (limited ?? 0) - 1;
      return json({ detail: 'Too many requests' }, 429);
    }
    if (authorized && expire) {
      expire = false;
      return json({ detail: 'expired' }, 401);
    }
    if (u.pathname === '/backend-api/conversations') {
      if (!authorized) return json({ items: [], total: 0, limit: 28, offset: 0 });
      const all =
        u.searchParams.get('is_archived') === 'true'
          ? (opts.archivedItems ?? [])
          : (opts.listItems ?? (fixture('conversations-list.json') as { items: unknown[] }).items);
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 28);
      if (limit > 100) return json({ detail: 'limit' }, 422);
      return json({
        items: all.slice(offset, offset + limit),
        total: offset + limit + 1,
        limit,
        offset,
      });
    }
    if (!authorized) return json({ detail: 'Unauthorized' }, 401);
    if (u.pathname === '/backend-api/gizmos/snorlax/sidebar') {
      if (opts.sidebarBroken) return json({ items: 'nope' });
      const pages = opts.sidebarPages ?? [[]];
      const page = Number(u.searchParams.get('cursor') ?? 0);
      return json({ items: pages[page] ?? [], cursor: page + 1 < pages.length ? page + 1 : null });
    }
    let m = /^\/backend-api\/gizmos\/(g-[^/]+)$/.exec(u.pathname);
    if (m?.[1]) {
      const project = opts.projects?.[m[1]];
      return project ? json(project) : json({ detail: 'Not found' }, 404);
    }
    m = /^\/backend-api\/gizmos\/([^/]+)\/conversations$/.exec(u.pathname);
    if (m?.[1]) {
      const pages = opts.projectChats?.[m[1]] ?? [[]];
      const page = Number(u.searchParams.get('cursor') ?? 0);
      return json({
        items: pages[page] ?? [],
        cursor: page + 1 < pages.length ? String(page + 1) : null,
      });
    }
    m = /^\/backend-api\/conversation\/([^/]+)$/.exec(u.pathname);
    if (m?.[1]) {
      const c = conversations[m[1]];
      return c ? json(c) : json({ detail: 'Not found' }, 404);
    }
    m = /^\/backend-api\/files\/download\/([^/]+)$/.exec(u.pathname);
    if (m?.[1] && opts.fileLinksRateLimited) return json({ detail: 'Too many requests' }, 429);
    if (m?.[1]) {
      if (opts.missingFiles?.includes(m[1])) {
        return json({ status: 'error', error_code: 'file_not_found' });
      }
      return json({
        status: 'success',
        download_url: `${ORIGIN}/backend-api/estuary/content?id=${m[1]}&sig=s`,
      });
    }
    m = /^\/backend-api\/conversation\/([^/]+)\/interpreter\/download$/.exec(u.pathname);
    if (m?.[1]) {
      const path = u.searchParams.get('sandbox_path');
      return path === '/mnt/data/fruits.csv'
        ? json({
            status: 'success',
            download_url: `/backend-api/estuary/content?id=sandbox&msg=${u.searchParams.get('message_id')}`,
          })
        : json({ status: 'error', error_code: 'file_not_found' });
    }
    return json({ detail: 'unknown' }, 404);
  };
  return { fetchFn, calls };
}
