import type {
  Attachment,
  Conversation,
  ConversationList,
  ConversationSummary,
} from '../../model/conversation';
import type { Project, ProjectSummary } from '../../model/project';
import { log } from '../../shared/logger';
import { fetchJson, HttpError, type FetchLike } from '../../util/http';
import { ChatNotFoundError, parseOrThrowFor } from '../errors';
import type { PlatformAdapter } from '../types';
import { toConversation, workspaceName } from './normalize';
import {
  assetListSchema,
  conversationListSchema,
  conversationSchema,
  responseNodesSchema,
  responsesSchema,
  workspaceListSchema,
  workspaceSchema,
  type RawResponse,
} from './schema';
import { GROK_ASSETS_ORIGIN, GROK_ORIGIN, grokProjectId, parseGrokUrl } from './urls';

const PAGE_SIZE = 60;
const MAX_LIST_PAGES = 200;
/** Responses asked for in one `load-responses` call. */
const RESPONSES_PER_CALL = 100;
/** Where a project's instructions may be: Grok leaves empty fields out, none was seen filled. */
const INSTRUCTION_FIELDS = [
  'instructions',
  'customInstructions',
  'customPersonality',
  'systemPrompt',
];

type RawWorkspace = ReturnType<typeof workspaceSchema.parse>;

const parse = <T>(
  schema: Parameters<typeof parseOrThrowFor<T>>[1],
  value: unknown,
  where: string,
) => parseOrThrowFor('grok.com', schema, value, where);

/**
 * Reads Grok through its REST API (docs/platforms-grok.md). Runs in the content
 * script on grok.com, so requests are same-origin and carry the user's cookies.
 */
export class GrokAdapter implements PlatformAdapter {
  readonly platform = 'grok' as const;

  constructor(
    private readonly fetchFn: FetchLike,
    private readonly currentUrl: () => string,
    private readonly origin = GROK_ORIGIN,
    private readonly assetsOrigin = GROK_ASSETS_ORIGIN,
  ) {}

  private get(path: string): Promise<unknown> {
    return fetchJson(this.fetchFn, `${this.origin}${path}`);
  }

  getCurrentConversationId(): string | null {
    return parseGrokUrl(this.currentUrl())?.id ?? null;
  }

