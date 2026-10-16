import { z } from 'zod';

/**
 * Shapes of grok.com REST responses (docs/platforms-grok.md). Only ids are
 * strict; any other field that is missing or of another type falls back to an
 * empty value, so one odd field does not stop the whole chat.
 */

const text = z.string().catch('');
const optionalText = z.string().nullish().catch(null);
const list = <T extends z.ZodType>(item: T) => z.array(item).catch([]);

/** A list entry or a chat's `conversation` object. */
export const conversationMetaSchema = z.looseObject({
  conversationId: z.string(),
  title: text,
  createTime: optionalText,
  modifyTime: optionalText,
  /**
   * The chat's project, `{ workspaceId, name, … }`: given by `conversations_v2`
   * with `includeWorkspaces`, empty in the list (seen 2026-10-16).
   */
  workspaces: list(z.unknown()),
});

/** A project (`/rest/workspaces`, `/rest/workspaces/{id}`). Empty fields are left out. */
export const workspaceSchema = z.looseObject({
  workspaceId: z.string(),
  name: text,
  createTime: optionalText,
  lastUseTime: optionalText,
});

export const workspaceListSchema = z.looseObject({
  workspaces: list(workspaceSchema),
  nextPageToken: optionalText,
});

/** A project's files (`/rest/assets?workspaceId=`); the same entries as the user's files. */
export const assetListSchema = z.looseObject({
  assets: list(
    z.looseObject({
      assetId: z.string(),
      name: text,
      mimeType: optionalText,
      sizeBytes: z.union([z.number(), z.string()]).nullish().catch(null),
      key: text,
      isDeleted: z.boolean().nullish().catch(null),
    }),
  ),
  nextPageToken: optionalText,
});

export const conversationListSchema = z.looseObject({
  conversations: z.array(conversationMetaSchema),
  nextPageToken: optionalText,
});

export const conversationSchema = z.looseObject({ conversation: conversationMetaSchema });

export const responseNodesSchema = z.looseObject({
  responseNodes: z.array(
    z.looseObject({
      responseId: z.string(),
      sender: text,
      parentResponseId: optionalText,
    }),
  ),
});

const assetSchema = z.looseObject({
  assetId: optionalText,
  name: text,
  mimeType: optionalText,
  sizeBytes: z.coerce.number().nullish().catch(null),
  key: optionalText,
  isModelGenerated: z.boolean().catch(false),
});

const fileMetadataSchema = z.looseObject({
  fileMetadataId: optionalText,
  fileName: text,
  fileMimeType: optionalText,
  fileUri: optionalText,
});

const searchResultSchema = z.looseObject({ title: text, url: text });

const stepSchema = z.looseObject({ text: list(z.string()), tags: list(z.string()) });

export const responseSchema = z.looseObject({
  responseId: z.string(),
  parentResponseId: optionalText,
  sender: text,
  message: text,
  createTime: optionalText,
  model: optionalText,
  query: optionalText,
  steps: list(stepSchema),
  webSearchResults: list(searchResultSchema),
  citedWebSearchResults: list(searchResultSchema),
  fileAttachmentsMetadata: list(fileMetadataSchema),
  fileAttachmentAssetMetadata: list(assetSchema),
  cardAttachmentsJson: list(z.string()),
});

export const responsesSchema = z.looseObject({ responses: z.array(responseSchema) });

export type RawConversationMeta = z.infer<typeof conversationMetaSchema>;
export type RawResponse = z.infer<typeof responseSchema>;
export type RawResponseNode = z.infer<typeof responseNodesSchema>['responseNodes'][number];
