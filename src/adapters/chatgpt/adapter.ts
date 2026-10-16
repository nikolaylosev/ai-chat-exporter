import type {
  Attachment,
  Conversation,
  ConversationList,
  ConversationOptions,
  ConversationSummary,
} from '../../model/conversation';
import type { Project, ProjectSummary } from '../../model/project';
import { fetchJson, HttpError, type FetchLike } from '../../util/http';
import { log } from '../../shared/logger';
import { ChatNotFoundError, parseOrThrowFor } from '../errors';
import type { PlatformAdapter } from '../types';
import { toConversation, type FileRef } from './normalize';
import {
  conversationListSchema,
  conversationSchema,
  downloadSchema,
  projectChatsSchema,
  projectDetailSchema,
  projectSidebarSchema,
  sessionSchema,
  type RawConversationItem,
} from './schema';
import { Pacer } from './pacer';
import { CHATGPT_ORIGIN, chatgptConversationId, chatgptProjectId } from './urls';

/** The most the list gives per page (101 is refused). */
const PAGE_SIZE = 100;
/** Pages overlap by this many chats, as Claude's (adapters/claude/api.ts). */
const PAGE_OVERLAP = 5;
const MAX_LIST_PAGES = 500;
const DEFAULT_OPTIONS: ConversationOptions = { artifactVersions: 'latest' };
/**
 * ChatGPT answers 429 to a run of quick requests (a Team workspace, 2026-10-15:
 * most of 16 conversations in a row, even 4 s apart) and lets go after a few
 * minutes; it sends no Retry-After. So: 15, 30, 60 and 120 s before giving up.
 */
const RETRY = { retries: 4, rateLimitDelayMs: 15_000 };
/** The usual gap between API requests; the pacer widens it after a 429. */
const MIN_GAP_MS = 500;

/** What the extension reads of a project (docs/platforms-chatgpt.md, Projects). */
export interface ChatgptProjectInfo {
  /** `g-p-<32 hex>`. */
  id: string;
  name: string;
  description: string;
  instructions: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** `g-p-<hex>-<slug>`: the project page is `/g/<shortUrl>/project`. */
  shortUrl: string;
  /** The project's own files, read loosely: none were seen. */
  files: unknown[];
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * A project from a sidebar entry (`{ gizmo: { gizmo, files } }`), a project's
 * details (`{ gizmo, files }`) or a flatter shape.
 */
export function projectOf(item: unknown): ChatgptProjectInfo | null {
  const outer = (item as { gizmo?: unknown } | null)?.gizmo as Record<string, unknown> | undefined;
  const nested = outer?.gizmo !== undefined;
  const gizmo = (nested ? outer.gizmo : outer) as Record<string, unknown> | undefined;
  const id = gizmo?.id;
  if (typeof id !== 'string' || !id) return null;
  const display = (gizmo.display ?? {}) as Record<string, unknown>;
  const name = str(display.name ?? gizmo.name).trim();
  const files = nested ? outer.files : (item as { files?: unknown }).files;
  return {
    id,
    name: name || id,
    description: str(display.description).trim(),
    instructions: str(gizmo.instructions).trim(),
    createdAt: str(gizmo.created_at) || null,
    updatedAt: str(gizmo.updated_at) || null,
    shortUrl: str(gizmo.short_url) || id,
    files: Array.isArray(files) ? (files as unknown[]) : [],
  };
}

/** A project file entry, read loosely: `file_id` or `id`, `name`, `type`, `size`. */
function projectFile(entry: unknown): Omit<Attachment, 'origin' | 'source'> | null {
  const f = (entry ?? {}) as Record<string, unknown>;
  const id = str(f.file_id) || str(f.id);
  if (!id) return null;
  const mime = str(f.type) || str(f.mime_type);
  const size =
    typeof f.size === 'number' ? f.size : typeof f.file_size === 'number' ? f.file_size : null;
  return {
    id,
    name: str(f.name) || str(f.file_name) || id,
    ...(mime ? { mime } : {}),
    ...(size !== null ? { size } : {}),
  };
}

const parse = <T>(
  schema: Parameters<typeof parseOrThrowFor<T>>[1],
  value: unknown,
  where: string,
) => parseOrThrowFor('chatgpt.com', schema, value, where);

/**
 * Reads ChatGPT through `/backend-api/` (docs/platforms-chatgpt.md). Runs in the
 * content script on chatgpt.com. Every request carries the session's access
 * token, which is kept in memory only and never stored or logged.
 */
export class ChatgptAdapter implements PlatformAdapter {
  readonly platform = 'chatgpt' as const;
  private token: Promise<string> | null = null;
  /** Where the files of the last few conversations come from, for a new link later. */
  private readonly fileRefs = new Map<string, Map<string, FileRef>>();
  /** Project names by id, from the sidebar or a project's details. */
  private readonly projectNames = new Map<string, string>();

  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pacer: Pacer;

