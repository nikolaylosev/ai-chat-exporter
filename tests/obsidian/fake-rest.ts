import type { FetchLike } from '../../src/util/http';

export const KEY = 'test-key';
export const BASE = 'https://127.0.0.1:27124';

/**
 * A fake Local REST API plugin: files in memory, the key checked, the vault's
 * `.obsidian` refused unless `openConfig`, and requests recorded.
 */
export function fakeRest({
  files = {},
  openConfig = false,
  offline = false,
}: { files?: Record<string, string>; openConfig?: boolean; offline?: boolean } = {}) {
  const vault = new Map<string, Blob>(
    Object.entries(files).map(([path, text]) => [
      path,
      new Blob([text], { type: 'text/markdown' }),
    ]),
  );
  const requests: string[] = [];
  const opened: string[] = [];
  const answer = (input: string, init?: RequestInit): Response => {
    if (offline) throw new TypeError('Failed to fetch');
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${decodeURIComponent(url.pathname)}`);
    const auth = new Headers(init?.headers).get('authorization');
    if (url.pathname === '/') {
      return Response.json({ status: 'OK', authenticated: auth === `Bearer ${KEY}` });
    }
    if (auth !== `Bearer ${KEY}`) return Response.json({ errorCode: 40101 }, { status: 401 });
    const open = /^\/open\/(.+)$/.exec(url.pathname);
    if (open?.[1] && method === 'POST') {
      opened.push(open[1].split('/').map(decodeURIComponent).join('/'));
      return new Response(null, { status: 200 });
    }
    const m = /^\/vault\/(.+)$/.exec(url.pathname);
    if (!m?.[1]) return new Response('not found', { status: 404 });
    const path = m[1].split('/').map(decodeURIComponent).join('/');
    if (path.startsWith('.obsidian/') && !openConfig) {
      return Response.json({ errorCode: 40301 }, { status: 403 });
    }
    if (method === 'PUT') {
      const body = init?.body;
      vault.set(
        path,
        body instanceof Blob ? body : new Blob([typeof body === 'string' ? body : '']),
      );
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      return vault.delete(path)
        ? new Response(null, { status: 204 })
        : Response.json({ errorCode: 40400 }, { status: 404 });
    }
    const file = vault.get(path);
    return file ? new Response(file) : Response.json({ errorCode: 40400 }, { status: 404 });
  };
  const fetchFn: FetchLike = (input, init) => {
    try {
      return Promise.resolve(answer(input, init));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { fetchFn, vault, requests, opened, text: (path: string) => vault.get(path)?.text() };
}
