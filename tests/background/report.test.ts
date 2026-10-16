import { describe, expect, it } from 'vitest';
import {
  renderReport,
  reportPath,
  wantsReport,
  type ReportLabels,
} from '../../src/background/report';
import type { JobItem, JobState } from '../../src/shared/job';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

const labels: ReportLabels = {
  title: (p) => `Export report: ${p}`,
  started: 'Started',
  finished: 'Finished',
  summary: (c) =>
    `Saved ${c.done + c.warning}, errors ${c.error}, skipped ${c.skipped}, of ${c.total}`,
  cancelled: 'Cancelled.',
  stopped: (r) => `Stopped: ${r}`,
  errors: 'Errors',
  warnings: 'Saved with missing files',
  failedFiles: (n) => `files not saved: ${n}`,
  moreFiles: (n) => `and ${n} more`,
  skipped: 'Skipped',
  notReached: 'Not reached',
  saved: 'Saved',
};

const item = (id: string, status: JobItem['status'], extra: Partial<JobItem> = {}): JobItem => ({
  id,
  title: `Chat ${id}`,
  updatedAt: null,
  status,
  ...extra,
});

const job = (items: JobItem[], extra: Partial<JobState> = {}): JobState => ({
  id: 'j',
  platform: 'claude',
  status: 'finished',
  items,
  settings: DEFAULT_SETTINGS,
  startedAt: '2026-10-13T10:00:00Z',
  finishedAt: '2026-10-13T10:05:00Z',
  tab: {},
  ...extra,
});

describe('renderReport', () => {
  it('lists every group with links from _reports/ to the notes', () => {
    const text = renderReport(
      job([
        item('1', 'done', { path: 'Chat 1 - 2026-10-13 (Claude)/Chat 1 - 2026-10-13 (Claude).md' }),
        item('2', 'warning', {
          path: 'B/B.md',
          failedFiles: 3,
          failures: [
            { name: 'a [1].pdf', reason: 'server error' },
            { name: 'b.png', reason: '' },
          ],
        }),
        item('3', 'error', { message: 'not found' }),
        item('4', 'skipped'),
        item('[5]', 'pending'),
      ]),
      'Claude',
      labels,
      'UTC',
    );
    expect(text).toBe(
      [
        '# Export report: Claude',
        '',
        '- Started: 2026-10-13 10:00',
        '- Finished: 2026-10-13 10:05',
        '- Saved 2, errors 1, skipped 1, of 5',
        '',
        '## Errors',
        '',
        '- Chat 3 — not found',
        '',
        '## Saved with missing files',
        '',
        '- [Chat 2](../B/B.md) — files not saved: 3',
        '  - a \\[1\\].pdf — server error',
        '  - b.png',
        '  - and 1 more',
        '',
        '## Skipped',
        '',
        '- Chat 4',
        '',
        '## Not reached',
        '',
        '- Chat \\[5\\]',
        '',
        '## Saved',
        '',
        '- [Chat 1](../Chat%201%20-%202026-10-13%20%28Claude%29/Chat%201%20-%202026-10-13%20%28Claude%29.md)',
        '',
      ].join('\n'),
    );
  });

  it('says why a job stopped', () => {
    const text = renderReport(
      job([item('1', 'error', { message: 'signed out' })], {
        status: 'stopped',
        stopReason: { code: 'not-signed-in', message: 'Sign in' },
      }),
      'Claude',
      labels,
      'UTC',
    );
    expect(text).toContain('- Stopped: Sign in\n');
  });
});

describe('wantsReport', () => {
  const settings = (writeReport: typeof DEFAULT_SETTINGS.writeReport) => ({
    ...DEFAULT_SETTINGS,
    writeReport,
  });
  it('follows the setting', () => {
    const clean = [item('1', 'done'), item('2', 'skipped')];
    expect(wantsReport(job(clean, { settings: settings('on-errors') }))).toBe(false);
    expect(
      wantsReport(job([...clean, item('3', 'warning')], { settings: settings('on-errors') })),
    ).toBe(true);
    expect(wantsReport(job(clean, { settings: settings('on-errors'), status: 'stopped' }))).toBe(
      true,
    );
    expect(wantsReport(job(clean, { settings: settings('always') }))).toBe(true);
    expect(wantsReport(job([item('1', 'error')], { settings: settings('never') }))).toBe(false);
  });
});

it('names the report by time', () => {
  expect(reportPath(new Date('2026-10-13T15:40:00Z'), 'UTC')).toBe(
    '_reports/export-report-2026-10-13-1540.md',
  );
});
