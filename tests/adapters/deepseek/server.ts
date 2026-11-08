import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '../../../src/util/http';

export const ORIGIN = 'https://chat.deepseek.com';
export const FILES = 'https://files.deepseeksvc.com';
export const TOKEN = 'test-token';
const DIR = join(import.meta.dirname, '../../fixtures/deepseek');

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), 'utf8')) as unknown;
}

interface Session {
  id: string;
  pinned: boolean;
  updated_at: number;
}

/** `{ code, msg, data: { biz_code, biz_msg, biz_data } }`, as every answer is wrapped. */
export const envelope = (bizData: unknown, bizCode = 0, bizMsg = '', code = 0, msg = '') => ({
  code,
  msg,
  data: code === 0 ? { biz_code: bizCode, biz_msg: bizMsg, biz_data: bizData } : null,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

export interface ServerOptions {
  /** The chat list; the fixture's when not given. */
  sessions?: Session[];
  /** Answers with `code` 40029 this many times before answering. */
  rateLimited?: number;
  /** Signed paths `fetch_files` gives, by file id. */
  freshPaths?: Record<string, { signed_path: string; is_image: boolean }>;
}

/** A fake chat.deepseek.com: the list with its cursor, chats from fixtures, fetch_files. */
export function deepseekServer(options: ServerOptions = {}) {
  const histories = new Map<string, unknown>();
  for (const name of ['search-think', 'image-upload', 'text-upload', 'edited', 'old-upload']) {
    const h = fixture(`history-${name}.json`) as {
      data: { biz_data: { chat_session: { id: string } } };
    };
    histories.set(h.data.biz_data.chat_session.id, h);
  }
  const listed = (
    fixture('chat-sessions.json') as {
      data: { biz_data: { chat_sessions: Session[] } };
    }
  ).data.biz_data.chat_sessions;
  const sessions = options.sessions ?? listed;
  let limited = options.rateLimited ?? 0;
  const requests: string[] = [];

  const fetchFn: FetchLike = (input, init) => {
    const url = new URL(input);
    requests.push(`${url.pathname}${url.search}`);
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${TOKEN}`)
      return Promise.resolve(json(envelope(null, 0, '', 40003, 'INVALID_TOKEN')));
    if (limited > 0) {
      limited--;
      return Promise.resolve(json(envelope(null, 0, '', 40029, 'RATE_LIMITED')));
    }
    if (url.pathname === '/api/v0/chat_session/fetch_page') {
      const count = Number(url.searchParams.get('count'));
      if (!(count > 1 && count <= 100))
        return Promise.resolve(json(envelope(null, 1, 'illegal count')));
      const pinned = url.searchParams.get('lte_cursor.pinned') === 'true';
      const at = url.searchParams.get('lte_cursor.updated_at');
      // Pinned first, then newest first; the cursor is inclusive.
      const ordered = [...sessions].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at,
      );
      const from =
        at === null
          ? ordered
          : ordered.filter(
              (s) =>
                Number(s.pinned) < Number(pinned) ||
                (s.pinned === pinned && s.updated_at <= Number(at)),
            );
      const page = from.slice(0, count);
      return Promise.resolve(
        json(envelope({ chat_sessions: page, has_more: from.length > page.length })),
      );
    }
    if (url.pathname === '/api/v0/chat/history_messages') {
      const h = histories.get(url.searchParams.get('chat_session_id') ?? '');
      return Promise.resolve(json(h ?? envelope(null, 1, 'invalid chat session id')));
    }
    if (url.pathname === '/api/v0/file/fetch_files') {
      const files = url.searchParams
        .getAll('file_ids')
        .map((id) => ({ id, file_name: 'x', ...options.freshPaths?.[id] }))
        .filter((f) => 'signed_path' in f);
      return Promise.resolve(json(envelope({ files })));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
  return { fetchFn, requests };
}
