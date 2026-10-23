import { useEffect, useState } from 'preact/hooks';
import { conversationIdFromUrl, projectIdFromUrl } from '../../adapters/claude/urls';
import { geminiConversationId, geminiNotebookId } from '../../adapters/gemini/urls';
import { chatgptConversationId, chatgptProjectId } from '../../adapters/chatgpt/urls';
import { grokConversationId, grokProjectId } from '../../adapters/grok/urls';
import { codeText } from '../../shared/error-text';
import { t } from '../../shared/i18n';
import { errorMessage } from '../../shared/logger';
import { jobCounts, isJobActive, type JobState } from '../../shared/job';
import { locationLabel } from '../../shared/location';
import { send, type ExportResult } from '../../shared/messages';
import { detectPlatform, PLATFORM_LABEL, type Platform } from '../../shared/platform';
import {
  ensureFolderAccess,
  FailedFiles,
  FilesCheckbox,
  openExportPage,
  SaveDialogWarning,
  startExportJob,
  useJob,
  useSettings,
  useShortcut,
  ZipCheckbox,
} from '../common';
import type { Settings } from '../../shared/settings';
import '../styles.css';
import './popup.css';

interface ActiveTab {
  id: number;
  platform: Platform | null;
  isChat: boolean;
  isProject: boolean;
}

type ExportState =
  | { status: 'idle' }
  | { status: 'running'; copying: boolean }
  | { status: 'finished'; result: ExportResult }
  | { status: 'copied'; messageCount: number };

function useActiveTab(): ActiveTab | null | undefined {
  const [tab, setTab] = useState<ActiveTab | null | undefined>(undefined);
  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
      if (active?.id === undefined) return setTab(null);
      const platform = detectPlatform(active.url);
      const isChat =
        (platform === 'claude' && conversationIdFromUrl(active.url) !== null) ||
        (platform === 'gemini' && geminiConversationId(active.url) !== null) ||
        (platform === 'grok' && grokConversationId(active.url) !== null) ||
        (platform === 'chatgpt' && chatgptConversationId(active.url) !== null);
      // A project's page; a chat inside a project counts as a chat (its project is asked for).
      const isProject =
        !isChat &&
        ((platform === 'claude' && projectIdFromUrl(active.url) !== null) ||
          (platform === 'gemini' && geminiNotebookId(active.url) !== null) ||
          (platform === 'chatgpt' && chatgptProjectId(active.url) !== null) ||
          (platform === 'grok' && grokProjectId(active.url) !== null));
      setTab({ id: active.id, platform, isChat, isProject });
    });
  }, []);
  return tab;
}

/** The project of the open project page or chat; null when there is none. */
function useTabProject(tab: ActiveTab | null | undefined) {
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!tab || (!tab.isChat && !tab.isProject)) return;
    send('background', 'project:of-tab', { tabId: tab.id }).then(setProject, () =>
      setProject(null),
    );
  }, [tab]);
  return project;
}

/** Progress and result of the project export started from this popup. */
function ProjectJob({ job }: { job: JobState }) {
  const counts = jobCounts(job);
  const done = counts.total - counts.pending;
  if (job.status === 'running' || job.status === 'cancelling') {
    return <p class="muted">{t('popupJobRunning', [String(done), String(counts.total)])}</p>;
  }
  return (
    <p
      class={`result ${job.status === 'finished' && !counts.error && !counts.warning ? 'ok' : 'warn'}`}
    >
      {job.stopReason?.message ??
        t('jobCounts', [
          String(done),
          String(counts.total),
          String(counts.done),
          String(counts.warning),
          String(counts.error),
          String(counts.skipped),
        ])}
      {job.location && (
        <>
          <br />
          {locationLabel(job.location)}
          <br />
          <span class="path">{job.location.path}</span>
        </>
      )}
    </p>
  );
}

/** Two overlapping sheets: the usual mark for copying. */
function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3V2.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1H3" />
    </svg>
  );
}

function statusText(tab: ActiveTab): string {
  if (!tab.platform) return t('popupUnsupported');
  if (tab.isProject) return t(tab.platform === 'gemini' ? 'popupNotebookPage' : 'popupProjectPage');
  return tab.isChat ? t('popupDetected', PLATFORM_LABEL[tab.platform]) : t('popupNotAChat');
}

/** What the user did, not a failure: shown in grey. */
const QUIET = new Set<string>(['save-cancelled', 'save-dialog', 'download-cancelled']);

function Result({ result, onZip }: { result: ExportResult; onZip: () => void }) {
  return (
    <>
      {result.ok ? (
        <p class={`result ${result.failedAttachmentCount ? 'warn' : 'ok'}`}>
          {result.failedAttachmentCount
            ? t('popupDonePartial', [
                String(result.messageCount),
                String(result.attachmentCount),
                String(result.failedAttachmentCount),
              ])
            : t('popupDone', [String(result.messageCount), String(result.attachmentCount)])}{' '}
          {locationLabel(result.location)}
          <br />
          <span class="path">{result.location.path}</span>
        </p>
      ) : (
        <p class={`${QUIET.has(result.code) ? 'muted' : 'error'} result`}>{result.message}</p>
      )}
      {result.ok && <FailedFiles failures={result.failures} total={result.failedAttachmentCount} />}
      {result.warning === 'save-dialog-suspected' && <SaveDialogWarning onZip={onZip} />}
    </>
  );
}

