import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../shared/i18n';
import { errorMessage } from '../../shared/logger';
import { canUseFolders, loadFolderHandle } from '../../sinks/folder-handle';
import {
  completeFromTakeout,
  type ChatCompletion,
  type CompletionProgress,
} from '../../takeout/complete';
import {
  filesAdded,
  reportMarkdown,
  writeReport,
  writeSections,
  type ReportLabels,
  type SectionLabels,
} from '../../takeout/section';
import type { TakeoutSource } from '../../takeout/source';
import '../styles.css';
import './takeout.css';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; adding: boolean; progress: CompletionProgress | null }
  | { kind: 'checked'; completions: ChatCompletion[]; offTime: boolean }
  | { kind: 'done'; completions: ChatCompletion[]; report: string }
  | { kind: 'error'; message: string };

const sectionLabels = (): SectionLabels => ({
  heading: t('takeoutSectionHeading'),
  intro: (date) => t('takeoutSectionIntro', date),
  files: t('takeoutSectionFiles'),
  user: t('mdUser'),
  assistant: 'Gemini',
  attachments: t('mdAttachments'),
  notInTakeout: t('takeoutNotInTakeout'),
});

const reportLabels = (): ReportLabels => ({
  title: t('takeoutReportTitle'),
  summary: (date, chats, files, prompts) =>
    t('takeoutReportSummary', [date, String(chats), String(files), String(prompts)]),
  chat: (files, prompts) => t('takeoutChat', [String(files), String(prompts)]),
  filesOnly: t('takeoutFilesOnly'),
});

const today = () => new Date().toLocaleDateString('sv-SE');
const stamp = () =>
  new Date()
    .toLocaleString('sv-SE')
    .replace(/:\d\d$/, '')
    .replace(/[ :]/g, '-');

const totals = (completions: readonly ChatCompletion[]) => ({
  chats: completions.length,
  files: completions.reduce((n, c) => n + filesAdded(c), 0),
  prompts: completions.reduce((n, c) => n + c.prompts.length, 0),
});

function progressText(p: CompletionProgress | null): string {
  if (!p || p.phase === 'activity') return t('takeoutReadingActivity');
  if (p.phase === 'archive') return t('takeoutReadingArchive', String(p.done));
  if (p.phase === 'files') return t('takeoutReadingFiles', [String(p.done), String(p.total ?? 0)]);
  return t('takeoutWriting', [String(p.done), String(p.total ?? 0)]);
}

/**
 * Completing saved Gemini chats from Google Takeout (takeout/complete.ts): the
 * folder of saved chats and Takeout are chosen, a check shows what each chat
 * would get, and "Add them" writes it. Nothing leaves the computer.
 */
