import type { Conversation, ConversationList, ConversationSummary } from '../../model/conversation';
import type { Project, ProjectSummary } from '../../model/project';
import { ChatNotFoundError, PlatformBusyError } from '../errors';
import type { PlatformAdapter } from '../types';
import { BatchExecute } from './batchexecute';
import { toConversation } from './normalize';
import {
  at,
  readGems,
  readHistoryPage,
  readListPage,
  readNotebook,
  readNotebooks,
  type RawListEntry,
  type RawNotebook,
  type RawTurn,
} from './parse';
import {
  discoverSignature,
  GEMINI_SCRIPT_ORIGINS,
  readSearchAnswer,
  SEARCH_SIGNATURE,
  seedWords,
  sweepSearch,
  type SearchHit,
  type SweepEnd,
  type SweepState,
} from './search';
import { accountPrefixOf, GEMINI_ORIGIN, geminiNotebookId, parseGeminiUrl } from './urls';
import { fetchJson, HttpError, type FetchLike } from '../../util/http';

/** History pages are 10 turns; this caps a conversation at 5,000 turns. */
const MAX_HISTORY_PAGES = 500;
const MAX_LIST_PAGES = 1000;
const LIST_FILTER = [null, null, 1, null, null, null, null, null, null, 1];
/**
 * Chats per page of the list: the most Gemini gives. A page costs about the
 * same whatever its size, more the deeper it is (2026-10-28), so big pages
 * reach deeper before Gemini gives up.
 */
const LIST_PAGE_SIZE = 100;
/**
 * Pauses before each try of one page. A deep page fails with status 13 when
 * Gemini spends its 10 seconds on it; the same page may pass on the next try.
 */
const LIST_WAITS_MS = [0, 2000, 5000, 10000, 15000, 20000];
/** One chat's entry takes about half a second whatever its age (2026-10-28). */
const LOOKUP_AT_ONCE = 4;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads Gemini through `batchexecute` (docs/platforms-gemini.md). Runs in the
 * content script on gemini.google.com.
 */
export class GeminiAdapter implements PlatformAdapter {
  readonly platform = 'gemini' as const;
  private readonly rpc: BatchExecute;
  private gems: Promise<Map<string, string>> | null = null;
  private readonly prefix: string;
  private searchSignature: string | null = null;

  constructor(
    private readonly fetchFn: FetchLike,
    private readonly currentUrl: () => string,
    private readonly origin = GEMINI_ORIGIN,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.prefix = accountPrefixOf(currentUrl());
    this.rpc = new BatchExecute(fetchFn, origin, { accountPrefix: this.prefix, sleep });
  }