export function Popup() {
  const tab = useActiveTab();
  const shortcut = useShortcut();
  const [settings, updateSettings] = useSettings();
  const job = useJob();
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  const project = useTabProject(tab);
  // The export page opens on the platform of the open tab.
  const pagePlatform = tab?.platform ?? 'claude';
  // Gemini's notebooks are its projects: the same buttons, other words.
  const notebook = pagePlatform === 'gemini';
  const [projectJob, setProjectJob] = useState<string | null>(null);
  const [projectError, setProjectError] = useState('');

  const exportProject = async () => {
    if (!settings || !project) return;
    setProjectError('');
    const error = await startExportJob(
      settings,
      [
        {
          kind: 'project',
          id: project.id,
          title: project.name,
          updatedAt: null,
          withChats: true,
        },
      ],
      pagePlatform,
    );
    if (error) setProjectError(error);
    else setProjectJob(project.id);
  };
  const ownJob =
    job && projectJob && job.items[0]?.kind === 'project' && job.items[0].id === projectJob
      ? job
      : null;

  /** `zip`: this export as one archive, after Chrome asked where to save a file. */
  const exportChat = async (tabId: number, zip = false) => {
    setState({ status: 'running', copying: false });
    if (settings?.destination === 'folder') {
      const code = await ensureFolderAccess();
      if (code) {
        const message = codeText(code);
        return setState({ status: 'finished', result: { ok: false, code, message } });
      }
    }
    try {
      setState({
        status: 'finished',
        result: await send('background', 'export:current', { tabId, ...(zip ? { zip } : {}) }),
      });
    } catch (error) {
      setState({
        status: 'finished',
        result: { ok: false, code: 'failed', message: t('error_failed', errorMessage(error)) },
      });
    }
  };

  /** The chat's note, as saved without its files, onto the clipboard; nothing is saved. */
  const copyChat = async (tabId: number) => {
    setState({ status: 'running', copying: true });
    try {
      const copied = await send('background', 'export:copy', { tabId });
      if (!copied.ok) return setState({ status: 'finished', result: copied });
      await navigator.clipboard.writeText(copied.markdown);
      setState({ status: 'copied', messageCount: copied.messageCount });
    } catch (error) {
      setState({
        status: 'finished',
        result: { ok: false, code: 'failed', message: t('error_failed', errorMessage(error)) },
      });
    }
  };

  return (
    <main>
      <h1>{t('extName')}</h1>
      {tab && <p class="muted">{statusText(tab)}</p>}
      {tab === null && <p class="muted">{t('popupUnsupported')}</p>}

      {settings && (
        <>
          <FilesCheckbox settings={settings} update={updateSettings} />
          <ZipCheckbox settings={settings} update={updateSettings} />
        </>
      )}

      <div class="chat-actions">
        <button
          type="button"
          class="primary"
          disabled={!tab?.isChat || !settings || state.status === 'running'}
          onClick={() => tab && void exportChat(tab.id)}
        >
          {state.status === 'running' && !state.copying ? t('popupSaving') : t('popupSaveChat')}
        </button>
        <button
          type="button"
          class="copy"
          title={t('popupCopyHint')}
          disabled={!tab?.isChat || !settings || state.status === 'running'}
          onClick={() => tab && void copyChat(tab.id)}
        >
          <CopyIcon />
          {state.status === 'running' && state.copying ? t('popupCopying') : t('popupCopyChat')}
        </button>
      </div>

      {state.status === 'finished' && (
        <Result result={state.result} onZip={() => tab && void exportChat(tab.id, true)} />
      )}
      {state.status === 'copied' && (
        <p class="result ok">{t('popupCopied', String(state.messageCount))}</p>
      )}

      {project && settings && (
        <section class="project">
          <p class="muted">
            {notebook
              ? t('popupNotebook', project.name || t('untitledNotebook'))
              : t('popupProject', project.name || t('untitledProject'))}
          </p>
          <button type="button" disabled={isJobActive(job)} onClick={() => void exportProject()}>
            {t(notebook ? 'popupSaveNotebook' : 'popupSaveProject')}
          </button>
          {projectError && <p class="error result">{projectError}</p>}
          {ownJob && <ProjectJob job={ownJob} />}
        </section>
      )}

      <div class="bulk">
        {isJobActive(job) ? (
          <p class="muted">
            {t('popupJobRunning', [
              String(jobCounts(job).total - jobCounts(job).pending),
              String(jobCounts(job).total),
            ])}{' '}
            <button type="button" class="link" onClick={() => openExportPage()}>
              {t('popupJobOpen')}
            </button>
          </p>
        ) : (
          <>
            <button type="button" onClick={() => openExportPage({ platform: pagePlatform })}>
              {t('popupChooseChats')}
            </button>
            <button
              type="button"
              onClick={() => openExportPage({ projects: true, platform: pagePlatform })}
            >
              {t(notebook ? 'popupChooseNotebooks' : 'popupChooseProjects')}
            </button>
          </>
        )}
      </div>

      {shortcut !== undefined && (
        <p class="muted hint">
          {shortcut ? t('popupShortcut', shortcut) : t('popupShortcutNotSet')}
        </p>
      )}

      {settings && (
        <label class="note-format">
          <span>{t('noteFormat')}</span>
          <select
            value={settings.noteFormat}
            onChange={(e) =>
              updateSettings({ noteFormat: e.currentTarget.value as Settings['noteFormat'] })
            }
          >
            <option value="markdown">{t('noteFormatMarkdown')}</option>
            <option value="html">{t('noteFormatHtml')}</option>
            <option value="json">{t('noteFormatJson')}</option>
          </select>
        </label>
      )}

      <footer>
        <button type="button" class="link" onClick={() => void chrome.runtime.openOptionsPage()}>
          {t('openSettings')}
        </button>
      </footer>
    </main>
  );
}
