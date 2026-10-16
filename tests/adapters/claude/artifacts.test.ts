import { describe, expect, it } from 'vitest';
import {
  artifactFileName,
  findArtifactPublications,
  isTextContentType,
  selectPublications,
  slugify,
} from '../../../src/adapters/claude/artifacts';
import { activePath } from '../../../src/adapters/claude/normalize';
import { parseMessage, type RawMessage } from '../../../src/adapters/claude/schema';
import { rawConversation } from './fixtures';

const URL_1 = 'https://claude.ai/artifact/AAAAAAAAAAAAAAAAAAAAA1';

describe('findArtifactPublications: session chat fixture', () => {
  const raw = rawConversation('conversation-artifact.json');
  const publications = findArtifactPublications(activePath(raw));

  it('finds both versions with link and version id', () => {
    expect(publications.map((p) => [p.url, p.versionId])).toEqual([
      [URL_1, '1791882876-61ba'],
      [URL_1, '1791882915-2e7b'],
    ]);
    expect(publications[0]?.filePath).toMatch(/exporter-test\.html$/);
  });

  it('rebuilds each version from Write and Edit', () => {
    expect(publications[0]?.content).toContain('<h1>Exporter test</h1>');
    expect(publications[1]?.content).toContain('<h1>Exporter test v2</h1>');
    expect(publications[1]?.content).not.toContain('<h1>Exporter test</h1>');
  });

  it('points each version at the message that published it', () => {
    const assistants = activePath(raw).filter((m) => m.sender === 'assistant');
    expect(publications.map((p) => p.messageId)).toEqual(assistants.map((m) => m.uuid));
  });
});

function message(uuid: string, content: unknown[]): RawMessage {
  return parseMessage({
    uuid,
    parent_message_uuid: 'root',
    sender: 'assistant',
    index: 0,
    created_at: '2026-05-01T10:00:00Z',
    content,
  });
}

const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const result = (id: string, text: string, isError = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  name: 'Artifact',
  is_error: isError,
  content: [{ type: 'text', text }],
});

describe('findArtifactPublications: older chats', () => {
  it('replays create_file and str_replace', () => {
    const messages = [
      message('m1', [
        use('1', 'create_file', {
          path: '/mnt/out/app.jsx',
          file_text: 'const a = 1;\nconst b = 2;',
        }),
        use('2', 'str_replace', { path: '/mnt/out/app.jsx', old_str: 'b = 2', new_str: 'b = 3' }),
        use('3', 'Artifact', { file_path: '/mnt/out/app.jsx' }),
        result(
          '3',
          `Published /mnt/out/app.jsx at https://claude.ai/artifact/Xy_9 (Version 1, version id 17-ab)`,
        ),
      ]),
    ];
    expect(findArtifactPublications(messages)).toEqual([
      {
        messageId: 'm1',
        filePath: '/mnt/out/app.jsx',
        url: 'https://claude.ai/artifact/Xy_9',
        versionId: '17-ab',
        content: 'const a = 1;\nconst b = 3;',
      },
    ]);
  });

  it('gives up on content when an edit does not apply, and skips failed publications', () => {
    const messages = [
      message('m1', [
        use('1', 'Write', { file_path: '/f.html', content: '<p>a</p>' }),
        use('2', 'Edit', { file_path: '/f.html', old_string: '<p>zzz</p>', new_string: '' }),
        use('3', 'Artifact', { file_path: '/f.html' }),
        result('3', 'Published /f.html'),
        use('4', 'Artifact', { file_path: '/f.html' }),
        result('4', 'Error: quota', true),
      ]),
    ];
    expect(findArtifactPublications(messages)).toEqual([
      { messageId: 'm1', filePath: '/f.html', url: null, versionId: null, content: null },
    ]);
  });

  it('honours replace_all', () => {
    const messages = [
      message('m1', [
        use('1', 'Write', { file_path: '/x.md', content: 'a a a' }),
        use('2', 'Edit', {
          file_path: '/x.md',
          old_string: 'a',
          new_string: 'b',
          replace_all: true,
        }),
        use('3', 'Artifact', { file_path: '/x.md' }),
        result('3', 'ok'),
      ]),
    ];
    expect(findArtifactPublications(messages)[0]?.content).toBe('b b b');
  });
});

describe('selectPublications', () => {
  const p = (url: string | null, filePath: string, versionId: string) => ({
    messageId: versionId,
    filePath,
    url,
    versionId,
    content: null,
  });
  const all = [p('u1', '/a', 'v1'), p('u2', '/b', 'v1b'), p('u1', '/a', 'v2'), p(null, '/c', 'x')];

  it('keeps the newest publication of each artifact', () => {
    expect(selectPublications(all, 'latest').map((x) => x.versionId)).toEqual(['v2', 'v1b', 'x']);
  });

  it('keeps everything for all versions', () => {
    expect(selectPublications(all, 'all')).toHaveLength(4);
  });
});

describe('naming', () => {
  it.each([
    ['Exporter Test', 'exporter-test'],
    ['Лендинг: продукт №1', 'лендинг-продукт-1'],
    ['   ', 'artifact'],
    ['a'.repeat(80), 'a'.repeat(60)],
  ])('slugify(%j) → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it.each([
    [
      {
        title: 'Exporter Test',
        sandboxPath: '/s/x.html',
        filePath: 'index.html',
        isMainFile: true,
        version: null,
      },
      'artifact-exporter-test.html',
    ],
    [
      {
        title: 'Exporter Test',
        sandboxPath: '/s/x.html',
        filePath: 'index.html',
        isMainFile: true,
        version: 2,
      },
      'artifact-exporter-test-v2.html',
    ],
    [
      {
        title: 'App',
        sandboxPath: '/s/app.jsx',
        filePath: 'assets/logo.png',
        isMainFile: false,
        version: null,
      },
      'artifact-app-assets-logo.png',
    ],
    [
      {
        title: null,
        sandboxPath: '/mnt/out/landing-page.html',
        filePath: null,
        isMainFile: true,
        version: null,
      },
      'artifact-landing-page.html',
    ],
    [
      {
        title: 'Chart',
        sandboxPath: '/s/chart.svg',
        filePath: 'index',
        isMainFile: true,
        version: null,
      },
      'artifact-chart.svg',
    ],
  ])('artifactFileName %#', (args, expected) => {
    expect(artifactFileName(args)).toBe(expected);
  });

  it.each([
    ['text/html', true],
    ['image/svg+xml', true],
    ['application/json', true],
    ['text/javascript', true],
    [undefined, true],
    ['image/png', false],
    ['application/pdf', false],
  ])('isTextContentType(%s) → %s', (type, expected) => {
    expect(isTextContentType(type)).toBe(expected);
  });
});