export function TakeoutPage() {
  const [archive, setArchive] = useState<FileSystemDirectoryHandle | null>(null);
  const [exportFolder, setExportFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [source, setSource] = useState<{ source: TakeoutSource; label: string } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const zips = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `${t('takeoutTitle')} · ${t('extName')}`;
    void loadFolderHandle()
      .then(setExportFolder)
      .catch(() => undefined);
  }, []);

  const fail = (e: unknown) => {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    setPhase({ kind: 'error', message: errorMessage(e) });
  };

  const useArchive = async (handle: FileSystemDirectoryHandle) => {
    // Asked only when not granted already: asking needs the user's click.
    const access =
      (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'
        ? 'granted'
        : await handle.requestPermission({ mode: 'readwrite' });
    if (access !== 'granted') return;
    setArchive(handle);
    setPhase({ kind: 'idle' });
  };
  const chooseArchive = async () => {
    try {
      await useArchive(
        await window.showDirectoryPicker({ id: 'takeout-archive', mode: 'readwrite' }),
      );
    } catch (e) {
      fail(e);
    }
  };
  const chooseTakeoutFolder = async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'takeout-source', mode: 'read' });
      setSource({ source: { kind: 'folder', handle }, label: handle.name });
      setPhase({ kind: 'idle' });
    } catch (e) {
      fail(e);
    }
  };

  const run = async (adding: boolean) => {
    if (!archive || !source) return;
    setPhase({ kind: 'running', adding, progress: null });
    try {
      const labels = sectionLabels();
      const date = today();
      const result = await completeFromTakeout(archive, source.source, {
        dryRun: !adding,
        onProgress: (progress) => setPhase({ kind: 'running', adding, progress }),
        writeNotes: (c) => writeSections(c, labels, date),
      });
      const completions = result.chats;
      // Most prompts unmatched: the notes' times are likely another time zone's.
      const offTime = result.prompts >= 20 && result.unmatched > result.prompts / 2;
      if (!adding) return setPhase({ kind: 'checked', completions, offTime });
      const report = completions.length
        ? await writeReport(archive, reportMarkdown(completions, reportLabels(), date), stamp())
        : '';
      setPhase({ kind: 'done', completions, report });
    } catch (e) {
      fail(e);
    }
  };

  const running = phase.kind === 'running';
  const shown = phase.kind === 'checked' || phase.kind === 'done' ? phase.completions : null;
  const sum = shown ? totals(shown) : null;

  return (
    <main>
      <h1>{t('takeoutTitle')}</h1>
      <p class="muted">{t('takeoutHint')}</p>
      <p class="muted">{t('takeoutReexportHint')}</p>
      {!canUseFolders() && (
        <p class="warn">
          {t('searchUnsupported')}
          {'brave' in navigator && <> {t('optionsFolderBrave')}</>}
        </p>
      )}

      <div class="step">
        <p>{archive ? t('takeoutArchive', archive.name) : t('takeoutArchiveNone')}</p>
        {!archive && exportFolder && (
          <button
            type="button"
            class="primary"
            disabled={running}
            onClick={() => void useArchive(exportFolder).catch(fail)}
          >
            {t('takeoutUseExportFolder', exportFolder.name)}
          </button>
        )}
        {canUseFolders() && (
          <button type="button" disabled={running} onClick={() => void chooseArchive()}>
            {archive ? t('searchChooseOther') : t('takeoutChooseArchive')}
          </button>
        )}
      </div>

      <div class="step">
        <p>{source ? t('takeoutSource', source.label) : t('takeoutSourceNone')}</p>
        <input
          ref={zips}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            if (!files.length) return;
            setSource({
              source: { kind: 'files', files },
              label: files.map((f) => f.name).join(', '),
            });
            setPhase({ kind: 'idle' });
          }}
        />
        <button type="button" disabled={running} onClick={() => zips.current?.click()}>
          {t('takeoutChooseZip')}
        </button>
        {canUseFolders() && (
          <button type="button" disabled={running} onClick={() => void chooseTakeoutFolder()}>
            {t('takeoutChooseFolder')}
          </button>
        )}
      </div>

      <div class="step">
        <button
          type="button"
          class={phase.kind === 'checked' ? '' : 'primary'}
          disabled={!archive || !source || running}
          onClick={() => void run(false)}
        >
          {t('takeoutCheck')}
        </button>
        {phase.kind === 'checked' && phase.completions.length > 0 && (
          <button type="button" class="primary" onClick={() => void run(true)}>
            {t('takeoutAdd')}
          </button>
        )}
      </div>

      {running && <p class="muted">{progressText(phase.progress)}</p>}
      {phase.kind === 'error' && <p class="error">{phase.message}</p>}
      {phase.kind === 'checked' && phase.offTime && <p class="warn">{t('takeoutTimeWarning')}</p>}
      {sum && (
        <p>
          {sum.chats === 0
            ? t('takeoutNothing')
            : phase.kind === 'done'
              ? t('takeoutDone', [
                  String(sum.chats),
                  String(sum.files),
                  String(sum.prompts),
                  phase.report,
                ])
              : t('takeoutFound', [String(sum.chats), String(sum.files), String(sum.prompts)])}
        </p>
      )}
      {shown && shown.length > 0 && (
        <ul class="chats">
          {shown.map((c) => (
            <li key={c.chat.path}>
              {c.chat.title || t('untitledChat')}{' '}
              <span class="muted">
                · {t('takeoutChat', [String(filesAdded(c)), String(c.prompts.length)])}
              </span>
            </li>
          ))}
        </ul>
      )}
      {shown &&
        shown.some(
          (c) => !c.chat.notes.some((n) => n.format === 'markdown' || n.format === 'html'),
        ) && <p class="muted">{t('takeoutFilesOnlyHint')}</p>}
    </main>
  );
}
