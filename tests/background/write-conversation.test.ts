import { describe, expect, it } from 'vitest';
import { FileWriteError } from '../../src/sinks/source';
import { DownloadInterruptedError } from '../../src/background/downloader';
import { writeConversation, type WritableSink } from '../../src/background/write-conversation';
import type { Attachment, Conversation } from '../../src/model/conversation';
import { CodedError } from '../../src/shared/errors';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { FileSource } from '../../src/sinks/types';
import { LABELS } from '../render/labels';

const ctx = {
  now: new Date('2026-10-20T12:00:00Z'),
  labels: LABELS,
  timeZone: 'UTC',
  describeFailure: (error: unknown) =>
    error === 'unavailable'
      ? 'not provided'
      : error instanceof Error
        ? error.message
        : String(error),
};

class FakeSink implements WritableSink {
  readonly id = 'fake';
  abort?: () => Promise<void>;
  saveDialogSuspected = false;
  readonly writes: { path: string; source: FileSource }[] = [];
  constructor(private readonly fail: Record<string, Error> = {}) {}
  writeText(path: string, content: string) {
    return this.writeFile(path, { kind: 'text', text: content, mime: 'text/markdown' });
  }
  writeFile(path: string, source: FileSource) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (this.fail[name]) return Promise.reject(this.fail[name]);
    this.writes.push({ path, source });
    return Promise.resolve();
  }
  finish(markdownPath: string) {
    return Promise.resolve({ kind: 'downloads' as const, path: `AI Chats/${markdownPath}` });
  }
}

const attachment = (id: string, name: string, extra: Partial<Attachment> = {}): Attachment => ({
  id,
  name,
  origin: 'user-upload',
  source: { kind: 'url', url: `https://claude.ai/files/${id}` },
  ...extra,
});

const conversation = (attachments: Attachment[]): Conversation => ({
  id: 'c1',
  platform: 'claude',
  title: 'Files',
  createdAt: '2026-10-13T09:00:00Z',
  updatedAt: null,
  url: 'https://claude.ai/chat/c1',
  messages: [
    {
      id: 'm1',
      role: 'user',
      createdAt: null,
      blocks: [{ type: 'text', markdown: 'Hi' }],
      attachments,
    },
  ],
  branches: [],
});

const markdownOf = (sink: FakeSink) => {
  const md = sink.writes.at(-1);
  return md?.source.kind === 'text' ? md.source.text : '';
};