  /**
   * Chats the list did not return, found through Gemini's search
   * (`search.ts`). `known` holds the ids already listed. `scriptUrls` gives the
   * page's scripts, to find the search query again if Gemini renamed it.
   */
  async searchConversations(
    known: ReadonlySet<string>,
    options: {
      maxQueries?: number;
      /** Where an earlier search stopped. */
      resume?: SweepState;
      /** The Gemini page's language (`de-DE`): its seed words start the search. */
      language?: string;
      /** After each query; `conversations` are the new chats it found. */
      onProgress?: (progress: {
        found: number;
        queries: number;
        conversations: ConversationSummary[];
        state?: SweepState;
      }) => void;
      shouldStop?: () => boolean;
      scriptUrls?: () => string[];
    } = {},
  ): Promise<{
    conversations: ConversationSummary[];
    queries: number;
    end: SweepEnd;
    state: SweepState;
  }> {
    let signature = this.searchSignature ?? SEARCH_SIGNATURE;
    let rediscovered = false;
    const search = async (query: string): Promise<SearchHit[]> => {
      for (;;) {
        const url = `${this.origin}${this.prefix}/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery?${new URLSearchParams(
          {
            query_signature: signature,
            variables: JSON.stringify({ includeEnterpriseStatus: true, query, queryEmpty: false }),
          },
        ).toString()}`;
        try {
          const answer = await fetchJson(this.fetchFn, url, {}, { sleep: this.sleep });
          const failed = (answer as { errors?: unknown }[] | null)?.[0]?.errors;
          if (!failed) return readSearchAnswer(answer);
        } catch (error) {
          if (!(error instanceof HttpError) || error.status >= 500 || error.isAuth) throw error;
        }
        // The known query no longer answers: look for its new name once.
        if (rediscovered)
          throw new PlatformBusyError('gemini.google.com', 'search query not found');
        rediscovered = true;
        const found = await discoverSignature(this.fetchFn, options.scriptUrls?.() ?? [], [
          this.origin,
          ...GEMINI_SCRIPT_ORIGINS,
        ]);
        if (!found || found === signature) {
          throw new PlatformBusyError('gemini.google.com', 'search query not found');
        }
        signature = found;
        this.searchSignature = found;
      }
    };
    const summary = (hit: SearchHit): ConversationSummary => ({
      id: hit.id,
      platform: 'gemini',
      title: hit.title,
      createdAt: null,
      updatedAt: hit.timestamp,
      url: this.chatUrl(hit.id, null),
      foundBySearch: true,
    });
    const onProgress = options.onProgress;
    const { hits, queries, end, state } = await sweepSearch(search, {
      known,
      sleep: this.sleep,
      ...(options.resume ? { resume: options.resume } : {}),
      seeds: seedWords(options.language),
      ...(options.maxQueries ? { maxQueries: options.maxQueries } : {}),
      ...(onProgress
        ? {
            onProgress: ({ found, queries: asked, hits: added, state: now }) =>
              onProgress({
                found,
                queries: asked,
                conversations: added.map(summary),
                ...(now ? { state: now } : {}),
              }),
          }
        : {}),
      ...(options.shouldStop ? { shouldStop: options.shouldStop } : {}),
    });
    return { conversations: hits.map(summary), queries, end, state };
  }

  getCurrentConversationId(): string | null {
    return parseGeminiUrl(this.currentUrl())?.id ?? null;
  }

