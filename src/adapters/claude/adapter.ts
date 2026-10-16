import type {
  Attachment,
  Conversation,
  ConversationList,
  ConversationOptions,
  ConversationSummary,
  Message,
} from '../../model/conversation';
import type { Project, ProjectSummary } from '../../model/project';
import type { FetchLike } from '../../util/http';
import type { PlatformAdapter } from '../types';
import { ClaudeApi } from './api';
import {
  artifactFileName,
  findArtifactPublications,
  isTextContentType,
  selectPublications,
  type ArtifactPublication,
} from './artifacts';
import { activePath, normalizeConversation } from './normalize';
import type {
  RawConversation,
  RawConversationListItem,
  RawProject,
  RawSandboxFile,
} from './schema';
import { conversationIdFromUrl, projectIdFromUrl } from './urls';

const DEFAULT_OPTIONS: ConversationOptions = { artifactVersions: 'latest' };

interface SessionArtifact {
  artifact_id: string;
  title?: string | null | undefined;
  url: string;
}

const SANDBOX_UPLOADS = '/mnt/user-data/uploads/';
const SANDBOX_OUTPUTS = '/mnt/user-data/outputs/';

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The last message of `role` written no later than `at`; the last one of that role
 * when the time is unknown or earlier than all of them.
 */
function messageAt(messages: Message[], role: Message['role'], at: string | null | undefined) {
  const own = messages.filter((m) => m.role === role);
  const time = at ? Date.parse(at) : NaN;
  if (Number.isNaN(time)) return own.at(-1) ?? messages.at(-1);
  const before = own.filter((m) => m.createdAt && Date.parse(m.createdAt) <= time);
  return before.at(-1) ?? own[0] ?? messages.at(-1);
}

/**
 * A file name reduced to its letters and digits. The sandbox stores an upload under
 * its name with other characters replaced by `_` (spaces, commas, and dots before
 * the extension: `notes-0.1.98.vsix` is `notes-0_1_98.vsix`), so only those compare.
 */
function looseName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

export class ClaudeAdapter implements PlatformAdapter {
  readonly platform = 'claude' as const;
  private readonly api: ClaudeApi;

  constructor(
    fetchFn: FetchLike,
    private readonly currentUrl: () => string,
    origin = 'https://claude.ai',
  ) {
    this.api = new ClaudeApi(fetchFn, origin);
  }

  getCurrentConversationId(): string | null {
    return conversationIdFromUrl(this.currentUrl());
  }

  /** Every conversation in the account, newest first. Temporary chats are left out. */
  async listConversations(
    onProgress?: (loaded: number) => void,
    shouldStop?: () => boolean,
  ): Promise<ConversationList> {
    const { items, stopped } = await this.api.allConversations(50, onProgress, shouldStop);
    const conversations = this.summaries(items);
    return stopped
      ? { conversations, incomplete: { loaded: conversations.length, stopped: true } }
      : { conversations };
  }

  private summaries(items: RawConversationListItem[], project?: string): ConversationSummary[] {
    return items
      .filter((item) => !item.is_temporary)
      .map((item) => {
        const name = item.project?.name ?? project;
        return {
          id: item.uuid,
          platform: 'claude' as const,
          title: item.name ?? '',
          createdAt: item.created_at ?? null,
          updatedAt: item.updated_at ?? null,
          url: `${this.api.origin}/chat/${item.uuid}`,
          ...(name ? { project: name } : {}),
        };
      });
  }