describe('writeConversation', () => {
  it('saves files first, then Markdown that links to them', async () => {
    const sink = new FakeSink();
    const outcome = await writeConversation(
      conversation([attachment('a', 'report.pdf'), attachment('b', 'report.pdf')]),
      DEFAULT_SETTINGS,
      ctx,
      (root) => {
        expect(root).toEqual(['AI Chats']);
        return sink;
      },
    );
    expect(sink.writes.map((w) => w.path)).toEqual([
      'Files - 2026-10-13 (Claude)/files/report.pdf',
      'Files - 2026-10-13 (Claude)/files/report-2.pdf',
      'Files - 2026-10-13 (Claude)/Files - 2026-10-13 (Claude).md',
    ]);
    expect(outcome).toMatchObject({ savedFiles: 2, failedFiles: 0 });
    expect(markdownOf(sink)).toContain(
      '**Attachments:**\n- [report.pdf](files/report.pdf)\n- [report-2.pdf](files/report-2.pdf)\n',
    );
  });

  it("gives the platform's reason for a file it does not provide", async () => {
    const sink = new FakeSink({});
    const outcome = await writeConversation(
      conversation([
        attachment('a', 'old.vsix', {
          source: null,
          note: 'unavailable',
          unavailableReason: 'This file was replaced by newer files.',
        }),
      ]),
      DEFAULT_SETTINGS,
      ctx,
      () => sink,
    );
    expect(outcome.failures).toEqual([
      { name: 'old.vsix', reason: 'This file was replaced by newer files.' },
    ]);
  });

  it('marks failed and unavailable files and keeps going', async () => {
    const sink = new FakeSink({ 'gone.pdf': new DownloadInterruptedError('SERVER_BAD_CONTENT') });
    const outcome = await writeConversation(
      conversation([
        attachment('a', 'gone.pdf'),
        attachment('b', 'missing.html', { source: null, note: 'unavailable', origin: 'artifact' }),
        attachment('c', 'ok.txt'),
        attachment('d', 'pasted', {
          note: 'extracted-text-only',
          source: { kind: 'text', text: 't', mime: 'text/plain' },
        }),
      ]),
      DEFAULT_SETTINGS,
      ctx,
      () => sink,
    );
    // Bad content is no passing failure: the chat is not exported again for it.
    expect(outcome).toMatchObject({ savedFiles: 2, failedFiles: 2, missingFiles: 0 });
    expect(outcome.failures).toEqual([
      { name: 'gone.pdf', reason: 'Download interrupted: SERVER_BAD_CONTENT' },
      { name: 'missing.html', reason: 'not provided' },
    ]);
    expect(markdownOf(sink)).toContain(
      [
        '- ⚠️ gone.pdf — could not download: Download interrupted: SERVER_BAD_CONTENT',
        '- ⚠️ missing.html — could not download: not provided',
        '- [ok.txt](files/ok.txt)',
        '- [pasted.extracted.txt](files/pasted.extracted.txt) (extracted text only)',
      ].join('\n'),
    );
  });

  it('counts files that failed for a passing reason as missing', async () => {
    const sink = new FakeSink({
      'net.pdf': new DownloadInterruptedError('NETWORK_FAILED'),
      'gone.pdf': new DownloadInterruptedError('SERVER_BAD_CONTENT'),
      'busy.pdf': new FileWriteError('HTTP_503'),
      'refused.pdf': new FileWriteError('HTTP_403'),
    });
    const outcome = await writeConversation(
      conversation([
        attachment('a', 'net.pdf'),
        attachment('b', 'gone.pdf'),
        attachment('c', 'busy.pdf'),
        attachment('d', 'refused.pdf'),
      ]),
      DEFAULT_SETTINGS,
      ctx,
      () => sink,
    );
    expect(outcome).toMatchObject({ failedFiles: 4, missingFiles: 2 });
  });

  it('asks for a new link once when a link is refused, as an expired signed one', async () => {
    class ExpiringSink extends FakeSink {
      override writeFile(path: string, source: FileSource) {
        if (source.kind === 'url' && source.url.includes('expired')) {
          return Promise.reject(new DownloadInterruptedError('SERVER_FORBIDDEN'));
        }
        if (source.kind === 'url' && source.url.includes('offline')) {
          return Promise.reject(new DownloadInterruptedError('NETWORK_FAILED'));
        }
        return super.writeFile(path, source);
      }
    }
    const sink = new ExpiringSink();
    const asked: string[] = [];
    const outcome = await writeConversation(
      conversation([
        attachment('a', 'a.pdf', { source: { kind: 'url', url: 'https://x/expired-a' } }),
        attachment('b', 'b.pdf', { source: { kind: 'url', url: 'https://x/expired-b' } }),
        attachment('c', 'c.pdf', { source: { kind: 'url', url: 'https://x/offline-c' } }),
      ]),
      DEFAULT_SETTINGS,
      {
        ...ctx,
        refreshLink: (a) => {
          asked.push(a.id);
          return Promise.resolve(a.id === 'a' ? 'https://x/fresh-a' : null);
        },
      },
      () => sink,
    );
    // a: saved from the new link; b: no new link; c: not refused, so not asked.
    expect(asked).toEqual(['a', 'b']);
    expect(sink.writes.map((w) => (w.source.kind === 'url' ? w.source.url : 'note'))).toEqual([
      'https://x/fresh-a',
      'note',
    ]);
    expect(outcome).toMatchObject({ savedFiles: 1, failedFiles: 2 });
  });

  it('only lists files when attachments are turned off', async () => {
    const sink = new FakeSink();
    await writeConversation(
      conversation([attachment('a', 'report.pdf')]),
      { ...DEFAULT_SETTINGS, saveAttachments: false },
      ctx,
      () => sink,
    );
    expect(sink.writes).toHaveLength(1);
    expect(markdownOf(sink)).toContain('**Attachments:**\n- report.pdf\n');
  });

  it('stops at the first sign of a Save As dialog', async () => {
    const sink = new FakeSink({ 'a.pdf': new DownloadInterruptedError('USER_CANCELED') });
    await expect(
      writeConversation(
        conversation([attachment('a', 'a.pdf'), attachment('b', 'b.pdf')]),
        DEFAULT_SETTINGS,
        ctx,
        () => sink,
      ),
    ).rejects.toMatchObject({ code: 'save-dialog' });
    expect(sink.writes).toEqual([]);
  });

  it('stops when a file landed somewhere else', async () => {
    const sink = new FakeSink();
    const original = sink.writeFile.bind(sink);
    sink.writeFile = async (path, source) => {
      await original(path, source);
      sink.saveDialogSuspected = true;
    };
    await expect(
      writeConversation(
        conversation([attachment('a', 'a.pdf'), attachment('b', 'b.pdf')]),
        DEFAULT_SETTINGS,
        ctx,
        () => sink,
      ),
    ).rejects.toMatchObject({ code: 'save-dialog' });
    expect(sink.writes).toHaveLength(1);
  });

  it('writes into the folder the sink prepared and reports where', async () => {
    const sink = new FakeSink();
    const prepared: string[] = [];
    const outcome = await writeConversation(
      conversation([attachment('a', 'report.pdf')]),
      DEFAULT_SETTINGS,
      ctx,
      () =>
        Object.assign(sink, {
          prepareFolder: (folderPath: string) => {
            prepared.push(folderPath);
            return Promise.resolve(`${folderPath} (2)`);
          },
        }),
    );
    expect(prepared).toEqual(['Files - 2026-10-13 (Claude)']);
    expect(sink.writes.map((w) => w.path)).toEqual([
      'Files - 2026-10-13 (Claude) (2)/files/report.pdf',
      'Files - 2026-10-13 (Claude) (2)/Files - 2026-10-13 (Claude) (2).md',
    ]);
    expect(markdownOf(sink)).toContain('- [report.pdf](files/report.pdf)');
    expect(outcome.location).toEqual({
      kind: 'downloads',
      path: 'AI Chats/Files - 2026-10-13 (Claude) (2)/Files - 2026-10-13 (Claude) (2).md',
    });
  });

  it('stops on a folder-wide error and drops the half-written export', async () => {
    const sink = new FakeSink({
      'b.pdf': new CodedError('folder-missing', 'gone'),
    });
    let aborted = 0;
    sink.abort = () => {
      aborted++;
      return Promise.resolve();
    };
    await expect(
      writeConversation(
        conversation([
          attachment('a', 'a.pdf'),
          attachment('b', 'b.pdf'),
          attachment('c', 'c.pdf'),
        ]),
        DEFAULT_SETTINGS,
        ctx,
        () => sink,
      ),
    ).rejects.toMatchObject({ code: 'folder-missing' });
    expect(sink.writes.map((w) => w.path.split('/').pop())).toEqual(['a.pdf']);
    expect(aborted).toBe(1);
  });

  it('writes into the recorded folder when overwriting', async () => {
    const sink = new FakeSink();
    await writeConversation(
      conversation([attachment('a', 'report.pdf')]),
      DEFAULT_SETTINGS,
      { ...ctx, folderOverride: 'Old title - 2026-10-13 (Claude)' },
      () => sink,
    );
    expect(sink.writes.map((w) => w.path)).toEqual([
      'Old title - 2026-10-13 (Claude)/files/report.pdf',
      'Old title - 2026-10-13 (Claude)/Old title - 2026-10-13 (Claude).md',
    ]);
  });

  it('deletes files the chat no longer has when it writes the earlier folder again', async () => {
    class RemovingSink extends FakeSink {
      readonly removed: string[] = [];
      removeFile(path: string) {
        this.removed.push(path);
        return Promise.resolve();
      }
    }
    const sink = new RemovingSink();
    const folder = 'Old title - 2026-10-13 (Claude)';
    const outcome = await writeConversation(
      conversation([attachment('a', 'report.pdf'), attachment('b', 'photo.jpg')]),
      DEFAULT_SETTINGS,
      {
        ...ctx,
        folderOverride: folder,
        previousFiles: [`${folder}/files/report.pdf`, `${folder}/files/photo.png`],
      },
      () => sink,
    );
    // photo.png became photo.jpg: the old name goes, the file still in the chat stays.
    expect(sink.removed).toEqual([`${folder}/files/photo.png`]);
    expect(outcome.writtenFiles).toEqual([
      `${folder}/files/report.pdf`,
      `${folder}/files/photo.jpg`,
    ]);
  });
});