  constructor(
    private readonly fetchFn: FetchLike,
    private readonly currentUrl: () => string,
    private readonly origin = CHATGPT_ORIGIN,
    {
      sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      minGapMs = MIN_GAP_MS,
    }: { sleep?: (ms: number) => Promise<void>; minGapMs?: number } = {},
  ) {
    this.sleep = sleep;
    this.pacer = new Pacer(minGapMs, sleep);
  }

  getCurrentConversationId(): string | null {
    return chatgptConversationId(this.currentUrl());
  }

  /**
   * Every conversation: the history by last update, then archived chats, then
   * chats inside projects, which the history leaves out. Projects are read
   * loosely (unverified), and a failure there leaves the rest of the list.
   */
  async listConversations(
    onProgress?: (loaded: number) => void,
    shouldStop?: () => boolean,
  ): Promise<ConversationList> {
    const byId = new Map<string, ConversationSummary>();
    // Checked before each request after the first: the history so far, then the
    // archive and the projects only if the user did not stop.
    const stopped = () => byId.size > 0 && Boolean(shouldStop?.());
    const partial = (): ConversationList => ({
      conversations: [...byId.values()],
      incomplete: { loaded: byId.size, stopped: true },
    });
    const add = (c: RawConversationItem, extra: Partial<ConversationSummary> = {}) => {
      const known = byId.get(c.id);
      if (known) {
        Object.assign(known, extra);
        return;
      }
      byId.set(c.id, {
        id: c.id,
        platform: 'chatgpt',
        title: c.title ?? '',
        createdAt: c.create_time ?? null,
        updatedAt: c.update_time ?? null,
        url: this.chatUrl(c.id),
        ...extra,
      });
    };
    const page = async (offset: number, archived: boolean) => {
      const query = new URLSearchParams({
        offset: String(offset),
        limit: String(PAGE_SIZE),
        order: 'updated',
        ...(archived ? { is_archived: 'true' } : {}),
      });
      const list = parse(
        conversationListSchema,
        await this.get(`/backend-api/conversations?${query.toString()}`),
        'conversations',
      );
      for (const c of list.items) add(c, archived ? { archived: true } : {});
      onProgress?.(byId.size);
      return list.items.length;
    };
    for (const archived of [false, true]) {
      // Pages overlap: a chat deleted or archived meanwhile shifts the rest up by one.
      let pages = 0;
      for (; pages < MAX_LIST_PAGES; pages++) {
        if (stopped()) return partial();
        // `total` is not a count of chats (section 3): a short page is the last one.
        if ((await page(pages * (PAGE_SIZE - PAGE_OVERLAP), archived)) < PAGE_SIZE) break;
      }
      // Chats updated while the history was read are at its top now.
      if (!archived && pages > 0) {
        if (stopped()) return partial();
        await page(0, false);
      }
    }
    try {
      if (stopped()) return partial();
      for (const project of await this.projects()) {
        if (stopped()) return partial();
        await this.projectChats(project.id, (c) => add(c, { project: project.name }));
        onProgress?.(byId.size);
      }
    } catch (error) {
      if (error instanceof HttpError && error.isAuth) throw error;
      log.warn('ChatGPT projects not read', error);
    }
    return { conversations: [...byId.values()] };
  }

  /** Projects in the sidebar, by cursor; custom GPTs there are left out. */
  private async projects(): Promise<ChatgptProjectInfo[]> {
    const out: ChatgptProjectInfo[] = [];
    let cursor: string | number | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams({ conversations_per_gizmo: '0' });
      if (cursor !== null) query.set('cursor', String(cursor));
      const sidebar: { items: unknown[]; cursor?: string | number | null | undefined } = parse(
        projectSidebarSchema,
        await this.get(`/backend-api/gizmos/snorlax/sidebar?${query.toString()}`),
        'snorlax.sidebar',
      );
      for (const item of sidebar.items) {
        const project = projectOf(item);
        if (project?.id.startsWith('g-p-') && !out.some((p) => p.id === project.id)) {
          out.push(project);
          this.projectNames.set(project.id, project.name);
        }
      }
      if (sidebar.cursor === null || sidebar.cursor === undefined || !sidebar.items.length) break;
      cursor = sidebar.cursor;
    }
    return out;
  }

