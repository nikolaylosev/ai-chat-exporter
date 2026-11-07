import type { Conversation, ConversationList, ConversationSummary } from '../../model/conversation';
import { fetchJson, HttpError, type FetchLike } from '../../util/http';
import { ChatNotFoundError, parseOrThrowFor } from '../errors';
import type { PlatformAdapter } from '../types';
import { isoFromSeconds, toConversation } from './normalize';
import {
  envelopeSchema,
  filesSchema,
  historySchema,
  sessionPageSchema,
  type RawSession,
} from './schema';
import {
  DEEPSEEK_FILES_ORIGIN,
  DEEPSEEK_ORIGIN,
  deepseekChatUrl,
  deepseekConversationId,
  deepseekFileUrl,
} from './urls';

/** The largest page the list gives; a bigger `count` returns nothing. */
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 200;
/** `code` of an answer whose token is missing, expired or wrong. */
const INVALID_TOKEN = 40003;
/** `code` of an answer refused because the app asks too often. */
const RATE_LIMITED = 40029;
const RATE_LIMIT_RETRIES = 4;

const PLATFORM = 'chat.deepseek.com';

const parse = <T>(
  schema: Parameters<typeof parseOrThrowFor<T>>[1],
  value: unknown,
  where: string,
) => parseOrThrowFor(PLATFORM, schema, value, where);

/** An answer the API refused in its own envelope (`biz_code` other than 0). */
class RefusedError extends Error {
  constructor(
    readonly bizCode: number,
    readonly bizMsg: string,
    where: string,
  ) {
    super(`${PLATFORM} refused ${where}: ${bizCode} ${bizMsg}`);
    this.name = 'RefusedError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads DeepSeek through the web app's JSON API (docs/platforms-deepseek.md).
 * Runs in the content script on chat.deepseek.com: requests are same-origin and
 * carry the user's token from the page's storage, read for each request and
 * never kept or logged. Uploads are fetched by the extension from
 * files.deepseeksvc.com through signed links, without the token.
 */
export class DeepseekAdapter implements PlatformAdapter {
  readonly platform = 'deepseek' as const;

  constructor(
    private readonly fetchFn: FetchLike,
    private readonly currentUrl: () => string,
    /** The page's sign-in token (`localStorage.userToken.value`), or null when signed out. */
    private readonly token: () => string | null,
    private readonly origin = DEEPSEEK_ORIGIN,
    private readonly filesOrigin = DEEPSEEK_FILES_ORIGIN,
    private readonly sleep = defaultSleep,
  ) {}

  /**
   * GET returning `biz_data`. Every answer is HTTP 200 with an envelope: `code`
   * says whether the request was taken (40003: not signed in, 40029: too many
   * requests), `biz_code` whether it worked.
   */
  private async get(path: string, where: string): Promise<unknown> {
    const url = `${this.origin}${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = this.token();
      if (!token) throw new HttpError(401, url);
      const raw = await fetchJson(this.fetchFn, url, {
        headers: { authorization: `Bearer ${token}` },
      });
      const envelope = parse(envelopeSchema, raw, where);
      if (envelope.code === INVALID_TOKEN) throw new HttpError(401, url);
      if (envelope.code === RATE_LIMITED) {
        if (attempt >= RATE_LIMIT_RETRIES) throw new HttpError(429, url);
        await this.sleep(2000 * 2 ** attempt);
        continue;
      }
      if (envelope.code !== 0) throw new RefusedError(envelope.code, envelope.msg, where);
      const bizCode = envelope.data?.biz_code ?? 0;
      if (bizCode !== 0) throw new RefusedError(bizCode, envelope.data?.biz_msg ?? '', where);
      return envelope.data?.biz_data;
    }
  }

  getCurrentConversationId(): string | null {
    return deepseekConversationId(this.currentUrl());
  }

  /**
   * Every conversation as the sidebar lists them: pinned first, then newest
   * first. A page starts at the last chat of the one before, inclusive, so the
   * repeated chat is skipped.
   */
  async listConversations(
    onProgress?: (loaded: number) => void,
    shouldStop?: () => boolean,
  ): Promise<ConversationList> {
    const result: ConversationSummary[] = [];
    const seen = new Set<string>();
    let cursor: { pinned: boolean; updatedAt: number } | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      if (page > 0 && shouldStop?.()) {
        return { conversations: result, incomplete: { loaded: result.length, stopped: true } };
      }
      const query = new URLSearchParams({ count: String(PAGE_SIZE) });
      query.set('lte_cursor.pinned', String(cursor?.pinned ?? false));
      if (cursor) query.set('lte_cursor.updated_at', String(cursor.updatedAt));
      const data = parse(
        sessionPageSchema,
        await this.get(`/api/v0/chat_session/fetch_page?${query.toString()}`, 'fetch_page'),
        'fetch_page',
      );
      let fresh = 0;
      for (const s of data.chat_sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        fresh++;
        result.push(this.summary(s));
      }
      onProgress?.(result.length);
      const last = data.chat_sessions.at(-1);
      if (!data.has_more || !last || fresh === 0) break;
      cursor = { pinned: last.pinned, updatedAt: last.updated_at };
    }
    return { conversations: result };
  }

  async getConversation(id: string): Promise<Conversation> {
    let raw: unknown;
    try {
      raw = await this.get(
        `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(id)}`,
        'history_messages',
      );
    } catch (error) {
      if (error instanceof RefusedError && /chat session/i.test(error.bizMsg)) {
        throw new ChatNotFoundError(PLATFORM, id);
      }
      throw error;
    }
    const history = parse(historySchema, raw, 'history_messages');
    return toConversation(history.chat_session, history.chat_messages, {
      url: this.chatUrl(id),
      filesOrigin: this.filesOrigin,
    });
  }

  /** A new signed link for an upload, when the one read with the chat was refused. */
  async fileLink(_conversationId: string, attachmentId: string): Promise<string | null> {
    const query = new URLSearchParams({ file_ids: attachmentId });
    const data = parse(
      filesSchema,
      await this.get(`/api/v0/file/fetch_files?${query.toString()}`, 'fetch_files'),
      'fetch_files',
    );
    const file = data.files.find((f) => f.id === attachmentId);
    return file?.signed_path
      ? deepseekFileUrl(file.signed_path, file.is_image, this.filesOrigin)
      : null;
  }

  private summary(s: RawSession): ConversationSummary {
    return {
      id: s.id,
      platform: 'deepseek',
      title: s.title,
      createdAt: isoFromSeconds(s.inserted_at),
      updatedAt: isoFromSeconds(s.updated_at),
      url: this.chatUrl(s.id),
    };
  }

  private chatUrl(id: string): string {
    return deepseekChatUrl(id, this.origin);
  }
}
