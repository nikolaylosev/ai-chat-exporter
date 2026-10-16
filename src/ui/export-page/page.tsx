import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ConversationSummary } from '../../model/conversation';
import { t } from '../../shared/i18n';
import { isJobActive, jobCounts, type JobItemStatus, type JobState } from '../../shared/job';
import { locationLabel } from '../../shared/location';
import { send, sendToTab } from '../../shared/messages';
import { localDateTime } from '../../util/dates';
import type { ProjectSummary } from '../../model/project';
import { PLATFORM_LABEL, type Platform } from '../../shared/platform';
import type { Settings } from '../../shared/settings';
import {
  errorText,
  FailedFiles,
  startExportJob,
  useJob,
  useSettings,
  FilesCheckbox,
  ZipCheckbox,
} from '../common';
import {
  DEFAULT_FILTER,
  DEFAULT_PROJECT_FILTER,
  filterConversations,
  filterProjects,
  type ListFilter,
  type ProjectFilter,
  type ProjectSortKey,
  type SortKey,
} from './filter';
import {
  forgetFound,
  foundKey,
  loadFound,
  mergeFound,
  rememberFound,
} from '../../shared/search-cache';
import '../styles.css';
import './export.css';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      conversations: ConversationSummary[];
      /** The list ended early: the platform stopped answering, or the user stopped it. */
      incomplete?: { loaded: number; stopped?: boolean };
    };

const STATUS_MARK: Record<JobItemStatus, string> = {
  pending: '',
  running: '…',
  done: '✓',
  warning: '!',
  error: '×',
  skipped: '–',
};

