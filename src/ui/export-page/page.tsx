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
} from '../common';
import {
  DEFAULT_FILTER,
  DEFAULT_PROJECT_FILTER,
  filterConversations,
  filterProjects,
  type ListFilter,
  type ProjectFilter,
  chatSource,
  savedStatus,
  type ChatSource,
  type ProjectSortKey,
  type SavedRecord,
  type SavedStatus,
  type SortKey,
} from './filter';
import {
  forgetFound,
  foundKey,
  loadFound,
  loadSearchState,
  mergeFound,
  rememberFound,
  saveSearchState,
} from '../../shared/search-cache';
import { listKey, loadList, mergeList, saveList } from '../../shared/list-cache';
import { searchCoverage, type SweepState } from '../../adapters/gemini/search';
import { lookupAll, readTakeout, type LookupProgress } from './takeout';
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
      /** Only the newest chats were read, `changed` of them new or changed; the others are remembered. */
      reachedKnown?: { changed: number };
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
  // Where the last search stopped: the next one goes on from there.
  const [sweep, setSweep] = useState<SweepState | null>(null);
  const keep = (now: SweepState) => {
    setSweep(now);
    void saveSearchState(platform, now);
  };
  useEffect(() => {
    if (platform === 'gemini') void loadSearchState(platform).then(setSweep);
  }, [platform]);
  const tab = useRef<number | null>(null);
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;
  const keepRef = useRef(keep);
  keepRef.current = keep;
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
          state?: SweepState;
        };
      };
      if (m?.target !== 'ui' || m.type !== 'search:progress' || m.payload?.platform !== platform) {
        return false;
      }
      // Each query's new chats join the table at once.
      if (m.payload.conversations?.length) onFoundRef.current(m.payload.conversations);
      if (m.payload.state) keepRef.current(m.payload.state);
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
      const resume = await loadSearchState(platform);
      const result = await sendToTab(target.tabId, 'conversations:search', {
        knownIds,
        ...(resume ? { resume } : {}),
      });
      onFound(result.conversations);
      keep(result.state);
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
  /** After "Forget them": the next search starts over. */
  const forget = () => setSweep(null);
  return { state, sweep, start, stop, forget };
}

/**
 * The platform's chats exported before, from the registry, read again shortly
 * after it changes (a bulk export records each chat as it saves it).
 */
function useSavedRecords(platform: Platform) {
  const [records, setRecords] = useState<(SavedRecord & { id: string; title: string })[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void send('background', 'registry:chats', { platform })
        .then((chats) => alive && Array.isArray(chats) && setRecords(chats))
        .catch(() => undefined);
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes.registry) return;
      clearTimeout(timer);
      timer = setTimeout(load, 1000);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [platform]);
  return records;
}

type TakeoutState =
  | { status: 'idle' }
  | { status: 'reading' }
  | { status: 'running'; progress: LookupProgress }
  | {
      status: 'done';
      added: number;
      known: number;
      missing: number;
      failed: number;
    }
  | { status: 'error'; message: string };

/**
 * Chats from the user's Google Takeout (takeout.ts): every chat the activity
 * links to that the table does not have yet is asked of the platform tab for
 * its title and date, more slowly once Gemini refuses. A stop ends after the
 * current batch, or a pause.
 */
function useTakeout(platform: Platform, onFound: (more: ConversationSummary[]) => void) {
  const [state, setState] = useState<TakeoutState>({ status: 'idle' });
  const stopped = useRef(false);
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const until = Date.now() + ms;
      const tick = () =>
        stopped.current || Date.now() >= until ? resolve() : setTimeout(tick, 250);
      tick();
    });
  const start = async (file: File, shown: ReadonlySet<string>) => {
    stopped.current = false;
    setState({ status: 'reading' });
    let tab: { tabId: number; opened: boolean } | null = null;
    try {
      const ids = await readTakeout(file);
      if (ids.length === 0) {
        setState({ status: 'error', message: t('exportTakeoutNone') });
        return;
      }
      const todo = ids.filter((id) => !shown.has(id));
      setState({ status: 'running', progress: { phase: 'first', done: 0, total: todo.length } });
      if (todo.length) tab = await send('background', 'platform:tab', { platform });
      const target = tab?.tabId;
      const counts =
        target === undefined
          ? { added: 0, missing: 0, failed: 0 }
          : await lookupAll(
              todo,
              (batch, atOnce) => sendToTab(target, 'conversations:lookup', { ids: batch, atOnce }),
              {
                onFound,
                onProgress: (progress) => setState({ status: 'running', progress }),
                stopped: () => stopped.current,
                sleep,
              },
            );
      setState({ status: 'done', known: ids.length - todo.length, ...counts });
    } catch (error) {
      setState({ status: 'error', message: errorText(error) });
    } finally {
      if (tab) {
        void send('background', 'platform:tab-done', tab).catch(() => undefined);
      }
    }
  };
  const stop = () => {
    stopped.current = true;
  };
  return { state, start, stop };
}

