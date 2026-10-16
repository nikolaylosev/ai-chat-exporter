import { fetchJson, HttpError, type FetchLike } from '../../util/http';
import {
  readConnectFrames,
  timelineFiles,
  TIMELINE_PATH,
  timelineRequestBody,
  type TimelineFiles,
} from './timeline';
import {
  conversationListSchema,
  conversationSchema,
  frameSchema,
  organizationsSchema,
  parseOrThrow,
  projectDocsSchema,
  projectFilesSchema,
  projectListSchema,
  projectSchema,
  sandboxFilesSchema,
  sessionSchema,
  type RawConversation,
  type RawConversationListItem,
  type RawFrame,
  type RawProject,
  type RawSandboxFile,
} from './schema';

/** Pages say "more" either at the top level or under `pagination`. */
function hasMore(page: {
  has_more?: boolean | undefined;
  pagination?: { has_more?: boolean | undefined } | undefined;
}) {
  return page.has_more ?? page.pagination?.has_more ?? false;
}

const CONVERSATION_QUERY = 'tree=True&rendering_mode=messages&render_all_tools=true';

/**
 * Thin client for the claude.ai REST endpoints in docs/platforms-claude.md. Runs in the
 * content script, so requests are same-origin and carry the user's cookies.
 */
/**
 * Pages of a list read by offset overlap by this many chats: a chat deleted or
 * archived while the list is read shifts the rest up by one, which would skip a
 * chat at the edge of a page. (A chat updated meanwhile moves to the top
 * instead; reading the first page again at the end finds it.)
 */
export const PAGE_OVERLAP = 5;

export class ClaudeApi {
  private orgIds: string[] | null = null;
  /** `workspace_session_id` of every conversation seen in a list page. */
  private readonly sessions = new Map<string, string | null>();
  /** An organization's whole list, read once when a chat is older than the first pages. */
  private readonly fullLists = new Map<string, Promise<unknown>>();
  /** Organization that owned the last conversation found, tried first next time. */
  private lastOrgId: string | null = null;

  constructor(
    private readonly fetchFn: FetchLike,
    readonly origin: string,
  ) {}

  private get(path: string, headers?: Record<string, string>): Promise<unknown> {
    return fetchJson(this.fetchFn, `${this.origin}${path}`, headers ? { headers } : {});
  }

  async organizations(): Promise<string[]> {
    if (!this.orgIds) {
      const raw = await this.get('/api/organizations');
      this.orgIds = parseOrThrow(organizationsSchema, raw, 'organizations').map((o) => o.uuid);
    }
    return this.orgIds;
  }