  /**
   * Every conversation, pinned first, then by last update. When Gemini stops
   * answering partway, the chats read so far come back marked incomplete. With
   * `known`, the reading stops after the first page holding a chat the caller
   * has with the same update time and not pinned: every chat after it is older
   * and unchanged (a changed chat moves to the top). With `until`, it stops
   * after the first page holding a chat, not pinned, last updated before then.
   */
  async listConversations(
    onProgress?: (loaded: number) => void,
    shouldStop?: () => boolean,
    known?: ReadonlyMap<string, string | null>,
    until?: string,
  ): Promise<ConversationList> {
    const gems = await this.gemNames();
    const result: ConversationSummary[] = [];
    // A chat that moves while the list is read may show up on two pages.
    const seen = new Set<string>();
    let token: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      if (page > 0 && shouldStop?.()) {
        return { conversations: result, incomplete: { loaded: result.length, stopped: true } };
      }
      let raw: unknown = null;
      let busy: PlatformBusyError | null = null;
      for (const wait of LIST_WAITS_MS) {
        if (wait) await this.sleep(wait);
        try {
          raw = await this.rpc.call('MaZiqc', [LIST_PAGE_SIZE, token, LIST_FILTER], '/app', {
            retries: 0,
          });
          busy = null;
          break;
        } catch (error) {
          // A server error that outlasted the retries counts as busy too; signed out does not.
          if (error instanceof HttpError && !error.isAuth) {
            busy = new PlatformBusyError('gemini.google.com', error.message);
            continue;
          }
          if (!(error instanceof PlatformBusyError)) throw error;
          busy = error;
        }
      }
      if (busy) {
        if (result.length === 0) throw busy;
        return { conversations: result, incomplete: { loaded: result.length } };
      }
      const { entries, next } = readListPage(raw);
      const reachedKnown = entries.some(
        (e) => !e.pinned && known?.has(e.id) && known.get(e.id) === e.updatedAt,
      );
      const reachedUntil = Boolean(
        until && entries.some((e) => !e.pinned && e.updatedAt !== null && e.updatedAt < until),
      );
      for (const e of entries) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const gem = e.gemId ? (gems.get(e.gemId) ?? e.gemId) : undefined;
        result.push({
          id: e.id,
          platform: 'gemini',
          title: e.title,
          // The list knows only the last update; the creation date comes with the history.
          createdAt: null,
          updatedAt: e.updatedAt,
          url: this.chatUrl(e.id, e.gemId),
          ...(gem ? { project: gem } : {}),
        });
      }
      onProgress?.(result.length);
      if (reachedKnown || reachedUntil) return { conversations: result, reachedKnown: true };
      if (!next || entries.length === 0) break;
      token = next;
    }
    return { conversations: result };
  }

  /**
   * Chats by id, as the list would give them (ids from Google Takeout reach
   * chats past the list's depth). One request per chat, a few at a time. An id
   * Gemini has no entry for is `missing` (the chat was deleted); one that kept
   * failing is `failed`, to be asked again later. Signed out throws. `atOnce`
   * lowers the pace when Gemini refuses.
   */
  async lookupConversations(
    ids: readonly string[],
    atOnce = LOOKUP_AT_ONCE,
  ): Promise<{ conversations: ConversationSummary[]; missing: string[]; failed: string[] }> {
    const gems = await this.gemNames();
    const found = new Map<string, ConversationSummary>();
    const missing: string[] = [];
    const failed: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        let entry: RawListEntry | null;
        try {
          entry = await this.listEntry(id);
        } catch (error) {
          if (error instanceof PlatformBusyError || (error instanceof HttpError && !error.isAuth)) {
            failed.push(id);
            continue;
          }
          throw error;
        }
        if (!entry) {
          missing.push(id);
          continue;
        }
        const gem = entry.gemId ? (gems.get(entry.gemId) ?? entry.gemId) : undefined;
        found.set(id, {
          id,
          platform: 'gemini',
          title: entry.title,
          createdAt: null,
          updatedAt: entry.updatedAt,
          url: this.chatUrl(id, entry.gemId),
          fromTakeout: true,
          ...(gem ? { project: gem } : {}),
        });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, atOnce) }, worker));
    // In the order asked.
    const conversations = ids.flatMap((id) => found.get(id) ?? []);
    return { conversations, missing, failed };
  }

  async getConversation(id: string): Promise<Conversation> {
    const sourcePath = `/app/${id}`;
    const [entry, turns] = await Promise.all([this.listEntry(id), this.history(id, sourcePath)]);
    if (turns.length === 0 && !entry) {
      throw new ChatNotFoundError('gemini.google.com', id);
    }
    const gemId = entry?.gemId ?? null;
    const gem = gemId ? ((await this.gemNames()).get(gemId) ?? gemId) : undefined;
    return toConversation(turns, {
      id,
      title: entry?.title ?? '',
      updatedAt: entry?.updatedAt ?? null,
      url: this.chatUrl(id, gemId),
      ...(gem ? { gem } : {}),
    });
  }

  /** All turns, oldest first: pages come newest first, 10 turns each. */
  private async history(id: string, sourcePath: string): Promise<RawTurn[]> {
    const pages: RawTurn[][] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const raw = await this.rpc.call(
        'hNvQHb',
        [`c_${id}`, 10, token, 1, [1], [4], null, 1],
        sourcePath,
      );
      // No payload: nothing more (or no such chat, decided by the caller).
      if (raw === null) break;
      const { turns, next } = readHistoryPage(raw, `hNvQHb[${page}]`);
      pages.push(turns);
      if (!next || turns.length === 0) break;
      token = next;
    }
    return pages.flat().reverse();
  }

  private async listEntry(id: string) {
    const raw = await this.rpc.call('MaZiqc', [1, null, [null, null, 1, null, 1, `c_${id}`]]);
    return readListPage(raw).entries.find((e) => e.id === id) ?? null;
  }

  /**
   * Names of Google's Gems, the user's own and the user's notebooks (a chat of a
   * notebook names `notebooks/<uuid>` where others name their Gem); an unknown
   * one keeps its id.
   */
  private gemNames(): Promise<Map<string, string>> {
    this.gems ??= Promise.all([
      this.rpc.call('CNgdBe', [1, ['en'], 0]).catch(() => null),
      this.rpc.call('CNgdBe', [2, ['en'], 0]).catch(() => null),
      this.notebooks().catch(() => []),
    ]).then(
      ([premade, own, notebooks]) =>
        new Map([
          ...readGems(premade),
          ...readGems(own),
          ...notebooks.map((n): [string, string] => [`notebooks/${n.id}`, n.name]),
        ]),
    );
    return this.gems;
  }

  /** The user's notebooks (docs/platforms-gemini.md, Notebooks): Gems of another kind. */
  private async notebooks(): Promise<RawNotebook[]> {
    return readNotebooks(await this.rpc.call('CNgdBe', [2, ['en'], 0, null, [2]]));
  }

  /** Notebooks, as projects: the export page lists them, a job exports them with their chats. */
  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.notebooks()).map((n) => this.notebookSummary(n));
  }

  /**
   * A notebook with its sources and every chat it holds. Gemini keeps a source
   * without a download (the files live in NotebookLM), so a source is listed by
   * name only.
   */
  async getProject(id: string): Promise<Project> {
    const raw = readNotebook(
      at(await this.rpc.call('HcT8bb', [`notebooks/${id}`, ['en'], 1], `/notebook/${id}`), 0),
    );
    if (!raw) throw new ChatNotFoundError('gemini.google.com', `notebooks/${id}`);
    const conversations: ConversationSummary[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const { entries, next } = readListPage(
        await this.rpc.call(
          'MaZiqc',
          [20, token, [null, null, 1, `notebooks/${id}`, 1]],
          `/notebook/${id}`,
        ),
      );
      for (const e of entries) {
        conversations.push({
          id: e.id,
          platform: 'gemini',
          title: e.title,
          createdAt: null,
          updatedAt: e.updatedAt,
          url: this.chatUrl(e.id, e.gemId),
          project: raw.name,
        });
      }
      if (!next || entries.length === 0) break;
      token = next;
    }
    return {
      ...this.notebookSummary(raw),
      instructions: '',
      knowledge: raw.sources.map((s) => ({
        id: s.id,
        name: s.name || 'source',
        ...(s.mime ? { mime: s.mime } : {}),
        origin: 'project-knowledge' as const,
        source: null,
        note: 'unavailable' as const,
      })),
      conversations,
    };
  }

  /** The notebook of the open notebook page, or of the open chat when it is a notebook's. */
  async getCurrentProject(): Promise<{ id: string; name: string } | null> {
    let id = geminiNotebookId(this.currentUrl());
    const chat = id ? null : parseGeminiUrl(this.currentUrl())?.id;
    if (chat) {
      const gemId = (await this.listEntry(chat))?.gemId;
      if (gemId?.startsWith('notebooks/')) id = gemId.slice('notebooks/'.length);
    }
    if (!id) return null;
    const raw = readNotebook(
      at(await this.rpc.call('HcT8bb', [`notebooks/${id}`, ['en'], 1], `/notebook/${id}`), 0),
    );
    return raw ? { id, name: raw.name } : null;
  }

  private notebookSummary(n: RawNotebook): ProjectSummary {
    return {
      id: n.id,
      platform: 'gemini',
      name: n.name,
      description: '',
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      url: `${this.origin}${this.prefix}/notebook/${n.id}`,
      knowledgeCount: n.sources.length,
    };
  }

  private chatUrl(id: string, gemId: string | null): string {
    // A notebook's chat opens like any other: the page finds its notebook.
    return gemId && !gemId.startsWith('notebooks/')
      ? `${this.origin}${this.prefix}/gem/${gemId}/${id}`
      : `${this.origin}${this.prefix}/app/${id}`;
  }
}
