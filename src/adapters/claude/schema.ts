import { z } from 'zod';
import { parseOrThrowFor, PlatformFormatError } from '../errors';

export { PlatformFormatError };

/**
 * Shapes of claude.ai REST responses (docs/platforms-claude.md). Only fields the
 * extension uses are declared; unknown fields are ignored. Required fields are
 * strict, so a format change fails with the path of the field that changed.
 */

const nullableString = z.string().nullish();

export const organizationsSchema = z.array(z.looseObject({ uuid: z.string() })).min(1);

export const projectSchema = z.looseObject({
  uuid: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  /** The project instructions. */
  prompt_template: z.string().nullish(),
  created_at: nullableString,
  updated_at: nullableString,
  docs_count: z.number().nullish(),
  files_count: z.number().nullish(),
});

export type RawProject = z.infer<typeof projectSchema>;

/** Both list styles: `pagination.has_more` (projects) and a top-level `has_more`. */
const pageInfo = {
  has_more: z.boolean().optional(),
  pagination: z.looseObject({ has_more: z.boolean().optional() }).optional(),
};

export const projectListSchema = z.looseObject({ data: z.array(projectSchema), ...pageInfo });

/** Text knowledge files: stored as documents with their full content. */
export const projectDocsSchema = z.array(
  z.looseObject({ uuid: z.string(), file_name: z.string(), content: z.string() }),
);

/** Binary knowledge files, downloaded through /files/{uuid}/contents. */
export const projectFilesSchema = z.array(
  z.looseObject({
    file_uuid: z.string(),
    file_name: z.string(),
    size_bytes: z.number().nullish(),
  }),
);

export const fileEntrySchema = z.looseObject({
  file_uuid: z.string(),
  file_name: z.string(),
  file_kind: z.string(),
  size_bytes: z.number().optional(),
});

export const legacyAttachmentSchema = z.looseObject({
  id: z.string(),
  file_name: z.string().optional(),
  file_size: z.number().optional(),
  file_type: z.string().optional(),
  extracted_content: z.string().optional(),
});

/** Blocks are validated one by one in normalize.ts, so unknown types can be skipped. */
const rawBlockSchema = z.looseObject({ type: z.string() });

/** Parent id of the first message in a conversation. */
const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

/**
 * One message. Only `uuid` is required: anything else that is missing or odd is
 * filled in, so one unusual message does not make the whole conversation fail.
 * Files and attachments are checked one by one in normalize.ts.
 */
export const messageSchema = z.looseObject({
  uuid: z.string(),
  parent_message_uuid: z
    .string()
    .nullish()
    .transform((v) => v ?? ROOT_PARENT),
  /** `human` and `assistant` are exported; other roles are skipped. */
  sender: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  index: z.number().nullish(),
  created_at: nullableString.transform((v) => v ?? null),
  content: z
    .array(rawBlockSchema)
    .nullish()
    .transform((v) => v ?? []),
  files: z.array(z.unknown()).nullish(),
  attachments: z.array(z.unknown()).nullish(),
});

export const conversationSchema = z.looseObject({
  uuid: z.string(),
  name: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  model: nullableString,
  created_at: nullableString.transform((v) => v ?? null),
  updated_at: nullableString.transform((v) => v ?? null),
  project_uuid: nullableString,
  /** Empty for a conversation without messages; the newest message is used then. */
  current_leaf_message_uuid: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  chat_messages: z
    .array(messageSchema)
    .transform((list) => list.map((m, i) => ({ ...m, index: m.index ?? i }))),
});

/** Item of `chat_conversations_v2`; only the fields the detail endpoint lacks. */
export const conversationListSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      uuid: z.string(),
      name: z.string().nullish(),
      created_at: nullableString,
      updated_at: nullableString,
      project: z.looseObject({ name: z.string() }).nullish(),
      is_temporary: z.boolean().nullish(),
      workspace_session_id: nullableString,
    }),
  ),
  ...pageInfo,
});

export type RawConversationListItem = z.infer<typeof conversationListSchema>['data'][number];

/** `/v1/code/sessions/{id}`: artifacts published from a cloud session. */
export const sessionSchema = z.looseObject({
  response_shape: z.looseObject({
    external_metadata: z
      .looseObject({
        artifacts: z
          .array(
            z.looseObject({
              artifact_id: z.string(),
              kind: z.string(),
              title: z.string().nullish(),
              url: z.string(),
            }),
          )
          .optional(),
      })
      .nullish(),
  }),
});

/** `/api/frame/{artifactId}`: one artifact version with a short-lived access token. */
export const frameSchema = z.looseObject({
  ver: z.string(),
  history: z.array(z.string()),
  /** Missing for some artifacts; they are then rebuilt from the chat. */
  files: z
    .array(z.looseObject({ path: z.string(), contentType: z.string().nullish() }))
    .nullish()
    .transform((v) => v ?? []),
  assetToken: z.string(),
  title: z.string().nullish(),
});

export const textBlockSchema = z.looseObject({
  type: z.literal('text'),
  text: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
});

export const thinkingBlockSchema = z.looseObject({
  type: z.literal('thinking'),
  thinking: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
});

export const toolUseBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  message: nullableString,
});

export const toolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  name: z.string().nullish(),
  /** An array of parts; plain text is accepted too. */
  content: z
    .union([z.array(z.looseObject({ type: z.string() })), z.string()])
    .nullish()
    .transform((v) => (typeof v === 'string' ? [{ type: 'text', text: v }] : (v ?? []))),
  is_error: z.boolean().nullish(),
  file_deliveries: z.array(z.looseObject({ file_uuid: z.string(), path: z.string() })).nullish(),
});

export const knowledgeItemSchema = z.looseObject({
  type: z.literal('knowledge'),
  title: z.string(),
  url: z.string(),
});

export const localResourceSchema = z.looseObject({
  type: z.literal('local_resource'),
  file_path: z.string(),
  name: z.string().nullish(),
  /** null for some files (seen in 2026-10 exports). */
  mime_type: z.string().nullish(),
});

/** `wiggle/list-files`: files in an older chat's sandbox, uploads and outputs. */
export const sandboxFilesSchema = z
  .looseObject({
    /** Paths only; older answers may have just these. */
    files: z.array(z.string()).nullish().catch(null),
    files_metadata: z
      .array(
        z.looseObject({
          path: z.string(),
          size: z.number().nullish().catch(null),
          content_type: z.string().nullish().catch(null),
          created_at: z.string().nullish().catch(null),
          custom_metadata: z
            .looseObject({ filename: z.string().nullish().catch(null) })
            .nullish()
            .catch(null),
        }),
      )
      .nullish(),
  })
  .transform((v) => ({
    files_metadata:
      v.files_metadata ??
      (v.files ?? []).map((path) => ({
        path,
        size: null,
        content_type: null,
        created_at: null,
        custom_metadata: null,
      })),
  }));

export type RawSandboxFile = z.infer<typeof sandboxFilesSchema>['files_metadata'][number];

export type RawConversation = z.output<typeof conversationSchema>;
export type RawFrame = z.infer<typeof frameSchema>;
export type RawMessage = RawConversation['chat_messages'][number];
export type RawBlock = z.infer<typeof rawBlockSchema>;
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;

/** Parses with a schema and turns a zod error into a PlatformFormatError naming the field. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  return parseOrThrowFor('claude.ai', schema, value, where);
}

/** One message on its own, with the index a conversation would give it. */
export function parseMessage(value: unknown, index = 0): RawMessage {
  const m = messageSchema.parse(value);
  return { ...m, index: m.index ?? index };
}
