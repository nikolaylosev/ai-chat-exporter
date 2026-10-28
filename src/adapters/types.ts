import type { Conversation, ConversationList, ConversationOptions } from '../model/conversation';
import type { Platform } from '../shared/platform';

/**
 * Reads conversations from one platform. Runs in that platform's content script.
 * Adapters know nothing about where the data goes.
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  getCurrentConversationId(): string | null;
  /**
   * `onProgress` gets the number of chats read so far, for a list that loads slowly.
   * When `shouldStop` turns true, the list ends after the current page, marked stopped.
   * `known` (chat id to update time) lets an adapter whose list is slow stop at
   * chats the caller already has unchanged, marked `reachedKnown` (Gemini).
   */
  listConversations(
    onProgress?: (loaded: number) => void,
    shouldStop?: () => boolean,
    known?: ReadonlyMap<string, string | null>,
  ): Promise<ConversationList>;
  getConversation(id: string, options?: ConversationOptions): Promise<Conversation>;
  /** A new link for a file of a conversation read before; for links that expire. */
  fileLink?(conversationId: string, attachmentId: string): Promise<string | null>;
}
