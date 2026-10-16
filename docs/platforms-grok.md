# Platform notes: grok.com

What the extension needs from Grok, as observed on 2026-10-13 and 2026-10-14 (free plan, model `grok-3`, "Fast" mode). Items marked **unverified** were not available on this plan or not tried.

Fixtures live in [`tests/fixtures/grok/`](../tests/fixtures/grok/). They come from test chats created for this purpose and deleted afterwards; every id in them is replaced (see [Fixtures](#7-fixtures)).

## Contents

1. [Key findings](#1-key-findings)
2. [Endpoints](#2-endpoints)
3. [Conversation format](#3-conversation-format)
4. [Files from the user](#4-files-from-the-user)
5. [Generated images](#5-generated-images)
6. [Projects](#6-projects)
7. [Open questions](#7-open-questions)
8. [Fixtures](#8-fixtures)

## 1. Key findings

- **grok.com serves everything as plain JSON REST** under `/rest/app-chat/`. A `fetch` from a grok.com tab with the user's cookies works; no special headers are needed. The adapter can work like the Claude one.
- **Replies are Markdown**, with the model name.
- **The conversation is a real tree**: a regenerated answer is kept next to the first one.
- **Uploads download byte for byte** from `assets.grok.com`, images included.
- **Generated images are available at full size.**

## 2. Endpoints

| Purpose      | Request                                                                                   | Notes                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| List chats   | `GET /rest/app-chat/conversations?pageSize=60`                                            | `{ conversations, nextPageToken, textSearchMatches }`; the token is the last id          |
| Starred only | `…&filterIsStarred=true`                                                                  | Extra filter used by the sidebar; `excludeProjects=true` leaves project chats out        |
| One chat     | `GET /rest/app-chat/conversations_v2/{id}?includeWorkspaces=true&includeTaskResult=true`  | `{ conversation: { title, createTime, modifyTime, starred, temporary, workspaces, … } }` |
| Tree         | `GET /rest/app-chat/conversations/{id}/response-node`                                     | `{ responseNodes: [{ responseId, sender, parentResponseId }], inflightResponses }`       |
| Messages     | `POST /rest/app-chat/conversations/{id}/load-responses` with `{ "responseIds": [...] }`   | `{ responses: [...] }`, section 3                                                        |
| Chat files   | `GET /rest/conversations/files/list?conversationId={id}&path=/`                           | Empty in every test chat; uploads are on the messages                                    |
| Projects     | `GET /rest/workspaces?pageSize=50&orderBy=ORDER_BY_LAST_USE_TIME&kind=WORKSPACE_KIND_ALL` | `{ workspaces: [{ workspaceId, name, createTime, lastUseTime, … }] }`, section 6         |
| One project  | `GET /rest/workspaces/{id}`                                                               | The same entry                                                                           |
| Its chats    | `GET /rest/app-chat/conversations?pageSize=60&workspaceId={id}`                           | The list's entries                                                                       |
| Its files    | `GET /rest/assets?pageSize=100&orderBy=ORDER_BY_LAST_USE_TIME&workspaceId={id}`           | `{ assets: [{ assetId, name, mimeType, sizeBytes, key, isDeleted, … }] }`                |
| File bytes   | `GET https://assets.grok.com/{key}`                                                       | With cookies; CORS allows grok.com                                                       |

## 3. Conversation format

The list and `conversations_v2` give `createTime` and `modifyTime` (ISO 8601, UTC): the creation date for the folder name is there.

`response-node` lists every message with its parent. After **Regenerate**, the human message has **two assistant children**; the page shows the one in `?rid=<responseId>`, and the newest one by default (to be confirmed with an edited prompt).

Each response from `load-responses`:

| Field                                                    | Meaning                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `responseId`, `parentResponseId`, `sender`               | Tree position; `human` or `assistant`                                              |
| `message`                                                | **Markdown**                                                                       |
| `createTime`                                             | ISO 8601                                                                           |
| `model`                                                  | `grok-3` on assistant messages                                                     |
| `steps[]`                                                | Reasoning headers (`text`, `tags: ["header"]`), e.g. "Thinking about your request" |
| `webSearchResults`, `citedWebSearchResults`, `xposts`    | Search results (empty in the tests)                                                |
| `fileAttachmentsMetadata`, `fileAttachmentAssetMetadata` | Uploads (section 4)                                                                |
| `cardAttachmentsJson`                                    | Cards such as generated images, as JSON strings (section 5)                        |
| `metadata.request_metadata`                              | `{ effort, model: "fast", source: "Web" }`                                         |

## 4. Files from the user

The human message lists each upload in `fileAttachmentsMetadata` (`fileName`, `fileMimeType`, `fileUri`, `createTime`) and `fileAttachmentAssetMetadata` (`name`, `mimeType`, `sizeBytes`, `key`). The key is `users/<user id>/<asset id>/content`; `https://assets.grok.com/<key>` returned the **pdf, the docx and the png byte for byte**. Images also have a `preview-image` key.

## 5. Generated images

The assistant message is a tag, `<grok:render card_id="…" card_type="generated_image_card" type="render_generated_image"></grok:render>`. The matching entry of `cardAttachmentsJson` has `image_chunk` with `imageUrl` (a key, `users/<id>/generated/<uuid>/image.jpg`), `resolution`, `mimeType` and the prompt. `fileAttachmentAssetMetadata` lists the same file with `sizeBytes` and `auxKeys["original-image"]` (`original_image.jpg`). Both downloaded at full size (1168×784); `image.jpg` matches `sizeBytes`, so it is the file to save.

## 6. Projects

Seen on 2026-10-16 in one project with one chat. A project opens at `/project/<uuid>`; **its chats open there too, as `?chat=<uuid>`**, not at `/c/<uuid>`.

- **The chat list gives no project**: `workspaces` is empty in every entry, a project chat's too. `conversations_v2` with `includeWorkspaces=true` gives the project (`[{ workspaceId, name, … }]`), and the list with `workspaceId=` gives a project's chats; the export page names projects this way. The sidebar asks with `excludeProjects=true`; the extension does not, so project chats are in the list.
- **Instructions**: the project page has an Instructions section, but neither `/rest/workspaces/{id}` nor any other request of the page carried them while they were empty. Grok leaves empty fields out, so the field name is not known; the adapter takes `instructions`, `customInstructions`, `customPersonality` or `systemPrompt` if one appears (**unverified**).
- **Files**: `/rest/assets?workspaceId=` lists them like the user's other files (empty in the test project); each `key` downloads from assets.grok.com.

### Files the model made

A file the model wrote (here a pdf and a txt) is a card: the answer has `<grok:render card_id="…" card_type="rendered_file_card" type="render_file">`, and `cardAttachmentsJson` has `{ id, type: "render_file", cardType: "rendered_file_card", file_name, content_type, mime_type, file_size, url }` with `url` a key, `users/<id>/generated/<uuid>/<name>`. `https://assets.grok.com/<key>` returned both files byte for byte (`file_size` matched).

## 7. Open questions

1. **Think and DeepSearch**: only "Fast" is available on the free plan; `steps` holds short headers there.
2. **Project instructions and files**: the test project had none (section 6).
3. **Grok Studio / Build mode**: not tried.
4. **Private chats**: not tried; they are not meant to be saved.
5. **Edited prompts**: how an edit appears in the tree, and which branch is current without `?rid`.
6. **Chats from Grok in x.com**: not visible on grok.com in this account; out of scope.
7. **Rate limits**: none seen.

## 8. Fixtures

| File                        | What it shows                                         |
| --------------------------- | ----------------------------------------------------- |
| `conversation-basic.json`   | Markdown answer, then a regenerated one: two branches |
| `conversation-uploads.json` | pdf, docx and png uploads with their asset metadata   |
| `conversation-image.json`   | A generated image card                                |
| `conversations-list.json`   | A list page, reduced to the test chats                |
| `workspaces.json`           | The project list                                      |
| `workspace.json`            | One project                                           |
| `workspace-chats.json`      | A project's chats                                     |
| `workspace-assets.json`     | A project's files: one, and one deleted               |

Each conversation file is `{ meta, nodes, responses }`, the three calls of section 2. The project fixtures are written from the shapes seen on 2026-10-16 with made-up values. How the others were made: test chats were created, the responses recorded, the chats deleted. UUIDs (conversations, responses, assets and the user id inside file keys) and the page token are replaced with stable fake values; the files are checked for leftovers before saving.
