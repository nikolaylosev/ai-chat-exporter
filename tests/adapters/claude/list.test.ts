import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import { ClaudeApi } from '../../../src/adapters/claude/api';
import type { FetchLike } from '../../../src/util/http';
import { fixtureJson, ORIGIN } from './fixtures';

const fixture = fixtureJson('conversations-list-v2.json') as {
  data: Record<string, unknown>[];
};

/** A list endpoint that serves `items` in pages, like chat_conversations_v2. */
function listServer(byOrg: Record<string, Record<string, unknown>[]>) {
  const calls: string[] = [];
  const fetchFn: FetchLike = (url) => {
    const path = url.replace(ORIGIN, '');
    calls.push(path);
    if (path === '/api/organizations') {
      return Promise.resolve(Response.json(Object.keys(byOrg).map((uuid) => ({ uuid }))));
    }
    const m = /organizations\/([^/]+)\/chat_conversations_v2\?limit=(\d+)&offset=(\d+)/.exec(path);
    if (!m) return Promise.resolve(new Response('{}', { status: 404 }));
    const items = byOrg[m[1]!] ?? [];
    const [limit, offset] = [Number(m[2]), Number(m[3])];
    return Promise.resolve(
      Response.json({
        data: items.slice(offset, offset + limit),
        has_more: offset + limit < items.length,
      }),
    );
  };
  return { fetchFn, calls };
}

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  uuid: `c${n}`,
  name: `Chat ${n}`,
  created_at: `2026-10-${String(n).padStart(2, '0')}T10:00:00Z`,
  updated_at: `2026-10-${String(n).padStart(2, '0')}T11:00:00Z`,
  project: null,
  ...extra,
});

describe('ClaudeAdapter.listConversations', () => {
  it('maps the recorded list, with project names', async () => {
    const { fetchFn } = listServer({ org: fixture.data });
    const list = (await new ClaudeAdapter(fetchFn, () => '', ORIGIN).listConversations())
      .conversations;
    expect(list).toHaveLength(fixture.data.length);
    expect(list[0]).toEqual({
      id: '00000000-0000-4000-8000-000000000032',
      platform: 'claude',
      title: 'Widget glossary definition',
      createdAt: '2026-10-13T09:22:11.915235Z',
      updatedAt: '2026-10-13T09:22:14.352641Z',
      url: `${ORIGIN}/chat/00000000-0000-4000-8000-000000000032`,
      project: expect.any(String) as string,
    });
    expect(list[1]).not.toHaveProperty('project');
  });

  it('reads every page of every organization and drops temporary chats', async () => {
    const team = Array.from({ length: 120 }, (_, i) => item(i + 1));
    const personal = [item(200), item(201, { is_temporary: true }), item(5)];
    const { fetchFn, calls } = listServer({ team, personal });
    const list = (await new ClaudeAdapter(fetchFn, () => '', ORIGIN).listConversations())
      .conversations;
    expect(list.map((c) => c.id)).toEqual([...team.map((c) => c.uuid), 'c200']);
    // Offsets 0, 45, 90 (pages overlap by 5), then the first page again.
    expect(calls.filter((c) => c.includes('team/'))).toHaveLength(4);
  });

  it('stops after the current page when asked, with what it read and the count so far', async () => {
    const team = Array.from({ length: 120 }, (_, i) => item(i + 1));
    const { fetchFn, calls } = listServer({ team });
    const loaded: number[] = [];
    const list = await new ClaudeAdapter(fetchFn, () => '', ORIGIN).listConversations(
      (n) => loaded.push(n),
      () => loaded.length > 0,
    );
    expect(list.conversations).toHaveLength(50);
    expect(list.incomplete).toEqual({ loaded: 50, stopped: true });
    expect(calls.filter((c) => c.includes('team/'))).toHaveLength(1);
  });

  it('keeps chats that move while the list is read', async () => {
    const team = Array.from({ length: 120 }, (_, i) => item(i + 1));
    const server = listServer({ team });
    let reads = 0;
    const fetchFn: FetchLike = (url, init) => {
      if (url.includes('team/chat_conversations_v2') && ++reads === 2) {
        // After the first page, chat 100 is updated: it goes to the top, the rest shift down.
        team.unshift(...team.splice(99, 1));
      }
      return server.fetchFn(url, init);
    };
    const list = (await new ClaudeAdapter(fetchFn, () => '', ORIGIN).listConversations())
      .conversations;
    expect(new Set(list.map((c) => c.id)).size).toBe(120);
    // The chat that moved up is found by reading the first page again, and listed first.
    expect(list[0]?.id).toBe('c100');
  });

  it('does not skip a chat when one already read is deleted meanwhile', async () => {
    const team = Array.from({ length: 120 }, (_, i) => item(i + 1));
    const server = listServer({ team });
    let reads = 0;
    const fetchFn: FetchLike = (url, init) => {
      // After the second page, chat 60 is deleted: the rest shift up by one, so chat
      // 101 moves onto the second page, already read.
      if (url.includes('team/chat_conversations_v2') && ++reads === 3) team.splice(59, 1);
      return server.fetchFn(url, init);
    };
    const list = (await new ClaudeAdapter(fetchFn, () => '', ORIGIN).listConversations())
      .conversations;
    expect(list.map((c) => c.id)).toContain('c101');
  });

  it('names the field when the list format changes', async () => {
    const { fetchFn } = listServer({ org: [{ name: 'no uuid' }] });
    await expect(new ClaudeAdapter(fetchFn, () => '', ORIGIN).listConversations()).rejects.toThrow(
      /uuid/,
    );
  });
});

describe('ClaudeApi.workspaceSessionId', () => {
  const team = Array.from({ length: 500 }, (_, i) =>
    item(i + 1, { workspace_session_id: `session_${i + 1}` }),
  );

  it('finds a recent chat in the first pages', async () => {
    const { fetchFn, calls } = listServer({ team });
    const api = new ClaudeApi(fetchFn, ORIGIN);
    expect(await api.workspaceSessionId('team', 'c120')).toBe('session_120');
    expect(calls.filter((c) => c.includes('team/'))).toHaveLength(3);
  });

  it('reads the whole list once for older chats, then answers from memory', async () => {
    const { fetchFn, calls } = listServer({ team });
    const api = new ClaudeApi(fetchFn, ORIGIN);
    expect(await api.workspaceSessionId('team', 'c450')).toBe('session_450');
    const after = calls.length;
    expect(await api.workspaceSessionId('team', 'c480')).toBe('session_480');
    expect(await api.workspaceSessionId('team', 'c5')).toBe('session_5');
    expect(calls).toHaveLength(after);
    expect(await api.workspaceSessionId('team', 'missing')).toBeNull();
  });
});
