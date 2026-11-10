import { describe, expect, it } from 'vitest';
import { ObsidianRest, originPattern } from '../../src/obsidian/rest';
import { BASE, KEY, fakeRest } from './fake-rest';

describe('ObsidianRest', () => {
  it('writes, reads and deletes files, each path segment encoded', async () => {
    const fake = fakeRest();
    const rest = new ObsidianRest(`${BASE}/`, KEY, fake.fetchFn);
    await rest.write(
      'AI Chats/Claude/C# tips/note.md',
      new Blob(['# Hi'], { type: 'text/markdown' }),
    );
    expect(fake.requests).toEqual(['PUT /vault/AI Chats/Claude/C# tips/note.md']);
    expect(await rest.readText('AI Chats/Claude/C# tips/note.md')).toBe('# Hi');
    expect(await rest.readText('missing.md')).toBeNull();
    await rest.remove('AI Chats/Claude/C# tips/note.md');
    await rest.remove('missing.md');
    expect(fake.vault.size).toBe(0);
  });

  it('reads the vault settings only when the plugin allows it', async () => {
    const config = { '.obsidian/app.json': '{"useMarkdownLinks":true}' };
    expect(
      await new ObsidianRest(BASE, KEY, fakeRest({ files: config }).fetchFn).readConfig(),
    ).toBeNull();
    const open = fakeRest({ files: config, openConfig: true });
    expect(await new ObsidianRest(BASE, KEY, open.fetchFn).readConfig()).toBe(
      '{"useMarkdownLinks":true}',
    );
  });

  it('says when Obsidian does not answer and when the key is wrong', async () => {
    const offline = new ObsidianRest(BASE, KEY, fakeRest({ offline: true }).fetchFn);
    await expect(offline.check()).rejects.toMatchObject({ code: 'obsidian-offline' });
    const wrong = new ObsidianRest(BASE, 'nope', fakeRest().fetchFn);
    await expect(wrong.check()).rejects.toMatchObject({ code: 'obsidian-key' });
    await expect(wrong.write('a.md', new Blob(['x']))).rejects.toMatchObject({
      code: 'obsidian-key',
    });
    await expect(new ObsidianRest(BASE, KEY, fakeRest().fetchFn).check()).resolves.toBeUndefined();
  });

  it('opens a note in Obsidian', async () => {
    const fake = fakeRest();
    await new ObsidianRest(BASE, KEY, fake.fetchFn).open('AI Chats/Claude/Chat/Chat.md');
    expect(fake.opened).toEqual(['AI Chats/Claude/Chat/Chat.md']);
  });
});

describe('originPattern', () => {
  it('is the address without its port', () => {
    expect(originPattern('https://127.0.0.1:27124')).toBe('https://127.0.0.1/*');
    expect(originPattern(' http://localhost:27123/ ')).toBe('http://localhost/*');
    expect(originPattern('obsidian://x')).toBeNull();
    expect(originPattern('nonsense')).toBeNull();
  });
});

describe('a chat written through the plugin', () => {
  it('puts its files and note in the vault and keeps what the user added', async () => {
    const { writeConversation } = await import('../../src/background/write-conversation');
    const { ObsidianRestSink } = await import('../../src/sinks/obsidian-rest-sink');
    const { parseVaultRules } = await import('../../src/obsidian/vault');
    const { DEFAULT_SETTINGS } = await import('../../src/shared/settings');
    const { LABELS } = await import('../render/labels');
    const fake = fakeRest();
    const fetchFn = (input: string, init?: RequestInit) =>
      input.startsWith(BASE)
        ? fake.fetchFn(input, init)
        : Promise.resolve(new Response('PNG', { headers: { 'content-type': 'image/png' } }));
    const rest = new ObsidianRest(BASE, KEY, fetchFn);
    const settings = {
      ...DEFAULT_SETTINGS,
      destination: 'obsidian' as const,
      onFolderExists: 'overwrite' as const,
    };
    const ctx = {
      now: new Date('2026-11-10T12:00:00Z'),
      labels: LABELS,
      timeZone: 'UTC',
      describeFailure: String,
      vault: parseVaultRules('', '{"attachmentFolderPath":"Attachments"}'),
    };
    const chat = {
      id: 'c1',
      platform: 'claude' as const,
      title: 'Chart',
      createdAt: '2026-11-09T09:00:00Z',
      updatedAt: null,
      url: 'https://claude.ai/chat/c1',
      messages: [
        {
          id: 'm1',
          role: 'user' as const,
          createdAt: null,
          blocks: [{ type: 'text' as const, markdown: 'Hi' }],
          attachments: [
            {
              id: 'a',
              name: 'chart.png',
              origin: 'user-upload' as const,
              source: { kind: 'url' as const, url: 'https://claude.ai/files/a' },
            },
          ],
        },
      ],
      branches: [],
    };
    const first = await writeConversation(
      chat,
      settings,
      ctx,
      () => new ObsidianRestSink(rest, fetchFn),
    );
    const note = 'AI Chats/Claude/Chart - 2026-11-09 (Claude)/Chart - 2026-11-09 (Claude).md';
    expect(first.location).toEqual({ kind: 'obsidian', path: note });
    expect(await fake.text('Attachments/Chart - 2026-11-09 (Claude)/chart.png')).toBe('PNG');
    const text = (await fake.text(note)) ?? '';
    expect(text).toContain('![[Attachments/Chart - 2026-11-09 (Claude)/chart.png]]');

    fake.vault.set(note, new Blob([text.replace('\n---\n', '\nstatus: read\n---\n') + 'Mine.\n']));
    await writeConversation(chat, settings, ctx, () => new ObsidianRestSink(rest, fetchFn));
    const again = (await fake.text(note)) ?? '';
    expect(again).toMatch(/\nstatus: read\n---\n/);
    expect(again).toMatch(/%%\nMine\.\n$/);
  });
});
