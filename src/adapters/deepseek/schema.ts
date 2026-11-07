import { z } from 'zod';

/**
 * Shapes of chat.deepseek.com API responses (docs/platforms-deepseek.md). Every
 * answer is HTTP 200 with `{ code, msg, data: { biz_code, biz_msg, biz_data } }`;
 * the envelope is checked by the adapter, these schemas read `biz_data`. Only ids
 * are strict; any other field that is missing or of another type falls back to an
 * empty value, so one odd field does not stop the whole chat.
 */

const text = z.string().catch('');
const optionalText = z.string().nullish().catch(null);
const seconds = z.number().nullish().catch(null);
const list = <T extends z.ZodType>(item: T) => z.array(item).catch([]);

export const envelopeSchema = z.looseObject({
  code: z.number(),
  msg: text,
  data: z
    .looseObject({ biz_code: z.number().nullish(), biz_msg: optionalText, biz_data: z.unknown() })
    .nullish()
    .catch(null),
});

export const sessionSchema = z.looseObject({
  id: z.string(),
  title: text,
  /** Seconds. Moves on pinning and unpinning too, not only on new messages. */
  updated_at: z.number().catch(0),
  inserted_at: seconds,
  pinned: z.boolean().catch(false),
  model_type: optionalText,
  current_message_id: z.number().nullish().catch(null),
});

export const sessionPageSchema = z.looseObject({
  chat_sessions: z.array(sessionSchema),
  has_more: z.boolean().catch(false),
});

export const fileSchema = z.looseObject({
  id: z.string(),
  file_name: text,
  file_size: z.number().nullish().catch(null),
  is_image: z.boolean().catch(false),
  status: optionalText,
  /** Missing on old uploads: the server no longer keeps their bytes. */
  signed_path: optionalText,
});

const searchResultSchema = z.looseObject({
  url: text,
  title: text,
  site_name: optionalText,
  cite_index: z.number().nullish().catch(null),
});

/**
 * A part of a message. Seen: REQUEST, RESPONSE, THINK, SEARCH, FILE, TIP and
 * TEMPLATE_RESPONSE (the server's "busy" notice in place of an answer); the web
 * app also knows TOOL_SEARCH, TOOL_OPEN, TOOL_FIND and READ_LINK.
 */
export const fragmentSchema = z.looseObject({
  type: text,
  content: z.unknown().optional(),
  elapsed_secs: z.number().nullish().catch(null),
  results: list(searchResultSchema),
  files: list(fileSchema),
});

export const messageSchema = z.looseObject({
  message_id: z.number(),
  parent_id: z.number().nullish().catch(null),
  role: text,
  status: optionalText,
  inserted_at: seconds,
  fragments: list(fragmentSchema),
});

export const historySchema = z.looseObject({
  chat_session: sessionSchema,
  chat_messages: z.array(messageSchema),
});

export const filesSchema = z.looseObject({ files: list(fileSchema) });

export type RawSession = z.infer<typeof sessionSchema>;
export type RawMessage = z.infer<typeof messageSchema>;
export type RawFragment = z.infer<typeof fragmentSchema>;
export type RawFile = z.infer<typeof fileSchema>;
