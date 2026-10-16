import { z } from 'zod';

/**
 * Shapes of chatgpt.com `/backend-api/` responses (docs/platforms-chatgpt.md).
 * Ids and the tree are strict; any other field that is missing or of another
 * type falls back to an empty value, so one odd field does not stop the chat.
 */

const text = z.string().catch('');
const optionalText = z.string().nullish().catch(null);
const optionalNumber = z.number().nullish().catch(null);
const list = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .nullish()
    .catch([])
    .transform((v) => v ?? []);

export const sessionSchema = z.looseObject({ accessToken: optionalText });

/** ISO 8601 in the list; seconds are read too, as a conversation gives them. */
const listDate = z
  .union([z.string(), z.number().transform((s) => new Date(s * 1000).toISOString())])
  .nullish()
  .catch(null);
const cursor = z.union([z.string(), z.number()]).nullish().catch(null);

export const conversationItemSchema = z.looseObject({
  id: z.string(),
  title: optionalText,
  create_time: listDate,
  update_time: listDate,
  gizmo_id: optionalText,
});

export const conversationListSchema = z.looseObject({
  items: z.array(conversationItemSchema),
});

/**
 * The sidebar's projects (`gizmos/snorlax/sidebar`): `{ gizmo: { gizmo, files } }`
 * per project, seen on 2026-10-16. An entry is read loosely (`projectOf`).
 */
export const projectSidebarSchema = z.looseObject({
  items: list(z.unknown()),
  cursor,
});

/** A project (`gizmos/{id}`): the gizmo with its name and instructions, and its files. */
export const projectDetailSchema = z.looseObject({
  gizmo: z.unknown(),
  files: list(z.unknown()),
});

/** One page of a project's chats (`gizmos/{id}/conversations`). */
export const projectChatsSchema = z.looseObject({
  items: z.array(conversationItemSchema),
  cursor,
});

/** `sediment://file_…` and other parts of `multimodal_text`. */
export const assetPointerSchema = z.looseObject({
  content_type: z.literal('image_asset_pointer'),
  asset_pointer: text,
  mime_type: optionalText,
  size_bytes: optionalNumber,
});

const thoughtSchema = z.looseObject({ summary: text, content: text });

const contentSchema = z.looseObject({
  content_type: text,
  /** Strings and objects such as `assetPointerSchema`. */
  parts: list(z.unknown()),
  /** `code`, `execution_output`. */
  text: optionalText,
  language: optionalText,
  thoughts: list(thoughtSchema),
});

const attachmentSchema = z.looseObject({
  id: z.string(),
  name: text,
  mime_type: optionalText,
  size: optionalNumber,
});

const searchEntrySchema = z.looseObject({
  url: text,
  title: text,
  attribution: optionalText,
  ref_id: z.looseObject({ ref_type: text, ref_index: z.number() }).nullish().catch(null),
});

const writingBlockSchema = z.looseObject({
  content: text,
  variant: optionalText,
  title: optionalText,
  language: optionalText,
});

const contentReferenceSchema = z.looseObject({
  type: text,
  matched_text: text,
  alt: optionalText,
  items: list(z.looseObject({ title: text, url: text, attribution: optionalText })),
});

const metadataSchema = z.looseObject({
  attachments: list(attachmentSchema),
  model_slug: optionalText,
  is_visually_hidden_from_conversation: z.boolean().catch(false),
  search_result_groups: list(z.looseObject({ entries: list(searchEntrySchema) })),
  content_references: list(contentReferenceSchema),
  writing_blocks: z.record(z.string(), writingBlockSchema).nullish().catch(null),
  image_gen_title: optionalText,
});

export const messageSchema = z.looseObject({
  id: z.string(),
  author: z.looseObject({ role: text, name: optionalText }),
  create_time: optionalNumber,
  content: contentSchema,
  metadata: metadataSchema
    .nullish()
    .catch(null)
    .transform((m) => m ?? metadataSchema.parse({})),
  recipient: optionalText,
});

export const conversationSchema = z.looseObject({
  conversation_id: z.string(),
  title: optionalText,
  /** Seconds since 1970. */
  create_time: optionalNumber,
  update_time: optionalNumber,
  current_node: optionalText,
  gizmo_id: optionalText,
  mapping: z.record(
    z.string(),
    z.looseObject({
      id: z.string(),
      parent: optionalText,
      children: list(z.string()),
      message: messageSchema.nullish(),
    }),
  ),
});

/** The answer of both download endpoints; an error comes back with `status: "error"`. */
export const downloadSchema = z.looseObject({
  status: optionalText,
  download_url: optionalText,
  file_name: optionalText,
  error_code: optionalText,
});

export type RawConversationItem = z.infer<typeof conversationItemSchema>;
export type RawConversation = z.infer<typeof conversationSchema>;
export type RawNode = RawConversation['mapping'][string];
export type RawMessage = z.infer<typeof messageSchema>;
export type RawMetadata = RawMessage['metadata'];
export type RawSearchEntry = z.infer<typeof searchEntrySchema>;
export type RawWritingBlock = z.infer<typeof writingBlockSchema>;
export type RawContentReference = z.infer<typeof contentReferenceSchema>;