  /** Every conversation, newest first, as the sidebar lists them. */
  async listConversations(
    onProgress?: (loaded: number) => void,
    shouldStop?: () => boolean,
  ): Promise<ConversationList> {
    const result: ConversationSummary[] = [];
    const seen = new Set<string>();
    let token: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      if (page > 0 && shouldStop?.()) {
        return { conversations: result, incomplete: { loaded: result.length, stopped: true } };
      }
      const query = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
      if (token) query.set('pageToken', token);
      const raw = await this.get(`/rest/app-chat/conversations?${query.toString()}`);
      const list = parse(conversationListSchema, raw, 'conversations');
      for (const c of list.conversations) {
        if (seen.has(c.conversationId)) continue;
        seen.add(c.conversationId);
        const project = workspaceName(c.workspaces);
        result.push({
          id: c.conversationId,
          platform: 'grok',
          title: c.title,
          createdAt: c.createTime ?? null,
          updatedAt: c.modifyTime ?? null,
          url: this.chatUrl(c.conversationId),
          ...(project ? { project } : {}),
        });
      }
      onProgress?.(result.length);
      if (!list.nextPageToken || list.conversations.length === 0) break;
      token = list.nextPageToken;
    }
    await this.nameProjectChats(result);
    return { conversations: result };
  }

  /**
   * The list gives no project (its `workspaces` is empty), so each project's chats
   * are listed to name it on them. A failure here leaves the list as it is.
   */
  private async nameProjectChats(chats: ConversationSummary[]): Promise<void> {
    try {
      const byId = new Map(chats.map((c) => [c.id, c]));
      for (const workspace of await this.workspaces()) {
        for (const id of await this.workspaceChatIds(workspace.workspaceId)) {
          const chat = byId.get(id);
          if (chat && workspace.name) chat.project = workspace.name;
        }
      }
    } catch (error) {
      if (error instanceof HttpError && error.isAuth) throw error;
      log.warn('Grok projects not read', error);
    }
  }

  /** The user's projects, most recently used first. */
  private async workspaces(): Promise<RawWorkspace[]> {
    const out: RawWorkspace[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams({
        pageSize: '50',
        orderBy: 'ORDER_BY_LAST_USE_TIME',
        kind: 'WORKSPACE_KIND_ALL',
      });
      if (token) query.set('pageToken', token);
      const list = parse(
        workspaceListSchema,
        await this.get(`/rest/workspaces?${query.toString()}`),
        'workspaces',
      );
      out.push(...list.workspaces);
      if (!list.nextPageToken || list.workspaces.length === 0) break;
      token = list.nextPageToken;
    }
    return out;
  }

  /** A project's chats, as the list gives them. */
  private async workspaceChats(id: string) {
    const out: {
      conversationId: string;
      title: string;
      createTime: string | null;
      modifyTime: string | null;
    }[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams({ pageSize: String(PAGE_SIZE), workspaceId: id });
      if (token) query.set('pageToken', token);
      const list = parse(
        conversationListSchema,
        await this.get(`/rest/app-chat/conversations?${query.toString()}`),
        'conversations',
      );
      out.push(
        ...list.conversations.map((c) => ({
          conversationId: c.conversationId,
          title: c.title,
          createTime: c.createTime ?? null,
          modifyTime: c.modifyTime ?? null,
        })),
      );
      if (!list.nextPageToken || list.conversations.length === 0) break;
      token = list.nextPageToken;
    }
    return out;
  }

  private async workspaceChatIds(id: string): Promise<string[]> {
    return (await this.workspaceChats(id)).map((c) => c.conversationId);
  }

  /** Projects for the export page's Projects tab. */
  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.workspaces()).map((w) => this.projectSummary(w));
  }

  /** A project with its files and chats; its instructions when Grok gives them. */
  async getProject(id: string): Promise<Project> {
    let raw: unknown;
    try {
      raw = await this.get(`/rest/workspaces/${id}`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404)
        throw new ChatNotFoundError('grok.com', id);
      throw error;
    }
    const workspace = parse(workspaceSchema, raw, 'workspace');
    const fields = raw as Record<string, unknown>;
    const instructions =
      INSTRUCTION_FIELDS.map((k) => fields[k]).find((v): v is string => typeof v === 'string') ??
      '';
    const knowledge = await this.workspaceFiles(id);
    const conversations = (await this.workspaceChats(id)).map((c): ConversationSummary => ({
      id: c.conversationId,
      platform: 'grok',
      title: c.title,
      createdAt: c.createTime,
      updatedAt: c.modifyTime,
      url: this.chatUrl(c.conversationId),
      ...(workspace.name ? { project: workspace.name } : {}),
    }));
    return {
      ...this.projectSummary(workspace),
      knowledgeCount: knowledge.length,
      instructions: instructions.trim(),
      knowledge,
      conversations,
    };
  }

  /** A project's files, from assets.grok.com like a chat's uploads. */
  private async workspaceFiles(id: string): Promise<Attachment[]> {
    const out: Attachment[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams({
        pageSize: '100',
        orderBy: 'ORDER_BY_LAST_USE_TIME',
        workspaceId: id,
      });
      if (token) query.set('pageToken', token);
      const list = parse(
        assetListSchema,
        await this.get(`/rest/assets?${query.toString()}`),
        'assets',
      );
      for (const a of list.assets) {
        if (a.isDeleted) continue;
        const size = Number(a.sizeBytes);
        out.push({
          id: a.assetId,
          name: a.name || a.assetId,
          ...(a.mimeType ? { mime: a.mimeType } : {}),
          ...(Number.isFinite(size) && a.sizeBytes !== null ? { size } : {}),
          origin: 'project-knowledge',
          source: a.key
            ? { kind: 'url', url: `${this.assetsOrigin}/${a.key.replace(/^\/+/, '')}` }
            : null,
        });
      }
      if (!list.nextPageToken || list.assets.length === 0) break;
      token = list.nextPageToken;
    }
    return out;
  }

  /** The project of the open project page or of the open chat; null elsewhere. */
  async getCurrentProject(): Promise<{ id: string; name: string } | null> {
    const id = grokProjectId(this.currentUrl());
    if (id) {
      const workspace = parse(
        workspaceSchema,
        await this.get(`/rest/workspaces/${id}`),
        'workspace',
      );
      return { id: workspace.workspaceId, name: workspace.name };
    }
    const chat = this.getCurrentConversationId();
    if (!chat) return null;
    const { conversation } = parse(
      conversationSchema,
      await this.get(`/rest/app-chat/conversations_v2/${chat}?includeWorkspaces=true`),
      'conversations_v2',
    );
    const workspace = conversation.workspaces
      .map((w) => workspaceSchema.safeParse(w))
      .find((r) => r.success)?.data;
    return workspace ? { id: workspace.workspaceId, name: workspace.name } : null;
  }

  private projectSummary(w: RawWorkspace): ProjectSummary {
    return {
      id: w.workspaceId,
      platform: 'grok',
      name: w.name,
      description: '',
      createdAt: w.createTime ?? null,
      updatedAt: w.lastUseTime ?? null,
      url: `${this.origin}/project/${w.workspaceId}`,
    };
  }

  async getConversation(id: string): Promise<Conversation> {
    const base = `/rest/app-chat/conversations`;
    const [rawMeta, rawNodes] = await Promise.all([
      this.get(
        `/rest/app-chat/conversations_v2/${id}?includeWorkspaces=true&includeTaskResult=true`,
      ),
      this.get(`${base}/${id}/response-node`),
    ]);
    const { conversation } = parse(conversationSchema, rawMeta, 'conversations_v2');
    const { responseNodes } = parse(responseNodesSchema, rawNodes, 'response-node');
    const responses = await this.responses(
      id,
      responseNodes.map((n) => n.responseId),
    );
    const open = parseGrokUrl(this.currentUrl());
    return toConversation(conversation, responseNodes, responses, {
      url: this.chatUrl(id),
      assetsOrigin: this.assetsOrigin,
      responseId: open?.id === id ? open.responseId : null,
    });
  }

  private async responses(id: string, responseIds: string[]): Promise<RawResponse[]> {
    const out: RawResponse[] = [];
    for (let i = 0; i < responseIds.length; i += RESPONSES_PER_CALL) {
      const raw = await fetchJson(
        this.fetchFn,
        `${this.origin}/rest/app-chat/conversations/${id}/load-responses`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ responseIds: responseIds.slice(i, i + RESPONSES_PER_CALL) }),
        },
      );
      out.push(...parse(responsesSchema, raw, 'load-responses').responses);
    }
    return out;
  }

  private chatUrl(id: string): string {
    return `${this.origin}/c/${id}`;
  }
}
