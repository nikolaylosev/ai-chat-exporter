import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import { projectIdFromUrl } from '../../../src/adapters/claude/urls';
import type { FetchLike } from '../../../src/util/http';
import { fixtureJson, ORG, ORIGIN } from './fixtures';

const PROJECT = '00000000-0000-4000-8000-000000000033';
const project = fixtureJson('project.json') as Record<string, unknown>;

/** A server for the recorded project fixtures; `routes` add or override answers. */
function projectServer(routes: [RegExp, unknown][] = []) {
  const calls: string[] = [];
  const all: [RegExp, unknown][] = [
    ...routes,
    [/\/api\/organizations$/, [{ uuid: ORG }]],
    [new RegExp(`/projects/${PROJECT}/docs$`), fixtureJson('project-docs.json')],
    [new RegExp(`/projects/${PROJECT}/files$`), fixtureJson('project-files.json')],
    [
      new RegExp(`/projects/${PROJECT}/conversations_v2`),
      fixtureJson('project-conversations.json'),
    ],
    [new RegExp(`/projects/${PROJECT}$`), project],
  ];
  const fetchFn: FetchLike = (url) => {
    const path = url.replace(ORIGIN, '');
    calls.push(path);
    const route = all.find(([pattern]) => pattern.test(path));
    return Promise.resolve(route ? Response.json(route[1]) : new Response('{}', { status: 404 }));
  };
  return { fetchFn, calls };
}

describe('ClaudeAdapter projects', () => {
  it('reads a project with instructions, knowledge base and chats', async () => {
    const { fetchFn } = projectServer();
    const result = await new ClaudeAdapter(fetchFn, () => '', ORIGIN).getProject(PROJECT);
    expect(result).toMatchObject({
      id: PROJECT,
      name: 'Exporter Test Project',
      description: 'Test project for AI Chat Exporter reconnaissance.',
      instructions: 'Exporter test instructions: always answer in one short sentence.',
      url: `${ORIGIN}/project/${PROJECT}`,
      knowledgeCount: 3,
    });
    expect(result.knowledge.map((k) => [k.name, k.source?.kind])).toEqual([
      ['project-glossary.md', 'text'],
      ['fruit-prices.pdf', 'url'],
      ['inventory.xlsx', 'url'],
    ]);
    expect(result.knowledge[0]?.source).toMatchObject({
      text: expect.stringContaining('# Glossary') as string,
    });
    expect(result.knowledge[1]?.source).toEqual({
      kind: 'url',
      url: `${ORIGIN}/api/organizations/${ORG}/files/00000000-0000-4000-8000-000000000037/contents`,
    });
    expect(result.conversations).toEqual([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000032',
        title: 'Widget glossary definition',
        project: 'Exporter Test Project',
      }),
    ]);
  });

  it('lists projects page by page', async () => {
    const page = (n: number, more: boolean) => ({
      data: Array.from({ length: n }, (_, i) => ({
        ...project,
        uuid: `p${more ? i : 100 + i}`,
        docs_count: 1,
        files_count: 2,
      })),
      pagination: { has_more: more },
    });
    const { fetchFn, calls } = projectServer([
      [/projects_v2\?limit=50&offset=0$/, page(50, true)],
      [/projects_v2\?limit=50&offset=50$/, page(3, false)],
    ]);
    const list = await new ClaudeAdapter(fetchFn, () => '', ORIGIN).listProjects();
    expect(list).toHaveLength(53);
    expect(list[0]).toMatchObject({ id: 'p0', name: 'Exporter Test Project', knowledgeCount: 3 });
    expect(calls.filter((c) => c.includes('projects_v2'))).toHaveLength(2);
  });

  it('finds the project of a project page and of a chat inside it', async () => {
    const chat = fixtureJson('conversation-in-project.json') as { uuid: string };
    const { fetchFn } = projectServer([[new RegExp(`/chat_conversations/${chat.uuid}`), chat]]);
    const onProject = new ClaudeAdapter(fetchFn, () => `${ORIGIN}/project/${PROJECT}`, ORIGIN);
    expect(await onProject.getCurrentProject()).toEqual({
      id: PROJECT,
      name: 'Exporter Test Project',
    });
    const inChat = new ClaudeAdapter(fetchFn, () => `${ORIGIN}/chat/${chat.uuid}`, ORIGIN);
    expect(await inChat.getCurrentProject()).toEqual({
      id: PROJECT,
      name: 'Exporter Test Project',
    });
    const elsewhere = new ClaudeAdapter(fetchFn, () => `${ORIGIN}/recents`, ORIGIN);
    expect(await elsewhere.getCurrentProject()).toBeNull();
  });
});

describe('projectIdFromUrl', () => {
  it.each([
    [`https://claude.ai/project/${PROJECT}`, PROJECT],
    [`https://claude.ai/project/${PROJECT.toUpperCase()}/settings`, PROJECT],
    ['https://claude.ai/projects', null],
    [`https://example.com/project/${PROJECT}`, null],
    [undefined, null],
  ])('%s → %s', (url, id) => {
    expect(projectIdFromUrl(url)).toBe(id);
  });
});
