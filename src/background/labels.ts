import { DownloadInterruptedError } from './downloader';
import type { RenderLabels } from '../render/markdown';
import type { ReportLabels } from './report';
import { t } from '../shared/i18n';
import { FileWriteError } from '../sinks/source';
import { HttpError } from '../util/http';
import { PLATFORM_LABEL, type Platform } from '../shared/platform';

/** Markdown labels in the browser's UI language. */
export function renderLabels(platform: Platform): RenderLabels {
  return {
    user: t('mdUser'),
    assistant: PLATFORM_LABEL[platform],
    untitled: t('untitledChat'),
    thinking: t('mdThinking'),
    // ChatGPT does not always say what it searched for.
    webSearch: (query) => (query ? t('mdWebSearch', query) : t('mdWebSearchNoQuery')),
    noResults: t('mdNoResults'),
    tools: (count) => t('mdTools', String(count)),
    toolError: t('mdToolError'),
    attachments: t('mdAttachments'),
    attachmentFailed: (reason) => t('mdAttachmentFailed', reason),
    extractedOnly: t('mdExtractedOnly'),
    extractedPartial: t('mdExtractedPartial'),
    rebuiltFromChat: t('mdRebuiltFromChat'),
    recompressed: t('mdRecompressed'),
    otherBranches: t('mdOtherBranches'),
    unreadable: (kind) => t('mdUnreadable', kind),
    branch: (number, fork) =>
      fork === null
        ? t('mdBranchFromStart', String(number))
        : fork.branch === 1
          ? t('mdBranchAfter', [String(number), String(fork.position)])
          : t('mdBranchAfterIn', [String(number), String(fork.position), String(fork.branch)]),
    selection: (chosen, total) => t('mdSelection', [String(chosen), String(total)]),
  };
}

/** Why an attachment was not saved, in the UI language, for the Markdown. */
export function describeFailure(error: unknown): string {
  if (error === 'unavailable') return t('failUnavailable');
  const reason =
    error instanceof DownloadInterruptedError || error instanceof FileWriteError
      ? error.reason
      : error instanceof HttpError
        ? `HTTP_${error.status}`
        : '';
  if (/FORBIDDEN|HTTP_40[13]/.test(reason)) return t('failForbidden');
  if (/BAD_CONTENT|HTTP_404/.test(reason)) return t('failNotFound');
  if (/^NETWORK_|SERVER_FAILED|HTTP_5/.test(reason)) return t('failNetwork');
  if (/^FILE_/.test(reason)) return t('failFile', reason);
  return t('failOther', reason || (error instanceof Error ? error.message : String(error)));
}

/** Bulk export report labels in the UI language. */
export function reportLabels(): ReportLabels {
  return {
    title: (platform) => t('reportTitle', platform),
    started: t('reportStarted'),
    finished: t('reportFinished'),
    summary: (c) =>
      t('reportSummary', [
        String(c.done + c.warning),
        String(c.warning),
        String(c.error),
        String(c.skipped),
        String(c.total),
      ]),
    cancelled: t('reportCancelled'),
    stopped: (reason) => t('reportStopped', reason),
    errors: t('reportErrors'),
    warnings: t('reportWarnings'),
    failedFiles: (count) => t('reportFailedFiles', String(count)),
    moreFiles: (count) => t('failedFilesMore', String(count)),
    skipped: t('reportSkipped'),
    notReached: t('reportNotReached'),
    saved: t('reportSaved'),
    takeout: t('reportTakeout', chrome.runtime.getURL('src/ui/takeout/index.html')),
  };
}