  private projectSummary(raw: RawProject): ProjectSummary {
    const count = (raw.docs_count ?? 0) + (raw.files_count ?? 0);
    return {
      id: raw.uuid,
      platform: 'claude',
      name: raw.name,
      description: raw.description ?? '',
      createdAt: raw.created_at ?? null,
      updatedAt: raw.updated_at ?? null,
      url: `${this.api.origin}/project/${raw.uuid}`,
      ...(raw.docs_count != null || raw.files_count != null ? { knowledgeCount: count } : {}),
    };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.api.allProjects()).map((raw) => this.projectSummary(raw));
  }

  /**
   * A project with its instructions, knowledge base and chat list. Text files of
   * the knowledge base come with their content; binaries are downloaded by URL.
   */
  async getProject(id: string): Promise<Project> {
    const { orgId, raw } = await this.api.project(id);
    const [docs, files, conversations] = await Promise.all([
      this.api.projectDocs(orgId, id),
      this.api.projectFiles(orgId, id),
      this.api.projectConversations(orgId, id),
    ]);
    const knowledge: Attachment[] = [
      ...docs.map((doc) => ({
        id: doc.uuid,
        name: doc.file_name,
        origin: 'project-knowledge' as const,
        source: { kind: 'text' as const, text: doc.content, mime: 'text/plain' },
      })),
      ...files.map((file) => ({
        id: file.file_uuid,
        name: file.file_name,
        origin: 'project-knowledge' as const,
        ...(file.size_bytes != null ? { size: file.size_bytes } : {}),
        source: { kind: 'url' as const, url: this.api.fileUrl(orgId, file.file_uuid) },
      })),
    ];
    return {
      ...this.projectSummary(raw),
      knowledgeCount: knowledge.length,
      instructions: raw.prompt_template ?? '',
      knowledge,
      conversations: this.summaries(conversations, raw.name),
    };
  }

  /**
   * The project of the open page: the project page itself, or the project a chat
   * belongs to (one request for the chat).
   */
  async getCurrentProject(): Promise<{ id: string; name: string } | null> {
    const projectId = projectIdFromUrl(this.currentUrl());
    if (projectId) {
      const { raw } = await this.api.project(projectId);
      return { id: raw.uuid, name: raw.name };
    }
    const conversationId = this.getCurrentConversationId();
    if (!conversationId) return null;
    const { orgId, raw } = await this.api.conversation(conversationId);
    if (!raw.project_uuid) return null;
    return { id: raw.project_uuid, name: await this.api.projectName(orgId, raw.project_uuid) };
  }

  async getConversation(id: string, options = DEFAULT_OPTIONS): Promise<Conversation> {
    const { orgId, raw } = await this.api.conversation(id);
    const projectName = raw.project_uuid
      ? await this.api.projectName(orgId, raw.project_uuid)
      : undefined;
    const conversation = normalizeConversation(raw, {
      origin: this.api.origin,
      orgId,
      ...(projectName ? { projectName } : {}),
    });
    await this.attachArtifacts(conversation, raw, orgId, options);
    await this.useSandboxFiles(conversation, raw, orgId);
    await this.useSavedCopies(conversation, orgId);
    return conversation;
  }

  /**
   * Files the model presented from its sandbox are downloaded from their saved
   * copies, as the web app does: the copy keeps the file as it was presented, and it
   * is still there after the model deleted or rewrote the file in the sandbox (seen
   * for most `.vsix` builds in 2026-10). The copies' ids come only from the web
   * app's timeline stream; without it, the sandbox address stays.
   */
  private async useSavedCopies(conversation: Conversation, orgId: string): Promise<void> {
    const marker = `/conversations/${conversation.id}/wiggle/download-file?`;
    const inSandbox = [
      ...conversation.messages,
      ...conversation.branches.flatMap((b) => b.messages),
    ]
      .flatMap((m) => m.attachments)
      .flatMap((a) => {
        if (a.source?.kind !== 'url' || !a.source.url.includes(marker)) return [];
        const path = new URL(a.source.url).searchParams.get('path');
        return path ? [{ attachment: a, path }] : [];
      });
    if (!inSandbox.length) return;
    let files: Awaited<ReturnType<ClaudeApi['timelineFiles']>>;
    try {
      files = await this.api.timelineFiles(
        conversation.id,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    } catch (error) {
      console.warn('[ai-chat-exporter] Could not read saved file copies', error);
      return;
    }
    // A path presented several times has a copy per presentation, in order.
    const seen = new Map<string, number>();
    for (const { attachment, path } of inSandbox) {
      const list = files.copies.get(path);
      const note = files.unavailable.get(path);
      if (!list?.length) {
        // The web app shows these as unavailable ("This file was replaced by newer
        // files."): say so instead of asking the sandbox for a file that is gone.
        if (note) {
          attachment.source = null;
          attachment.note = 'unavailable';
          attachment.unavailableReason = note;
        }
        continue;
      }
      const n = seen.get(path) ?? 0;
      seen.set(path, n + 1);
      const uuid = list[Math.min(n, list.length - 1)];
      if (uuid) attachment.source = { kind: 'url', url: this.api.fileUrl(orgId, uuid) };
    }
  }

  /**
   * Chats with a sandbox (code execution) keep the user's uploads in
   * `/mnt/user-data/uploads/` and the model's files in `/mnt/user-data/outputs/`.
   *
   * - Uploads are downloaded from there, as the web app does: `/files/{uuid}/contents`
   *   answers 404 for some of them (.zip, .vsix, .pptx, .patch, .md seen in 2026-10).
   *   They are matched by name, since the sandbox changes some characters.
   * - Every other file there is saved too, attached to the message it most likely
   *   belongs to by time: slides, images an artifact uses, files the model wrote
   *   without presenting them. Otherwise they would be missing without a word.
   */
  private async useSandboxFiles(
    conversation: Conversation,
    raw: RawConversation,
    orgId: string,
  ): Promise<void> {
    const messages = [
      ...conversation.messages,
      ...conversation.branches.flatMap((b) => b.messages),
    ];
    const attachments = messages.flatMap((m) => m.attachments);
    // Only chats that ran tools or have files can have a sandbox; others skip the request.
    const usedTools = raw.chat_messages.some((m) =>
      m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result'),
    );
    if (!attachments.length && !usedTools) return;
    let files: RawSandboxFile[];
    try {
      files = await this.api.sandboxFiles(orgId, conversation.id);
    } catch (error) {
      console.warn('[ai-chat-exporter] Could not list sandbox files', error);
      return;
    }
    if (!files.length) return;

    const url = (path: string) => this.api.sandboxFileUrl(orgId, conversation.id, path);
    const used = new Set(
      attachments.flatMap((a) => (a.source?.kind === 'url' ? [a.source.url] : [])),
    );
    const uploads = files.filter((f) => f.path.startsWith(SANDBOX_UPLOADS));
    for (const upload of attachments) {
      if (upload.origin !== 'user-upload' || upload.source?.kind !== 'url') continue;
      const wanted = looseName(upload.name);
      const match = uploads.find(
        (f) =>
          !used.has(url(f.path)) &&
          (f.custom_metadata?.filename === upload.name || looseName(baseName(f.path)) === wanted),
      );
      if (!match) continue;
      used.add(url(match.path));
      upload.source = { kind: 'url', url: url(match.path) };
    }

    for (const file of files) {
      const isUpload = file.path.startsWith(SANDBOX_UPLOADS);
      if (!isUpload && !file.path.startsWith(SANDBOX_OUTPUTS)) continue;
      if (used.has(url(file.path))) continue;
      used.add(url(file.path));
      const target = messageAt(
        conversation.messages,
        isUpload ? 'user' : 'assistant',
        file.created_at,
      );
      if (!target) continue;
      target.attachments.push({
        id: `${conversation.id}:${file.path}`,
        name: file.custom_metadata?.filename || baseName(file.path),
        ...(file.content_type ? { mime: file.content_type } : {}),
        ...(file.size ? { size: file.size } : {}),
        origin: isUpload ? 'user-upload' : 'model-generated',
        source: { kind: 'url', url: url(file.path) },
      });
    }
  }

  /** Adds published artifacts to the messages that published them. */
  private async attachArtifacts(
    conversation: Conversation,
    raw: RawConversation,
    orgId: string,
    options: ConversationOptions,
  ): Promise<void> {
    const all = findArtifactPublications(activePath(raw));
    if (!all.length) return;
    const selected = selectPublications(all, options.artifactVersions);
    const sessionArtifacts = await this.sessionArtifacts(orgId, raw.uuid);

    const messages = new Map<string, Message>(
      [...conversation.messages, ...conversation.branches.flatMap((b) => b.messages)].map((m) => [
        m.id,
        m,
      ]),
    );
    for (const publication of selected) {
      const message = messages.get(publication.messageId);
      if (!message) continue;
      // Versions are numbered by order of publication of the same artifact.
      const sameArtifact = all.filter(
        (p) => (p.url ?? p.filePath) === (publication.url ?? publication.filePath),
      );
      const version =
        options.artifactVersions === 'all' && sameArtifact.length > 1
          ? sameArtifact.indexOf(publication) + 1
          : null;
      const known = sessionArtifacts.find((a) => a.url === publication.url) ?? null;
      for (const attachment of await this.artifactFiles(
        orgId,
        raw.uuid,
        publication,
        known,
        version,
      )) {
        message.attachments.push(attachment);
      }
    }
  }

  private async sessionArtifacts(
    orgId: string,
    conversationId: string,
  ): Promise<SessionArtifact[]> {
    try {
      const sessionId = await this.api.workspaceSessionId(orgId, conversationId);
      return sessionId ? await this.api.sessionArtifacts(orgId, sessionId) : [];
    } catch (error) {
      console.warn('[ai-chat-exporter] Could not read session artifacts', error);
      return [];
    }
  }

  /**
   * Files of one artifact version: the published files when the artifact is known,
   * otherwise the file rebuilt from the conversation.
   */
  private async artifactFiles(
    orgId: string,
    conversationId: string,
    publication: ArtifactPublication,
    known: SessionArtifact | null,
    version: number | null,
  ): Promise<Attachment[]> {
    const id = `artifact:${publication.url ?? publication.filePath}:${publication.versionId ?? version ?? 'latest'}`;
    if (known) {
      try {
        const frame = await this.api.frame(
          orgId,
          known.artifact_id,
          publication.versionId ?? undefined,
        );
        const title = known.title ?? frame.title ?? null;
        const result: Attachment[] = [];
        for (const [i, file] of frame.files.entries()) {
          const url = this.api.artifactFileUrl(known.artifact_id, frame, file.path);
          const name = artifactFileName({
            title,
            sandboxPath: publication.filePath,
            filePath: file.path,
            isMainFile: i === 0,
            version,
          });
          const base = {
            id: `${id}:${file.path}`,
            name,
            origin: 'artifact' as const,
            ...(file.contentType ? { mime: file.contentType } : {}),
          };
          result.push(
            isTextContentType(file.contentType)
              ? {
                  ...base,
                  source: {
                    kind: 'text',
                    text: await this.api.artifactFileText(url),
                    mime: file.contentType ?? 'text/plain',
                  },
                }
              : { ...base, source: { kind: 'url', url } },
          );
        }
        if (result.length) return result;
      } catch (error) {
        console.warn('[ai-chat-exporter] Could not download artifact', publication.url, error);
      }
    }

    const name = artifactFileName({
      title: known?.title ?? null,
      sandboxPath: publication.filePath,
      filePath: null,
      isMainFile: true,
      version,
    });
    if (publication.content === null) {
      // Not rebuilt (the file was written another way, e.g. from a shell command): an
      // older chat keeps the file in its sandbox, where the web app finds it too.
      return [
        {
          id,
          name,
          origin: 'artifact',
          source: {
            kind: 'url',
            url: this.api.sandboxFileUrl(orgId, conversationId, publication.filePath),
          },
        },
      ];
    }
    return [
      {
        id,
        name,
        origin: 'artifact',
        source: { kind: 'text', text: publication.content, mime: 'text/plain' },
        note: 'rebuilt-from-chat',
      },
    ];
  }
}
