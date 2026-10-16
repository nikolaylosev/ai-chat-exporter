import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchLike } from '../../../src/util/http';

export const ORIGIN = 'https://gemini.google.com';
const DIR = join(import.meta.dirname, '../../fixtures/gemini');

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), 'utf8')) as unknown;
}

/** A batchexecute response body, as the web app receives it. */
export function batchBody(rpcId: string, payload: unknown): string {
  // `undefined`: an answer without data, as Gemini gives after the last list page.
  const data = payload === undefined ? null : JSON.stringify(payload);
  const line = JSON.stringify([['wrb.fr', rpcId, data, null, null, null, 'generic']]);
  return `)]}'\n\n${line.length}\n${line}\n25\n[["e",4,null,null,123]]\n`;
}

/**
 * The page after `conversations-list.json`: one more chat and a repeat of the first.
 * Its token leads to an answer without data, which ends the list.
 */
const SECOND_LIST_PAGE = [
  null,
  'LAST_PAGE_TOKEN',
  [
    ['c_00000000000000ff', 'Older chat', null, null, null, [1791000000, 0]],
    ['c_0000000000000001', 'Fruit List and Python Code', null, null, null, [1791923915, 615036000]],
  ],
];

export interface Call {
  rpcId: string;
  args: unknown;
  sourcePath: string | null;
  at: string | null;
}

/**
 * A fake gemini.google.com: `/app` with tokens, and batchexecute answering from
 * fixture files. `conversations` maps a 16-hex id to `{ history: [page…], meta }`.
 */
/** The notebook in the notebook fixtures. */
export const NOTEBOOK = 'notebooks/00000000-0000-4000-8000-0000000000b0';

export function geminiServer(conversations: Record<string, { history: unknown[]; meta: unknown }>) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/app')) {
      return Promise.resolve(
        new Response(
          '<script>WIZ_global_data = {"SNlM0e":"xsrf-token","cfb2h":"boq_test","FdrFJe":"-123"};</script>',
        ),
      );
    }
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const rpcId = u.searchParams.get('rpcids') ?? '';
    const request = JSON.parse(form.get('f.req') ?? '[[[]]]') as [[[string, string]]];
    const args = JSON.parse(request[0][0][1]) as unknown[];
    calls.push({ rpcId, args, sourcePath: u.searchParams.get('source-path'), at: form.get('at') });
    let payload: unknown = null;
    if (rpcId === 'hNvQHb') {
      const id = String(args[0]).replace(/^c_/, '');
      const pages = conversations[id]?.history ?? [];
      const index = args[2] ? pages.findIndex((p) => (p as unknown[])[1] === args[2]) + 1 : 0;
      payload = pages[index] ?? [[], null, null, []];
    } else if (rpcId === 'HcT8bb') {
      const known = fixture('notebook-get.json') as [[string]];
      payload = args[0] === known[0][0] ? known : null;
    } else if (rpcId === 'MaZiqc' && typeof (args[2] as unknown[])[3] === 'string') {
      // A notebook's chats.
      const notebook = (args[2] as unknown[])[3];
      payload = notebook === NOTEBOOK ? fixture('notebook-chats.json') : [null, null, []];
    } else if (rpcId === 'MaZiqc') {
      const filter = args[2] as unknown[];
      const id = typeof filter[5] === 'string' ? filter[5].replace(/^c_/, '') : null;
      payload = id
        ? (conversations[id]?.meta ?? [null, null, []])
        : args[1] === 'NEXT_PAGE_TOKEN'
          ? SECOND_LIST_PAGE
          : args[1] === 'LAST_PAGE_TOKEN'
            ? undefined
            : fixture('conversations-list.json');
    } else if (rpcId === 'CNgdBe') {
      // [2, ['en'], 0, null, [2]] asks for the user's notebooks.
      const notebooks = JSON.stringify(args[4]) === '[2]';
      payload = notebooks
        ? fixture('notebooks-list.json')
        : (args[0] as number) === 1
          ? fixture('gems-premade.json')
          : [null, null, []];
    }
    return Promise.resolve(new Response(batchBody(rpcId, payload)));
  };
  return { fetchFn, calls };
}

/** Conversation fixtures by their (fake) 16-hex id. */
export function loadConversations(...names: string[]) {
  const out: Record<string, { history: unknown[]; meta: unknown }> = {};
  for (const name of names) {
    const c = fixture(`${name}.json`) as { history: unknown[]; meta: unknown[] };
    const id = String((c.meta as unknown[][][])[2]?.[0]?.[0]).replace(/^c_/, '');
    out[id] = c;
  }
  return out;
}