  private async projectChats(id: string, add: (c: RawConversationItem) => void): Promise<void> {
    let cursor: string | number = 0;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const chats: { items: RawConversationItem[]; cursor?: string | number | null | undefined } =
        parse(
          projectChatsSchema,
          await this.get(
            // As the project page asks (2026-10-16): chats shared with the user too.
            `/backend-api/gizmos/${encodeURIComponent(id)}/conversations?${new URLSearchParams({
              limit: '50',
              owned_only: 'false',
              ...(cursor !== 0 ? { cursor: String(cursor) } : {}),
            }).toString()}`,
          ),
          'gizmos.conversations',
        );
      chats.items.forEach(add);
      if (chats.cursor === null || chats.cursor === undefined || !chats.items.length) break;
      cursor = chats.cursor;
    }
  }

  async getConversation(
    id: string,
    options: ConversationOptions = DEFAULT_OPTIONS,
  ): Promise<Conversation> {
    const raw = parse(
      conversationSchema,
      await this.get(`/backend-api/conversation/${id}`),
      'conversation',
    );
    const { conversation, files, extracted } = toConversation(raw, {
      url: this.chatUrl(id),
      options,
    });
    if (raw.gizmo_id?.startsWith('g-p-')) {
      const project = await this.projectName(raw.gizmo_id);
      if (project) conversation.project = project;
    }
    this.fileRefs.delete(id);
    this.fileRefs.set(id, files);
    // The links are needed while the conversation's files are written; keep a few.
    while (this.fileRefs.size > 3)
      this.fileRefs.delete(this.fileRefs.keys().next().value as string);
    const attachments = [
      ...conversation.messages,
      ...conversation.branches.flatMap((b) => b.messages),
    ].flatMap((m) => m.attachments);
    for (const attachment of attachments) {
      const ref = files.get(attachment.id);
      if (!ref) continue;
      const url = await this.downloadUrl(id, ref);
      const text = extracted.get(attachment.id);
      if (url) attachment.source = { kind: 'url', url };
      else if (text) {
        // A long pasted text, for one, is never given as a file (404); its extracted text is.
        attachment.source = { kind: 'text', text: text.text, mime: 'text/plain' };
        attachment.note = text.complete ? 'extracted-text-only' : 'extracted-text-partial';
      } else attachment.note = 'unavailable';
    }
    return conversation;
  }

  /** Projects for the export page's Projects tab. */
  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.projects()).map((p) => this.projectSummary(p));
  }

  /**
   * A project with its instructions, its own files and its chats. The files get
   * signed links like a conversation's; the job writes them first, right after.
   */
  async getProject(id: string): Promise<Project> {
    const info = await this.projectInfo(id);
    if (!info) throw new ChatNotFoundError('chatgpt.com', id);
    const knowledge: Attachment[] = [];
    for (const file of info.files.map(projectFile)) {
      if (!file) continue;
      const url = await this.downloadUrl(null, { kind: 'file', fileId: file.id });
      knowledge.push({
        ...file,
        origin: 'project-knowledge',
        source: url ? { kind: 'url', url } : null,
      });
    }
    const conversations: ConversationSummary[] = [];
    await this.projectChats(id, (c) =>
      conversations.push({
        id: c.id,
        platform: 'chatgpt',
        title: c.title ?? '',
        createdAt: c.create_time ?? null,
        updatedAt: c.update_time ?? null,
        url: this.chatUrl(c.id),
        project: info.name,
      }),
    );
    return {
      ...this.projectSummary(info),
      knowledgeCount: knowledge.length,
      instructions: info.instructions,
      knowledge,
      conversations,
    };
  }

  /** The project of the open project page or project chat; null elsewhere. */
  async getCurrentProject(): Promise<{ id: string; name: string } | null> {
    let id = chatgptProjectId(this.currentUrl());
    const chat = id ? null : this.getCurrentConversationId();
    if (chat) {
      const raw = parse(
        conversationSchema,
        await this.get(`/backend-api/conversation/${chat}`),
        'conversation',
      );
      if (raw.gizmo_id?.startsWith('g-p-')) id = raw.gizmo_id;
    }
    if (!id) return null;
    const name = await this.projectName(id);
    return name ? { id, name } : null;
  }

  /** A project's details (`gizmos/{id}`), or null when ChatGPT has no such project. */
  private async projectInfo(id: string): Promise<ChatgptProjectInfo | null> {
    let raw: unknown;
    try {
      raw = await this.get(`/backend-api/gizmos/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
    const info = projectOf(parse(projectDetailSchema, raw, 'gizmos'));
    if (info) this.projectNames.set(info.id, info.name);
    return info;
  }

  /** A project's name for a chat's note; a project that cannot be read leaves it out. */
  private async projectName(id: string): Promise<string | null> {
    if (!this.projectNames.has(id)) {
      try {
        await this.projectInfo(id);
      } catch (error) {
        if (error instanceof HttpError && (error.isAuth || error.status === 429)) throw error;
        log.info('ChatGPT project not read', error);
      }
    }
    return this.projectNames.get(id) ?? null;
  }

  private projectSummary(p: ChatgptProjectInfo): ProjectSummary {
    return {
      id: p.id,
      platform: 'chatgpt',
      name: p.name,
      description: p.description,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      url: `${this.origin}/g/${p.shortUrl}/project`,
      knowledgeCount: p.files.length,
    };
  }

  /**
   * A new signed link for a file of a conversation read before: the first one may
   * have expired while the conversation's other files were written.
   */
  async fileLink(conversationId: string, attachmentId: string): Promise<string | null> {
    const ref = this.fileRefs.get(conversationId)?.get(attachmentId);
    return ref ? this.downloadUrl(conversationId, ref) : null;
  }

  /**
   * A signed link to a file, or null when ChatGPT no longer has it. The link
   * works without the token, so the browser can download it like any other.
   */
  private async downloadUrl(conversationId: string | null, ref: FileRef): Promise<string | null> {
    if (ref.kind !== 'file' && !conversationId) return null;
    const path =
      ref.kind === 'file'
        ? `/backend-api/files/download/${encodeURIComponent(ref.fileId)}?${new URLSearchParams({
            // A project's own file belongs to no conversation.
            ...(conversationId ? { conversation_id: conversationId } : {}),
            inline: 'false',
          }).toString()}`
        : `/backend-api/conversation/${conversationId}/interpreter/download?${new URLSearchParams({
            message_id: ref.messageId,
            sandbox_path: ref.path,
          }).toString()}`;
    let raw: unknown;
    try {
      raw = await this.get(path);
    } catch (error) {
      // A rate limit is not a missing file: it stops the export instead.
      if (error instanceof HttpError && !error.isAuth && error.status !== 429) {
        log.info('ChatGPT file link not given', error.status);
        return null;
      }
      throw error;
    }
    const answer = parse(downloadSchema, raw, 'files.download');
    if (answer.status !== 'success' || !answer.download_url) {
      log.info('ChatGPT file link not given', answer.error_code ?? answer.status);
      return null;
    }
    return new URL(answer.download_url, this.origin).href;
  }

  /** Every API request waits its turn, and its status tunes the gap. */
  private readonly paced: FetchLike = async (url, init) => {
    await this.pacer.turn();
    const response = await this.fetchFn(url, init);
    this.pacer.observe(response.status);
    return response;
  };

  /** GET with the access token; a rejected token is fetched again once. */
  private async get(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      try {
        return await fetchJson(
          this.paced,
          `${this.origin}${path}`,
          { headers: { authorization: `Bearer ${token}` } },
          { ...RETRY, sleep: this.sleep },
        );
      } catch (error) {
        if (error instanceof HttpError && error.status === 401 && attempt === 0) {
          this.token = null;
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * The session's access token. Without it the API answers as if there were no
   * chats, so a missing token means the user is signed out.
   */
  private accessToken(): Promise<string> {
    if (!this.token) {
      const pending = (async () => {
        const url = `${this.origin}/api/auth/session`;
        const session = parse(sessionSchema, await fetchJson(this.fetchFn, url), 'session');
        if (!session.accessToken) throw new HttpError(401, url);
        return session.accessToken;
      })();
      this.token = pending;
      // A failed attempt is not kept: the next call asks again.
      pending.catch(() => {
        if (this.token === pending) this.token = null;
      });
    }
    return this.token;
  }

  private chatUrl(id: string): string {
    return `${this.origin}/c/${id}`;
  }
}
