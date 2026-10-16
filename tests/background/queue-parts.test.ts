import { describe, expect, it, vi } from 'vitest';

// queue.ts imports modules that touch chrome.* at call time only; stub the global for safety.
vi.stubGlobal('chrome', {});
const { partName, requeueLostPart } = await import('../../src/background/queue');
const { ZipArchive } = await import('../../src/sinks/offscreen-sinks');
import type { JobItem, JobState } from '../../src/shared/job';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { OffscreenFiles } from '../../src/sinks/offscreen-sinks';

const api = {
  openZip: () => Promise.resolve('z1'),
  addToZip: () => Promise.resolve({ ok: true, size: 10 }),
  discardZip: () => Promise.resolve(),
} as unknown as OffscreenFiles;

const item = (id: string, status: JobItem['status'], extra: Partial<JobItem> = {}): JobItem => ({
  id,
  title: id,
  updatedAt: null,
  status,
  ...extra,
});

describe('partName', () => {
  it.each([
    ['Claude - 2026-10-13 15-40.zip', 2, 'Claude - 2026-10-13 15-40 (part 2).zip'],
    ['Claude - 2026-10-13 15-40 (part 2).zip', 3, 'Claude - 2026-10-13 15-40 (part 3).zip'],
    ['P (Claude).zip', 2, 'P (Claude) (part 2).zip'],
  ])('%s → %s', (name, part, expected) => {
    expect(partName(name, part)).toBe(expected);
  });
});

describe('requeueLostPart', () => {
  it('puts everything of the lost part back, with a lost project and its chats', () => {
    const archive = new ZipArchive(api, { kind: 'folder', overwrite: false }, 'A.zip', {
      zipId: 'z1',
      name: 'A.zip',
      folders: ['saved', 'chat a', 'projects/p (claude)', 'projects/p (claude)/chats/c1'],
    });
    const job = {
      id: 'j',
      platform: 'claude',
      status: 'running',
      settings: DEFAULT_SETTINGS,
      startedAt: '2026-10-13T10:00:00Z',
      tab: {},
      items: [
        item('saved', 'done'),
        item('a', 'done', { path: 'Chat A/Chat A.md', savedFiles: 2 }),
        item('p', 'done', { kind: 'project', withChats: true }),
        item('c1', 'done', { projectId: 'p' }),
        item('c2', 'running', { projectId: 'p' }),
        item('later', 'pending'),
      ],
      projects: { p: { written: false } },
      archiveMembers: {
        '/a': ['chat a'],
        '/p': ['projects/p (claude)'],
        'p/c1': ['projects/p (claude)/chats/c1'],
      },
    } as unknown as JobState;

    requeueLostPart(job, job.items[4]!, archive);

    expect(job.items.map((i) => [i.id, i.status])).toEqual([
      ['saved', 'done'],
      ['a', 'pending'],
      ['p', 'pending'],
      ['later', 'pending'],
    ]);
    expect(job.items[1]).not.toHaveProperty('path');
    expect(job.projects).toEqual({});
    expect(job.archiveMembers).toEqual({});
    expect(archive.isOpen).toBe(false);
    // Only the folder of the saved part stays taken.
    expect(archive.snapshot().folders).toEqual(['saved']);
  });

  it('keeps a project from an earlier part and rewrites its note later', () => {
    const archive = new ZipArchive(api, { kind: 'folder', overwrite: false }, 'A.zip');
    const job = {
      items: [item('p', 'done', { kind: 'project' }), item('c1', 'done', { projectId: 'p' })],
      projects: { p: { written: true } },
      archiveMembers: { 'p/c1': [] },
    } as unknown as JobState;
    requeueLostPart(job, null, archive);
    expect(job.items.map((i) => i.status)).toEqual(['done', 'pending']);
    expect(job.projects?.p?.written).toBe(false);
  });
});

describe('ZipArchive bookkeeping', () => {
  it('reports size and the folders each conversation took', async () => {
    const archive = new ZipArchive(api, { kind: 'folder', overwrite: false }, 'A.zip');
    await archive.open();
    expect(archive.reserveFolder('Chat')).toBe('Chat');
    expect(archive.reserveFolder('Chat')).toBe('Chat (2)');
    await archive.add('Chat/Chat.md', { kind: 'text', text: '#', mime: 'text/markdown' });
    expect(archive.size).toBe(10);
    expect(archive.takeReserved()).toEqual(['chat', 'chat (2)']);
    expect(archive.takeReserved()).toEqual([]);
    archive.release(['chat (2)']);
    expect(archive.reserveFolder('Chat')).toBe('Chat (2)');
  });
});