/**
 * The chat list, asked of the platform tab directly (see `platform:tab`).
 * `onTab` gets the tab, so the loading can be stopped there.
 */
async function listConversations(
  platform: Platform,
  onTab: (tabId: number | null) => void,
  known?: [string, string | null][],
) {
  const { tabId, opened } = await send('background', 'platform:tab', { platform });
  onTab(tabId);
  try {
    return await sendToTab(tabId, 'conversations:list', known ? { known } : {});
  } finally {
    onTab(null);
    void send('background', 'platform:tab-done', { tabId, opened }).catch(() => undefined);
  }
}

/**
 * The chat list. Gemini's is remembered (list-cache.ts): the next visit reads only
 * the chats newer than the remembered ones, unless `full` asks for all of it.
 * `gone` are chats the bulk export found deleted, not to be shown again.
 */
function useConversations(platform: Platform) {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [stopping, setStopping] = useState(false);
  const tab = useRef<number | null>(null);
  const read = async (full: boolean): Promise<ListState> => {
    const remembers = platform === 'gemini';
    const cached = remembers ? await loadList(platform) : null;
    const known =
      cached && !full
        ? cached.conversations.map((c): [string, string | null] => [c.id, c.updatedAt])
        : undefined;
    const list = await listConversations(platform, (tabId) => (tab.current = tabId), known);
    if (!remembers) {
      const { conversations, incomplete } = list;
      return { status: 'ready', conversations, ...(incomplete ? { incomplete } : {}) };
    }
    const merged = mergeList(list, cached);
    void saveList(platform, merged);
    setGone(new Set(merged.gone));
    const before = new Map(cached?.conversations.map((c) => [c.id, c.updatedAt]));
    const changed = list.conversations.filter(
      (c) => !before.has(c.id) || before.get(c.id) !== c.updatedAt,
    ).length;
    return {
      status: 'ready',
      conversations: merged.conversations,
      ...(list.incomplete ? { incomplete: list.incomplete } : {}),
      ...(list.reachedKnown ? { reachedKnown: { changed } } : {}),
    };
  };
  const load = (full = false) => {
    setState({ status: 'loading' });
    setStopping(false);
    read(full).then(setState, (error: unknown) =>
      setState({ status: 'error', message: errorText(error) }),
    );
  };
  // The bulk export drops chats that are gone and renews titles: follow it.
  useEffect(() => {
    if (platform !== 'gemini') return;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const change = changes[listKey(platform)];
      if (area !== 'local' || !change) return;
      const now = change.newValue as { conversations?: ConversationSummary[]; gone?: string[] };
      if (!Array.isArray(now?.conversations)) return;
      const byId = new Map(now.conversations.map((c) => [c.id, c]));
      const dropped = new Set(now.gone);
      setGone(dropped);
      setState((shown) =>
        shown.status === 'ready'
          ? {
              ...shown,
              conversations: shown.conversations
                .filter((c) => !dropped.has(c.id))
                .map((c) => byId.get(c.id) ?? c),
            }
          : shown,
      );
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [platform]);
  /** Ends the loading after the current page; the chats read so far are listed. */
  const stop = () => {
    if (tab.current === null) return;
    setStopping(true);
    void sendToTab(tab.current, 'conversations:list-stop', {}).catch(() => undefined);
  };
  useEffect(() => load(), []);
  return { list: state, gone, reload: load, stop, stopping };
}

const formatDate = (iso: string | null) => (iso ? localDateTime(iso) : '');

/** Stops the user caused (a Save As dialog closed): shown in grey, not as errors. */
const QUIET = new Set<string>(['save-cancelled', 'save-dialog', 'download-cancelled']);

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
      {job.stopReason && (
        <p class={QUIET.has(job.stopReason.code) ? 'muted' : 'error'}>{job.stopReason.message}</p>
      )}
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
  const { list, gone, reload, stop: stopList, stopping } = useConversations(platform);
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
  const listedIds = useMemo(
    () => new Set(list.status === 'ready' ? list.conversations.map((c) => c.id) : []),
    [list],
  );
  const extraOnly = useMemo(() => {
    if (list.status !== 'ready') return [];
    // A chat the list has now (it was updated, or the list went deeper) is shown once, from the list.
    return extra.filter((c) => !listedIds.has(c.id));
  }, [list, listedIds, extra]);

  // Chats exported before (the registry), read again as an export saves more.
  const records = useSavedRecords(platform);
  // Gemini chats exported before that neither the list nor the search has.
  const savedOnly = useMemo(() => {
    if (list.status !== 'ready' || platform !== 'gemini') return [];
    const shown = new Set([...listedIds, ...extraOnly.map((c) => c.id)]);
    return records
      .filter((c) => !shown.has(c.id) && !gone.has(c.id))
      .map((c): ConversationSummary => ({
        id: c.id,
        platform,
        title: c.title,
        createdAt: null,
        updatedAt: c.updatedAt,
        url: `https://gemini.google.com/app/${c.id}`,
        savedBefore: true,
      }));
  }, [list, platform, listedIds, extraOnly, records, gone]);

  const conversations = useMemo(
    () => (list.status === 'ready' ? [...list.conversations, ...extraOnly, ...savedOnly] : []),
    [list, extraOnly, savedOnly],
  );
  const addFound = (found: ConversationSummary[]) => {
    setExtra((previous) => mergeFound(previous, found));
    void rememberFound(platform, found);
  };
  const more = useSearchMore(platform, addFound);
  const takeout = useTakeout(platform, addFound);
  const takeoutFile = useRef<HTMLInputElement>(null);
  const fromTakeout = useMemo(() => extraOnly.filter((c) => c.fromTakeout).length, [extraOnly]);
  const forget = () => {
    setExtra([]);
    more.forget();
    void forgetFound(platform);
  };
  const takeoutBusy = takeout.state.status === 'reading' || takeout.state.status === 'running';
  const coverage = useMemo(
    () => (more.sweep ? searchCoverage(more.sweep.seen, listedIds) : null),
    [more.sweep, listedIds],
  );
  const savedById = useMemo(() => new Map(records.map((r) => [r.id, r])), [records]);
  const statusCounts = useMemo(() => {
    const counts: Record<SavedStatus, number> = { new: 0, saved: 0, changed: 0 };
    for (const c of conversations) counts[savedStatus(c, savedById.get(c.id))]++;
    return counts;
  }, [conversations, savedById]);
  const sourceCounts = useMemo(() => {
    const counts: Record<ChatSource, number> = { list: 0, search: 0, takeout: 0, saved: 0 };
    for (const c of conversations) counts[chatSource(c)]++;
    return counts;
  }, [conversations]);
  const visible = useMemo(
    () => filterConversations(conversations, filter, undefined, savedById),
    [conversations, filter, savedById],
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
          <span>{t('exportStatusFilter')}</span>
          <select
            value={filter.status}
            onChange={(e) =>
              setFilter({ ...filter, status: e.currentTarget.value as ListFilter['status'] })
            }
          >
            <option value="all">{t('exportStatusAll')}</option>
            <option value="new">{t('exportStatusNew', String(statusCounts.new))}</option>
            <option value="changed">
              {t('exportStatusChanged', String(statusCounts.changed))}
            </option>
            <option value="saved">{t('exportStatusSaved', String(statusCounts.saved))}</option>
          </select>
        </label>
        {platform === 'gemini' && (
          <label class="field">
            <span>{t('exportSourceFilter')}</span>
            <select
              value={filter.source}
              onChange={(e) =>
                setFilter({ ...filter, source: e.currentTarget.value as ListFilter['source'] })
              }
            >
              <option value="all">{t('exportSourceAll')}</option>
              <option value="list">{t('exportSourceList', String(sourceCounts.list))}</option>
              <option value="search">{t('exportSourceSearch', String(sourceCounts.search))}</option>
              <option value="takeout">
                {t('exportSourceTakeout', String(sourceCounts.takeout))}
              </option>
              <option value="saved">{t('exportSourceSaved', String(sourceCounts.saved))}</option>
            </select>
          </label>
        )}
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
          <button type="button" class="link" onClick={() => reload()}>
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
          <button type="button" class="link" onClick={() => reload(true)}>
            {list.incomplete.stopped ? t('exportListLoadAll') : t('exportRetry')}
          </button>
        </p>
      )}
      {list.status === 'ready' && list.reachedKnown && (
        <p class="muted">
          {t('exportListKept', [PLATFORM_LABEL[platform], String(list.reachedKnown.changed)])}{' '}
          <button type="button" class="link" onClick={() => reload(true)}>
            {t('exportListReadAll')}
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
              <button
                type="button"
                disabled={takeoutBusy}
                onClick={() => void more.start(conversations.map((c) => c.id))}
              >
                {more.state.status === 'idle' && !more.sweep
                  ? t('exportSearchMore')
                  : t('exportSearchAgain')}
              </button>
              {more.state.status === 'idle' && <small class="hint">{t('exportSearchHint')}</small>}
            </p>
          )}
          {takeout.state.status === 'running' ? (
            <p class="muted">
              {takeout.state.progress.phase === 'first'
                ? t('exportTakeoutRunning', [
                    String(takeout.state.progress.done),
                    String(takeout.state.progress.total),
                  ])
                : takeout.state.progress.waiting
                  ? t('exportTakeoutWaiting', String(takeout.state.progress.total))
                  : t('exportTakeoutAgain', [
                      String(takeout.state.progress.done),
                      String(takeout.state.progress.total),
                    ])}{' '}
              <button type="button" class="link" onClick={takeout.stop}>
                {t('exportSearchStop')}
              </button>
            </p>
          ) : (
            <p class="muted">
              {takeout.state.status === 'reading' && `${t('exportTakeoutReading')} `}
              {takeout.state.status === 'done' &&
                `${t('exportTakeoutDone', [
                  String(takeout.state.added),
                  String(takeout.state.known),
                  String(takeout.state.missing),
                ])} `}
              {takeout.state.status === 'done' && takeout.state.failed > 0 && (
                <span class="warn">{t('exportTakeoutFailed', String(takeout.state.failed))} </span>
              )}
              {takeout.state.status === 'error' && (
                <span class="error">{takeout.state.message} </span>
              )}
              <input
                ref={takeoutFile}
                type="file"
                accept=".json,.zip,application/json,application/zip"
                hidden
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = '';
                  if (file) void takeout.start(file, new Set(conversations.map((c) => c.id)));
                }}
              />
              <button
                type="button"
                disabled={takeout.state.status === 'reading' || more.state.status === 'running'}
                onClick={() => takeoutFile.current?.click()}
              >
                {t('exportTakeoutAdd')}
              </button>
              {takeout.state.status === 'idle' && (
                <small class="hint">{t('exportTakeoutHint')}</small>
              )}
            </p>
          )}
          {(extraOnly.length > 0 || savedOnly.length > 0) && (
            <p class="muted">
              {t('exportSources', [
                String(list.conversations.length),
                String(extraOnly.length - fromTakeout),
                String(fromTakeout),
                String(savedOnly.length),
              ])}
              {extraOnly.length > 0 && more.state.status !== 'running' && !takeoutBusy && (
                <>
                  {' '}
                  <button type="button" class="link" onClick={forget}>
                    {t('exportSearchForget')}
                  </button>
                </>
              )}
            </p>
          )}
          {coverage && (
            <p class="muted">
              {t('exportSearchCoverage', [
                String(Math.round(coverage.share * 100)),
                // Never fewer than the table already holds (found before the state was kept).
                String(Math.max(coverage.older, extraOnly.length + savedOnly.length)),
              ])}
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
                        {c.fromTakeout && <small class="hint"> {t('exportFromTakeout')}</small>}
                        {c.savedBefore && <small class="hint"> {t('exportSavedBefore')}</small>}
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
