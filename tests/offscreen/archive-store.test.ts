import { describe, expect, it } from 'vitest';
import { ArchiveStore } from '../../src/offscreen/archive-store';
import { CodedError } from '../../src/shared/errors';

let n = 0;
const store = () => new ArchiveStore(undefined, () => `zip-${++n}`);

describe('ArchiveStore', () => {
  it('gives the same archive to a repeated close, as after a worker restart', async () => {
    const archives = store();
    const id = archives.openArchive();
    await archives.get(id).add('a.md', new Blob(['hello']));
    const first = await archives.close(id);
    const again = await archives.close(id);
    expect(again).toBe(first);
    expect(first.size).toBeGreaterThan(0);
  });

  it('reports an archive it never had as lost', () => {
    const archives = store();
    expect(() => archives.close('unknown')).toThrow(CodedError);
    try {
      archives.get('unknown');
    } catch (error) {
      expect((error as CodedError).code).toBe('archive-lost');
    }
  });

  it('takes no more files into a closed archive', async () => {
    const archives = store();
    const id = archives.openArchive();
    await archives.close(id);
    expect(() => archives.get(id)).toThrow(/No archive/);
  });

  it('forgets a discarded archive and keeps only the last few closed ones', async () => {
    const archives = store();
    const discarded = archives.openArchive();
    archives.discard(discarded);
    expect(() => archives.close(discarded)).toThrow(/No archive/);
    const ids = Array.from({ length: 6 }, () => archives.openArchive());
    for (const id of ids) await archives.close(id);
    expect(() => archives.close(ids[0]!)).toThrow(/No archive/);
    await expect(archives.close(ids[5]!)).resolves.toBeInstanceOf(Blob);
  });
});
