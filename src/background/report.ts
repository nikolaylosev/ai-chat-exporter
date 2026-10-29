import { escapeLinkText, linkTarget } from '../render/markdown';
import { jobCounts, type JobItem, type JobState } from '../shared/job';
import { localDateTime, reportTimestamp } from '../util/dates';

export interface ReportLabels {
  title: (platform: string) => string;
  started: string;
  finished: string;
  summary: (c: ReturnType<typeof jobCounts>) => string;
  cancelled: string;
  stopped: (reason: string) => string;
  errors: string;
  warnings: string;
  failedFiles: (count: number) => string;
  /** Files not listed by name: "and 3 more". */
  moreFiles: (count: number) => string;
  skipped: string;
  notReached: string;
  saved: string;
  /** After a Gemini export's missing files: where Google Takeout's copies can be added from. */
  takeout: string;
}

export const REPORTS_DIR = '_reports';

/** `_reports/export-report-2026-10-13-1540.md`, relative to the export root. */
export function reportPath(now: Date, timeZone?: string): string {
  return `${REPORTS_DIR}/export-report-${reportTimestamp(now, timeZone)}.md`;
}

/** Whether the report setting asks for a report after this job. */
export function wantsReport(job: JobState): boolean {
  const mode = job.settings.writeReport;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const counts = jobCounts(job);
  return counts.error > 0 || counts.warning > 0 || job.status === 'stopped';
}

/**
 * The bulk export report in Markdown. Links point from `_reports/` to each saved
 * note, so they work in the export folder and in an Obsidian vault.
 */
export function renderReport(
  job: JobState,
  platformLabel: string,
  labels: ReportLabels,
  timeZone?: string,
): string {
  const counts = jobCounts(job);
  const link = (item: JobItem) =>
    item.path
      ? `[${escapeLinkText(item.title)}](${linkTarget(`../${item.path}`)})`
      : escapeLinkText(item.title);
  const section = (title: string, items: JobItem[], line: (item: JobItem) => string) =>
    items.length ? [`## ${title}`, '', ...items.map((item) => `- ${line(item)}`), ''] : [];
  const by = (status: JobItem['status'] | 'pending') =>
    job.items.filter((i) =>
      status === 'pending' ? i.status === 'pending' || i.status === 'running' : i.status === status,
    );

  const lines = [
    `# ${labels.title(platformLabel)}`,
    '',
    `- ${labels.started}: ${localDateTime(job.startedAt, timeZone)}`,
    ...(job.finishedAt ? [`- ${labels.finished}: ${localDateTime(job.finishedAt, timeZone)}`] : []),
    `- ${labels.summary(counts)}`,
    ...(job.status === 'cancelled' ? [`- ${labels.cancelled}`] : []),
    ...(job.status === 'stopped' && job.stopReason
      ? [`- ${labels.stopped(job.stopReason.message)}`]
      : []),
    '',
    ...section(
      labels.errors,
      by('error'),
      (i) => `${escapeLinkText(i.title)} — ${i.message ?? ''}`,
    ),
    ...section(labels.warnings, by('warning'), (i) =>
      [
        `${link(i)} — ${labels.failedFiles(i.failedFiles ?? 0)}`,
        ...(i.failures ?? []).map(
          (f) => `  - ${escapeLinkText(f.name)}${f.reason ? ` — ${f.reason}` : ''}`,
        ),
        ...((i.failedFiles ?? 0) > (i.failures?.length ?? 0) && i.failures?.length
          ? [`  - ${labels.moreFiles((i.failedFiles ?? 0) - i.failures.length)}`]
          : []),
      ].join('\n'),
    ),
    // Google Takeout keeps files Gemini's history leaves out.
    ...(job.platform === 'gemini' && by('warning').length ? [`> ${labels.takeout}`, ''] : []),
    ...section(labels.skipped, by('skipped'), (i) => escapeLinkText(i.title)),
    ...section(labels.notReached, by('pending'), (i) => escapeLinkText(i.title)),
    ...section(labels.saved, by('done'), link),
  ];
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