  /**
   * Fetches a conversation with every branch. A user can belong to several
   * organizations, so each is tried until one has the conversation.
   */
  async conversation(id: string): Promise<{ orgId: string; raw: RawConversation }> {
    const orgs = await this.organizations();
    const ordered = this.lastOrgId
      ? [this.lastOrgId, ...orgs.filter((o) => o !== this.lastOrgId)]
      : orgs;
    let lastError: HttpError | null = null;
    for (const orgId of ordered) {
      try {
        const raw = await this.get(
          `/api/organizations/${orgId}/chat_conversations/${id}?${CONVERSATION_QUERY}`,
        );
        this.lastOrgId = orgId;
        return { orgId, raw: parseOrThrow(conversationSchema, raw, 'conversation') };
      } catch (error) {
        // Another organization answers 403 or 404 for a conversation it does not own.
        // A signed-out user fails earlier, on /api/organizations.
        if (!(error instanceof HttpError) || (error.status !== 403 && error.status !== 404)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Conversation ${id} not found`);
  }

  async projectName(orgId: string, projectId: string): Promise<string> {
    const raw = await this.get(`/api/organizations/${orgId}/projects/${projectId}`);
    return parseOrThrow(projectSchema, raw, 'project').name;
  }

  /** Every project of every organization the user belongs to. */
  async allProjects(pageSize = 50): Promise<RawProject[]> {
    const result: RawProject[] = [];
    for (const orgId of await this.organizations()) {
      for (let offset = 0; ; offset += pageSize) {
        const raw = await this.get(
          `/api/organizations/${orgId}/projects_v2?limit=${pageSize}&offset=${offset}`,
        );
        const page = parseOrThrow(projectListSchema, raw, 'projects_v2');
        result.push(...page.data);
        if (!hasMore(page) || page.data.length === 0) break;
      }
    }
    return result;
  }

  /** A project, from whichever organization owns it (like conversation()). */
  async project(id: string): Promise<{ orgId: string; raw: RawProject }> {
    let lastError: HttpError | null = null;
    for (const orgId of await this.organizations()) {
      try {
        const raw = await this.get(`/api/organizations/${orgId}/projects/${id}`);
        return { orgId, raw: parseOrThrow(projectSchema, raw, 'project') };
      } catch (error) {
        if (!(error instanceof HttpError) || (error.status !== 403 && error.status !== 404)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Project ${id} not found`);
  }

  async projectDocs(orgId: string, projectId: string) {
    const raw = await this.get(`/api/organizations/${orgId}/projects/${projectId}/docs`);
    return parseOrThrow(projectDocsSchema, raw, 'project docs');
  }

  async projectFiles(orgId: string, projectId: string) {
    const raw = await this.get(`/api/organizations/${orgId}/projects/${projectId}/files`);
    return parseOrThrow(projectFilesSchema, raw, 'project files');
  }

  /** Every chat of a project, newest first. */
  async projectConversations(
    orgId: string,
    projectId: string,
    pageSize = 50,
  ): Promise<RawConversationListItem[]> {
    const result: RawConversationListItem[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const raw = await this.get(
        `/api/organizations/${orgId}/projects/${projectId}/conversations_v2?limit=${pageSize}&offset=${offset}`,
      );
      const page = parseOrThrow(conversationListSchema, raw, 'project conversations_v2');
      result.push(...page.data);
      if (!hasMore(page) || page.data.length === 0) break;
    }
    return result;
  }

  /** Download URL of an uploaded file, a knowledge file or a generated one. */
  fileUrl(orgId: string, fileUuid: string): string {
    return `${this.origin}/api/organizations/${orgId}/files/${fileUuid}/contents`;
  }

  /** One page of an organization's conversations, newest first. */
  async conversationPage(orgId: string, offset: number, limit: number) {
    const raw = await this.get(
      `/api/organizations/${orgId}/chat_conversations_v2?limit=${limit}&offset=${offset}`,
    );
    const page = parseOrThrow(conversationListSchema, raw, 'chat_conversations_v2');
    for (const item of page.data) this.sessions.set(item.uuid, item.workspace_session_id ?? null);
    return page;
  }

  /**
   * Every conversation of every organization, page by page, about 2 to 3 requests
   * per second at most. Pages overlap by PAGE_OVERLAP, and the first page is read
   * again at the end for chats that moved to the top meanwhile. `onPage` gets the
   * count so far; when `shouldStop` turns true, the pages read so far come back.
   */
  async allConversations(
    pageSize = 50,
    onPage?: (loaded: number) => void,
    shouldStop?: () => boolean,
  ): Promise<{ items: RawConversationListItem[]; stopped: boolean }> {
    const result: RawConversationListItem[] = [];
    const seen = new Set<string>();
    const add = (items: RawConversationListItem[]) =>
      items.filter((item) => !seen.has(item.uuid) && seen.add(item.uuid));
    for (const orgId of await this.organizations()) {
      let pages = 0;
      for (let offset = 0; ; offset += pageSize - PAGE_OVERLAP) {
        if (shouldStop?.()) return { items: result, stopped: true };
        const page = await this.conversationPage(orgId, offset, pageSize);
        pages++;
        result.push(...add(page.data));
        onPage?.(result.length);
        if (!hasMore(page) || page.data.length === 0) break;
      }
      if (pages > 1) {
        // Newest first: chats updated while the list was read go to the top.
        const first = await this.conversationPage(orgId, 0, pageSize);
        result.unshift(...add(first.data));
      }
    }
    return { items: result, stopped: false };
  }

  /**
   * The detail endpoint has no `workspace_session_id`, so look the conversation up in
   * the list, newest first. The conversation being exported is usually recent.
   */
  async workspaceSessionId(orgId: string, id: string, maxPages = 6): Promise<string | null> {
    if (this.sessions.has(id)) return this.sessions.get(id) ?? null;
    const pageSize = 50;
    for (let page = 0; page < maxPages; page++) {
      const list = await this.conversationPage(orgId, page * pageSize, pageSize);
      if (this.sessions.has(id)) return this.sessions.get(id) ?? null;
      if (!hasMore(list)) return null;
    }
    // Older than the first pages (a bulk export reaches such chats): read the
    // organization's whole list once; every later chat is then known.
    let full = this.fullLists.get(orgId);
    if (!full) {
      full = (async () => {
        for (let offset = 0; ; offset += pageSize - PAGE_OVERLAP) {
          const list = await this.conversationPage(orgId, offset, pageSize);
          if (!hasMore(list) || list.data.length === 0) break;
        }
      })();
      this.fullLists.set(orgId, full);
      full.catch(() => this.fullLists.delete(orgId));
    }
    await full;
    return this.sessions.get(id) ?? null;
  }

  /** Artifacts published from a cloud session: artifact id, title and short link. */
  async sessionArtifacts(orgId: string, sessionId: string) {
    const raw = await this.get(`/v1/code/sessions/${sessionId}`, {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgId,
    });
    return (
      parseOrThrow(sessionSchema, raw, 'session').response_shape.external_metadata?.artifacts ?? []
    );
  }

  /**
   * Files in an older chat's sandbox. Empty when the chat has none: session chats
   * answer 404 here.
   */
  async sandboxFiles(orgId: string, conversationId: string): Promise<RawSandboxFile[]> {
    try {
      const raw = await this.get(
        `/api/organizations/${orgId}/conversations/${conversationId}/wiggle/list-files`,
      );
      return parseOrThrow(sandboxFilesSchema, raw, 'list-files').files_metadata;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return [];
      throw error;
    }
  }

  /**
   * Saved copies of the files the model presented, by sandbox path, read from the
   * web app's timeline stream (`timeline.ts`).
   */
  async timelineFiles(conversationId: string, timeZone?: string): Promise<TimelineFiles> {
    const response = await this.fetchFn(`${this.origin}${TIMELINE_PATH}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/connect+proto',
        'connect-protocol-version': '1',
      },
      body: timelineRequestBody(conversationId, timeZone),
    });
    if (!response.ok || !response.body) throw new HttpError(response.status, TIMELINE_PATH);
    return timelineFiles(await readConnectFrames(response.body));
  }

  /** Download address of a file in an older chat's sandbox, as the web app uses it. */
  sandboxFileUrl(orgId: string, conversationId: string, path: string): string {
    const query = new URLSearchParams({ path });
    return `${this.origin}/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file?${query.toString()}`;
  }

  /** Metadata of one artifact version, with a token that opens its files. */
  async frame(orgId: string, artifactId: string, versionId?: string): Promise<RawFrame> {
    const ver = versionId ? `&ver=${encodeURIComponent(versionId)}` : '';
    const raw = await this.get(`/api/frame/${artifactId}?org=${orgId}${ver}`, {
      'X-Frame-CP': 'go',
    });
    return parseOrThrow(frameSchema, raw, 'frame');
  }

  /** Source of one artifact file as published. The token goes in the query; no cookies. */
  artifactFileUrl(artifactId: string, frame: RawFrame, path: string): string {
    const file = path.split('/').map(encodeURIComponent).join('/');
    return `https://${artifactId}.frame.claudeusercontent.com/_f/${frame.ver}/_src/${file}?__frame_t=${encodeURIComponent(frame.assetToken)}`;
  }

  async artifactFileText(url: string): Promise<string> {
    const response = await this.fetchFn(url, { credentials: 'omit' });
    if (!response.ok) throw new HttpError(response.status, url.split('?')[0] ?? url);
    return response.text();
  }
}
