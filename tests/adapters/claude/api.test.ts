import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import { ClaudeApi } from '../../../src/adapters/claude/api';
import { PlatformFormatError } from '../../../src/adapters/claude/schema';
import { conversationIdFromUrl } from '../../../src/adapters/claude/urls';
import { HttpError, type FetchLike } from '../../../src/util/http';
import { fixtureJson, ORIGIN } from './fixtures';

type Route = [RegExp, number, unknown];

function fakeFetch(routes: Route[]) {
  const calls: string[] = [];
  const fetchFn: FetchLike = (url) => {
    calls.push(url.replace(ORIGIN, ''));
    const route = routes.find(([pattern]) => pattern.test(url));
    const [, status, body] = route ?? [/./, 404, { error: 'not found' }];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetchFn, calls };
}

const conversation = fixtureJson('conversation-in-project.json') as {
  uuid: string;
  project_uuid: string;
};
const project = fixtureJson('project.json');

describe('ClaudeApi', () => {
  it('finds the organization that owns the conversation and remembers it', async () => {
    const { fetchFn, calls } = fakeFetch([
      [/\/api\/organizations$/, 200, [{ uuid: 'org-team' }, { uuid: 'org-personal' }]],
      [/org-team\/chat_conversations\//, 403, {}],
      [/org-personal\/chat_conversations\//, 200, conversation],
    ]);
    const api = new ClaudeApi(fetchFn, ORIGIN);

    expect((await api.conversation(conversation.uuid)).orgId).toBe('org-personal');
    calls.length = 0;
    await api.conversation(conversation.uuid);
    expect(calls).toEqual([
      `/api/organizations/org-personal/chat_conversations/${conversation.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`,
    ]);
  });

  it('reports a signed-out user from the organizations call', async () => {
    const { fetchFn } = fakeFetch([[/\/api\/organizations$/, 401, {}]]);
    const error = await new ClaudeApi(fetchFn, ORIGIN).conversation('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).isAuth).toBe(true);
  });

  it('throws the last 404 when no organization has the conversation', async () => {
    const { fetchFn } = fakeFetch([[/\/api\/organizations$/, 200, [{ uuid: 'a' }, { uuid: 'b' }]]]);
    await expect(new ClaudeApi(fetchFn, ORIGIN).conversation('x')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('names the field when the conversation format changes', async () => {
    const { fetchFn } = fakeFetch([
      [/\/api\/organizations$/, 200, [{ uuid: 'a' }]],
      [/chat_conversations\//, 200, { ...conversation, chat_messages: 'oops' }],
    ]);
    const error = await new ClaudeApi(fetchFn, ORIGIN).conversation('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformFormatError);
    expect((error as Error).message).toContain('conversation.chat_messages');
  });
});

describe('ClaudeAdapter', () => {
  it('adds the project name for chats inside a project', async () => {
    const { fetchFn } = fakeFetch([
      [/\/api\/organizations$/, 200, [{ uuid: 'a' }]],
      [/chat_conversations\//, 200, conversation],
      [new RegExp(`/projects/${conversation.project_uuid}$`), 200, project],
    ]);
    const adapter = new ClaudeAdapter(fetchFn, () => `${ORIGIN}/chat/${conversation.uuid}`);
    expect(adapter.getCurrentConversationId()).toBe(conversation.uuid);
    expect((await adapter.getConversation(conversation.uuid)).project).toBe(
      'Exporter Test Project',
    );
  });
});

describe('conversationIdFromUrl', () => {
  const id = '3f2a9c1e-0000-4000-8000-0000000000ab';
  it.each([
    [`https://claude.ai/chat/${id}`, id],
    [`https://claude.ai/chat/${id}?artifact=x`, id],
    [`https://claude.ai/chat/${id.toUpperCase()}`, id],
    [`https://claude.ai/chat/${id}/`, id],
    ['https://claude.ai/new', null],
    ['https://claude.ai/project/01900000-0000-7000-8000-000000000001', null],
    [`https://claude.ai/chat/${id}x`, null],
    [`https://evil.example/chat/${id}`, null],
    [undefined, null],
    ['not a url', null],
  ])('%s → %s', (url, expected) => {
    expect(conversationIdFromUrl(url)).toBe(expected);
  });
});