/** Chats read so far while a slow list loads (Gemini answers deep pages in seconds). */
function useListProgress(platform: Platform): number | null {
  const [loaded, setLoaded] = useState<number | null>(null);
  useEffect(() => {
    const listener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      reply: (response: unknown) => void,
    ) => {
      const m = message as {
        target?: string;
        type?: string;
        payload?: { platform?: string; loaded?: number };
      };
      if (m?.target !== 'ui' || m.type !== 'list:progress' || m.payload?.platform !== platform) {
        return false;
      }
      setLoaded(m.payload.loaded ?? null);
      reply({ ok: true, value: null });
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [platform]);
  return loaded;
}

type SearchState =
  | { status: 'idle' }
  | { status: 'running'; found: number; queries: number }
  | { status: 'done'; found: number; queries: number }
  | { status: 'error'; message: string };

/**
 * Chats beyond the list, found through Gemini's search in the platform tab. The
 * tab is held while searching, so the stop request reaches the same page.
 */
function useSearchMore(platform: Platform, onFound: (more: ConversationSummary[]) => void) {
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const tab = useRef<number | null>(null);
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;
  useEffect(() => {
    const listener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      reply: (response: unknown) => void,
    ) => {
      const m = message as {
        target?: string;
        type?: string;
        payload?: {
          platform?: string;
          found?: number;
          queries?: number;
          conversations?: ConversationSummary[];
        };
      };
      if (m?.target !== 'ui' || m.type !== 'search:progress' || m.payload?.platform !== platform) {
        return false;
      }
      // Each query's new chats join the table at once.
      if (m.payload.conversations?.length) onFoundRef.current(m.payload.conversations);
      setState((s) =>
        s.status === 'running'
          ? { status: 'running', found: m.payload?.found ?? 0, queries: m.payload?.queries ?? 0 }
          : s,
      );
      reply({ ok: true, value: null });
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [platform]);

  const start = async (knownIds: string[]) => {
    setState({ status: 'running', found: 0, queries: 0 });
    let opened = false;
    try {
      const target = await send('background', 'platform:tab', { platform });
      tab.current = target.tabId;
      opened = target.opened;
      const result = await sendToTab(target.tabId, 'conversations:search', { knownIds });
      onFound(result.conversations);
      setState({ status: 'done', found: result.conversations.length, queries: result.queries });
    } catch (error) {
      setState({ status: 'error', message: errorText(error) });
    } finally {
      if (tab.current !== null) {
        void send('background', 'platform:tab-done', { tabId: tab.current, opened }).catch(
          () => undefined,
        );
      }
      tab.current = null;
    }
  };
  const stop = () => {
    if (tab.current !== null) {
      void sendToTab(tab.current, 'conversations:search-stop', {}).catch(() => undefined);
    }
  };
  return { state, start, stop };
}

/**
 * The chat list, asked of the platform tab directly (see `platform:tab`).
 * `onTab` gets the tab, so the loading can be stopped there.
 */
async function listConversations(platform: Platform, onTab: (tabId: number | null) => void) {
  const { tabId, opened } = await send('background', 'platform:tab', { platform });
  onTab(tabId);
  try {
    return await sendToTab(tabId, 'conversations:list', {});
  } finally {
    onTab(null);
    void send('background', 'platform:tab-done', { tabId, opened }).catch(() => undefined);
  }
}

function useConversations(platform: Platform) {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [stopping, setStopping] = useState(false);
  const tab = useRef<number | null>(null);
  const load = () => {
    setState({ status: 'loading' });
    setStopping(false);
    listConversations(platform, (tabId) => (tab.current = tabId)).then(
      ({ conversations, incomplete }) =>
        setState({ status: 'ready', conversations, ...(incomplete ? { incomplete } : {}) }),
      (error: unknown) => setState({ status: 'error', message: errorText(error) }),
    );
  };
  /** Ends the loading after the current page; the chats read so far are listed. */
  const stop = () => {
    if (tab.current === null) return;
    setStopping(true);
    void sendToTab(tab.current, 'conversations:list-stop', {}).catch(() => undefined);
  };
  useEffect(load, []);
  return { list: state, reload: load, stop, stopping };
}

const formatDate = (iso: string | null) => (iso ? localDateTime(iso) : '');

function Progress({ job, onDismiss }: { job: JobState; onDismiss: () => void }) {
  const counts = jobCounts(job);
  const finished = counts.total - counts.pending;
  const active = job.status === 'running' || job.status === 'cancelling';
  const current = job.items.find((i) => i.status === 'running');
  const failed = job.items.filter((i) => i.status === 'error');

  return (
    <section class="progress" aria-live="polite">
      <div class="progress-head">
        <h2>
          {active
            ? job.status === 'cancelling'
              ? t('jobCancelling')
              : t('jobRunning')
            : job.status === 'cancelled'
              ? t('jobCancelled')
              : job.status === 'stopped'
                ? t('jobStopped')
                : t('jobFinished')}
        </h2>
        {active ? (
          <button
            type="button"
            disabled={job.status === 'cancelling'}
            onClick={() => void send('background', 'job:cancel', {})}
          >
            {t('jobCancel')}
          </button>
        ) : (
          <button type="button" onClick={onDismiss}>
            {t('jobNew')}
          </button>
        )}
      </div>
      <progress max={counts.total} value={finished} />
      <p class="counts">
        {t('jobCounts', [
          String(finished),
          String(counts.total),
          String(counts.done),
          String(counts.warning),
          String(counts.error),
          String(counts.skipped),
        ])}
      </p>
      {current && <p class="muted">{t('jobCurrent', current.title || t('untitledChat'))}</p>}
      {job.stopReason && <p class="error">{job.stopReason.message}</p>}
      {job.recoveries ? <p class="warn">{t('jobRecovered', String(job.recoveries))}</p> : null}
      {job.parts && job.parts.length > 0 && (
        <>
          <p class="muted">{t('jobParts', String(job.parts.length + (job.location ? 1 : 0)))}</p>
          <ul class="parts">
            {job.parts.map((part) => (
              <li key={part.path} class="path">
                {part.path}
              </li>
            ))}
          </ul>
        </>
      )}
      {job.location && (
        <p>
          {locationLabel(job.location)} <span class="path">{job.location.path}</span>
        </p>
      )}
      {job.reportPath && (
        <p class="muted">
          {t('jobReport')} <span class="path">{job.reportPath}</span>
        </p>
      )}
      {!active && failed.length > 0 && (
        <details>
          <summary>{t('jobFailedList', String(failed.length))}</summary>
          <ul>
            {failed.map((item) => (
              <li key={item.id}>
                {item.title || t('untitledChat')} — {item.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SortHeader(props: {
  label: string;
  sortKey: SortKey;
  filter: ListFilter;
  setFilter: (f: ListFilter) => void;
}) {
  const active = props.filter.sort === props.sortKey;
  const direction = active ? (props.filter.descending ? 'descending' : 'ascending') : 'none';
  return (
    <th aria-sort={direction}>
      <button
        type="button"
        class="sort"
        onClick={() =>
          props.setFilter({
            ...props.filter,
            sort: props.sortKey,
            descending: active ? !props.filter.descending : props.sortKey !== 'title',
          })
        }
      >
        {props.label}
        {active ? (props.filter.descending ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );
}

interface TabProps {
  platform: Platform;
  settings: Settings | null;
  updateSettings: (patch: Partial<Settings>) => void;
  job: JobState | null | undefined;
  /** Whether the job's statuses are shown (the user has not hidden the job). */
  showJob: boolean;
  onStarted: () => void;
}

function ChatsTab({ platform, settings, updateSettings, job, showJob, onStarted }: TabProps) {
  const { list, reload, stop: stopList, stopping } = useConversations(platform);
  const loadedSoFar = useListProgress(platform);
  // Gemini's list has no creation dates: its dates are the last update.
  const hasCreated = platform !== 'gemini';
  const [filter, setFilter] = useState<ListFilter>(DEFAULT_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startError, setStartError] = useState('');

  // Chats found through the platform's search, beyond its list (Gemini), and
  // remembered from earlier searches (search-cache.ts).
  const [extra, setExtra] = useState<ConversationSummary[]>([]);
  useEffect(() => {
    if (platform !== 'gemini') return;
    void loadFound(platform).then((found) => setExtra((now) => mergeFound(found, now)));
    // The bulk export forgets chats that are gone and renews titles: follow it.
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const change = changes[foundKey(platform)];
      if (area !== 'local' || !change) return;
      const now = Array.isArray(change.newValue) ? (change.newValue as ConversationSummary[]) : [];
      const kept = new Set(now.map((c) => c.id));
      const forgotten = new Set(
        (Array.isArray(change.oldValue) ? (change.oldValue as ConversationSummary[]) : [])
          .map((c) => c.id)
          .filter((id) => !kept.has(id)),
      );
      // Chats a running search found are written soon after: keep those, drop the forgotten.
      setExtra((shown) =>
        mergeFound(
          shown.filter((c) => !forgotten.has(c.id)),
          now,
        ),
      );
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [platform]);
  const extraOnly = useMemo(() => {
    if (list.status !== 'ready') return [];
    // A chat the list has now (it was updated, or the list went deeper) is shown once, from the list.
    const listed = new Set(list.conversations.map((c) => c.id));
    return extra.filter((c) => !listed.has(c.id));
  }, [list, extra]);
  const conversations = useMemo(
    () => (list.status === 'ready' ? [...list.conversations, ...extraOnly] : []),
    [list, extraOnly],
  );
  const more = useSearchMore(platform, (found) => {
    setExtra((previous) => mergeFound(previous, found));
    void rememberFound(platform, found);
  });
  const forget = () => {
    setExtra([]);
    void forgetFound(platform);
  };
  const visible = useMemo(
    () => filterConversations(conversations, filter),
    [conversations, filter],
  );

  const itemById = useMemo(() => new Map((job?.items ?? []).map((item) => [item.id, item])), [job]);
  const busy = isJobActive(job);

  const visibleSelected = visible.filter((c) => selected.has(c.id)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
  // Updates from the previous state: quick clicks can come before a re-render.
  const toggleAll = () =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const c of visible) {
        if (allVisibleSelected) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const start = async () => {
    if (!settings) return;
    setStartError('');
    // Keep the list's order, newest first, whatever the current sort.
    const items = conversations
      .filter((c) => selected.has(c.id))
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
    const error = await startExportJob(settings, items, platform);
    if (error) setStartError(error);
    else onStarted();
  };

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = visibleSelected > 0 && !allVisibleSelected;
    }
  });

  return (
    <>
      <div class="filters">
        <label class="field search">
          <span>{t('exportSearch')}</span>
          <input
            type="search"
            value={filter.query}
            placeholder={t('exportSearchPlaceholder')}
            onInput={(e) => setFilter({ ...filter, query: e.currentTarget.value })}
          />
        </label>
        <label class="field">
          <span>{hasCreated ? t('exportFrom') : t('exportUpdatedFrom')}</span>
          <input
            type="date"
            value={filter.from}
            onInput={(e) => setFilter({ ...filter, from: e.currentTarget.value })}
          />
        </label>
        <label class="field">
          <span>{t('exportTo')}</span>
          <input
            type="date"
            value={filter.to}
            onInput={(e) => setFilter({ ...filter, to: e.currentTarget.value })}
          />
        </label>
      </div>

      {list.status === 'loading' && (
        <p class="muted">
          {loadedSoFar ? t('exportLoadingCount', String(loadedSoFar)) : t('exportLoading')}{' '}
          {stopping ? (
            t('exportListStopping')
          ) : (
            <button type="button" class="link" onClick={stopList}>
              {t('exportListStop')}
            </button>
          )}
        </p>
      )}
      {list.status === 'error' && (
        <p class="error">
          {list.message}{' '}
          <button type="button" class="link" onClick={reload}>
            {t('exportRetry')}
          </button>
        </p>
      )}
      {list.status === 'ready' && list.incomplete && (
        <p class="warn">
          {list.incomplete.stopped
            ? t('exportListStopped', String(list.incomplete.loaded))
            : t('exportListIncomplete', [
                PLATFORM_LABEL[platform],
                String(list.incomplete.loaded),
              ])}{' '}
          <button type="button" class="link" onClick={reload}>
            {list.incomplete.stopped ? t('exportListLoadAll') : t('exportRetry')}
          </button>
        </p>
      )}
      {list.status === 'ready' && platform === 'gemini' && (
        <div class="search-more">
          {more.state.status === 'running' ? (
            <p class="muted">
              {t('exportSearchRunning', [String(more.state.found), String(more.state.queries)])}{' '}
              <button type="button" class="link" onClick={more.stop}>
                {t('exportSearchStop')}
              </button>
            </p>
          ) : (
            <p class="muted">
              {more.state.status === 'done' &&
                `${t('exportSearchDone', [String(more.state.found), String(more.state.queries)])} `}
              {more.state.status === 'error' && <span class="error">{more.state.message} </span>}
              <button type="button" onClick={() => void more.start(conversations.map((c) => c.id))}>
                {more.state.status === 'idle' ? t('exportSearchMore') : t('exportSearchAgain')}
              </button>
              {more.state.status === 'idle' && <small class="hint">{t('exportSearchHint')}</small>}
              {more.state.status === 'idle' && extraOnly.length > 0 && (
                <>
                  <br />
                  {t('exportSearchRemembered', String(extraOnly.length))}{' '}
                  <button type="button" class="link" onClick={forget}>
                    {t('exportSearchForget')}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      )}

      {list.status === 'ready' && (
        <>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="select">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      aria-label={t('exportSelectAll')}
                      checked={allVisibleSelected}
                      disabled={visible.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                  <SortHeader
                    label={t('exportColTitle')}
                    sortKey="title"
                    filter={filter}
                    setFilter={setFilter}
                  />
                  {hasCreated && (
                    <SortHeader
                      label={t('exportColCreated')}
                      sortKey="createdAt"
                      filter={filter}
                      setFilter={setFilter}
                    />
                  )}
                  <SortHeader
                    label={t('exportColUpdated')}
                    sortKey="updatedAt"
                    filter={filter}
                    setFilter={setFilter}
                  />
                  <SortHeader
                    label={platform === 'gemini' ? t('exportColGem') : t('exportColProject')}
                    sortKey="project"
                    filter={filter}
                    setFilter={setFilter}
                  />
                  {showJob && <th class="status">{t('exportColStatus')}</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const item = showJob ? itemById.get(c.id) : undefined;
                  const status = item?.status;
                  return (
                    <tr key={c.id} class={selected.has(c.id) ? 'selected' : ''}>
                      <td class="select">
                        <input
                          type="checkbox"
                          aria-label={c.title || t('untitledChat')}
                          checked={selected.has(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                      </td>
                      <td>
                        <a href={c.url} target="_blank" rel="noreferrer">
                          {c.title || t('untitledChat')}
                        </a>
                        {c.foundBySearch && <small class="hint"> {t('exportFoundBySearch')}</small>}
                        {c.archived && <small class="hint"> {t('exportArchived')}</small>}
                        <FailedFiles failures={item?.failures} total={item?.failedFiles} />
                      </td>
                      {hasCreated && <td class="date">{formatDate(c.createdAt)}</td>}
                      <td class="date">{formatDate(c.updatedAt)}</td>
                      <td>{c.project ?? ''}</td>
                      {showJob && (
                        <td
                          class={`status ${status ?? ''}`}
                          title={status ? t(`jobStatus_${status}`) : ''}
                        >
                          {status ? STATUS_MARK[status] : ''}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length === 0 && <p class="muted empty">{t('exportNothingFound')}</p>}
          </div>

          <div class="actions">
            <p class="muted">
              {t('exportSelected', [String(selected.size), String(conversations.length)])}
            </p>
            {settings && <FilesCheckbox settings={settings} update={updateSettings} />}
            {settings && <ZipCheckbox settings={settings} update={updateSettings} />}
            <button
              type="button"
              class="primary"
              disabled={selected.size === 0 || busy || !settings}
              onClick={() => void start()}
            >
              {t('exportStart', String(selected.size))}
            </button>
            {startError && <p class="error">{startError}</p>}
            {busy && <p class="muted">{t('exportBusy')}</p>}
          </div>
        </>
      )}
    </>
  );
}

type ProjectListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; projects: ProjectSummary[] };

function useProjects(platform: Platform): [ProjectListState, () => void] {
  const [state, setState] = useState<ProjectListState>({ status: 'loading' });
  const load = () => {
    setState({ status: 'loading' });
    send('background', 'projects:list', { platform }).then(
      (projects) => setState({ status: 'ready', projects }),
      (error: unknown) => setState({ status: 'error', message: errorText(error) }),
    );
  };
  useEffect(load, []);
  return [state, load];
}

/** Projects, or Gemini's notebooks: exported the same way, always with their chats. */
function ProjectsTab({ platform, settings, updateSettings, job, showJob, onStarted }: TabProps) {
  const [list, reload] = useProjects(platform);
  const notebooks = platform === 'gemini';
  const untitled = t(notebooks ? 'untitledNotebook' : 'untitledProject');
  const [filter, setFilter] = useState<ProjectFilter>(DEFAULT_PROJECT_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startError, setStartError] = useState('');
  const projects = list.status === 'ready' ? list.projects : [];
  const visible = useMemo(() => filterProjects(projects, filter), [projects, filter]);
  const itemById = useMemo(() => new Map((job?.items ?? []).map((item) => [item.id, item])), [job]);
  const busy = isJobActive(job);
  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id));

  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const p of visible) {
        if (allVisibleSelected) next.delete(p.id);
        else next.add(p.id);
      }
      return next;
    });

  const start = async () => {
    if (!settings) return;
    setStartError('');
    const items = projects
      .filter((p) => selected.has(p.id))
      .map((p) => ({
        kind: 'project' as const,
        id: p.id,
        title: p.name,
        updatedAt: p.updatedAt,
        withChats: true,
      }));
    const error = await startExportJob(settings, items, platform);
    if (error) setStartError(error);
    else onStarted();
  };

  const header = (label: string, key: ProjectSortKey) => {
    const active = filter.sort === key;
    return (
      <th aria-sort={active ? (filter.descending ? 'descending' : 'ascending') : 'none'}>
        <button
          type="button"
          class="sort"
          onClick={() =>
            setFilter({
              ...filter,
              sort: key,
              descending: active ? !filter.descending : key !== 'name',
            })
          }
        >
          {label}
          {active ? (filter.descending ? ' ↓' : ' ↑') : ''}
        </button>
      </th>
    );
  };

  return (
    <>
      <div class="filters">
        <label class="field search">
          <span>{t('exportSearch')}</span>
          <input
            type="search"
            value={filter.query}
            placeholder={t('exportProjectSearchPlaceholder')}
            onInput={(e) => setFilter({ ...filter, query: e.currentTarget.value })}
          />
        </label>
      </div>

      {list.status === 'loading' && (
        <p class="muted">
          {t(platform === 'gemini' ? 'exportNotebooksLoading' : 'exportProjectsLoading')}
        </p>
      )}
      {list.status === 'error' && (
        <p class="error">
          {list.message}{' '}
          <button type="button" class="link" onClick={reload}>
            {t('exportRetry')}
          </button>
        </p>
      )}

      {list.status === 'ready' && (
        <>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="select">
                    <input
                      type="checkbox"
                      aria-label={t(
                        notebooks ? 'exportSelectAllNotebooks' : 'exportSelectAllProjects',
                      )}
                      checked={allVisibleSelected}
                      disabled={visible.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                  {header(t('exportColName'), 'name')}
                  {header(t('exportColFiles'), 'knowledgeCount')}
                  {header(t('exportColUpdated'), 'updatedAt')}
                  {showJob && <th class="status">{t('exportColStatus')}</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => {
                  const item = showJob ? itemById.get(p.id) : undefined;
                  const status = item?.status;
                  return (
                    <tr key={p.id} class={selected.has(p.id) ? 'selected' : ''}>
                      <td class="select">
                        <input
                          type="checkbox"
                          aria-label={p.name || untitled}
                          checked={selected.has(p.id)}
                          onChange={() => toggle(p.id)}
                        />
                      </td>
                      <td>
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.name || untitled}
                        </a>
                        {p.description && <small class="hint">{p.description}</small>}
                        <FailedFiles failures={item?.failures} total={item?.failedFiles} />
                      </td>
                      <td class="date">{p.knowledgeCount ?? ''}</td>
                      <td class="date">{formatDate(p.updatedAt)}</td>
                      {showJob && (
                        <td
                          class={`status ${status ?? ''}`}
                          title={status ? t(`jobStatus_${status}`) : ''}
                        >
                          {status ? STATUS_MARK[status] : ''}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length === 0 && (
              <p class="muted empty">
                {projects.length
                  ? t('exportNothingFound')
                  : t(notebooks ? 'exportNoNotebooks' : 'exportNoProjects')}
              </p>
            )}
          </div>

          <div class="actions">
            <p class="muted">
              {t('exportSelected', [String(selected.size), String(projects.length)])}
            </p>
            {settings && <FilesCheckbox settings={settings} update={updateSettings} />}
            {settings && <ZipCheckbox settings={settings} update={updateSettings} />}
            <button
              type="button"
              class="primary"
              disabled={selected.size === 0 || busy || !settings}
              onClick={() => void start()}
            >
              {t(notebooks ? 'exportStartNotebooks' : 'exportStartProjects', String(selected.size))}
            </button>
            {startError && <p class="error">{startError}</p>}
            {busy && <p class="muted">{t('exportBusy')}</p>}
          </div>
        </>
      )}
    </>
  );
}

type Tab = 'chats' | 'projects';

/** Platforms the export page lists; Claude has projects and Gemini notebooks besides chats. */
const PLATFORMS: Platform[] = ['claude', 'gemini', 'grok', 'chatgpt'];

/** The platform in `?platform=`; Claude when it is missing or unknown. */
function platformFromQuery(value: string | null): Platform {
  return PLATFORMS.find((p) => p === value) ?? 'claude';
}

export function ExportPage() {
  const [platform, setPlatform] = useState<Platform>(() =>
    platformFromQuery(new URLSearchParams(location.search).get('platform')),
  );
  const [settings, updateSettings] = useSettings();
  const job = useJob();
  const [dismissedJob, setDismissedJob] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(location.search).get('tab') === 'projects' ? 'projects' : 'chats',
  );

  // The address keeps the platform for a reload.
  const switchPlatform = (name: Platform) => {
    const query = new URLSearchParams(location.search);
    if (name === 'claude') query.delete('platform');
    else query.set('platform', name);
    const search = query.toString();
    history.replaceState(null, '', search ? `?${search}` : location.pathname);
    setPlatform(name);
  };
  useEffect(() => {
    document.title = t('exportTitle', PLATFORM_LABEL[platform]);
  }, [platform]);
  // Every platform has projects; Gemini's are its notebooks.
  const tabs: Tab[] = ['chats', 'projects'];

  const showJob = Boolean(job && job.id !== dismissedJob);
  const props: TabProps = {
    platform,
    settings,
    updateSettings,
    job,
    showJob,
    onStarted: () => setDismissedJob(null),
  };

  return (
    <main>
      <div class="platforms" role="tablist" aria-label={t('exportPlatform')}>
        {PLATFORMS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={platform === name}
            class={platform === name ? 'active' : ''}
            onClick={() => switchPlatform(name)}
          >
            {PLATFORM_LABEL[name]}
          </button>
        ))}
      </div>
      <h1>{t('exportTitle', PLATFORM_LABEL[platform])}</h1>
      <p class="muted">{t('exportIntro')}</p>

      {job && showJob && <Progress job={job} onDismiss={() => setDismissedJob(job.id)} />}

      <div class="tabs" role="tablist">
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            class={tab === name ? 'active' : ''}
            onClick={() => setTab(name)}
          >
            {name === 'chats'
              ? t('exportTabChats')
              : t(platform === 'gemini' ? 'exportTabNotebooks' : 'exportTabProjects')}
          </button>
        ))}
      </div>

      {tab === 'chats' ? (
        <ChatsTab key={platform} {...props} />
      ) : (
        <ProjectsTab key={platform} {...props} />
      )}
    </main>
  );
}
