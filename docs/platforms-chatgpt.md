# Platform notes: chatgpt.com

What the extension needs from ChatGPT, as observed on 2026-10-15 (Free plan; models `gpt-6` and `gpt-6-t-mini`), with what a Team workspace showed the same day in [section 5](#seen-in-a-team-workspace-2026-10-15). Items marked **unverified** were not available on these accounts or not tried.

Fixtures live in [`tests/fixtures/chatgpt/`](../tests/fixtures/chatgpt/). They come from test chats created for this purpose and deleted afterwards, together with their files in the Library; every id in them is replaced (see [Fixtures](#10-fixtures)).

## Contents

1. [Key findings](#1-key-findings)
2. [Requests](#2-requests)
3. [Conversation list](#3-conversation-list)
4. [Conversation](#4-conversation)
5. [Files](#5-files)
6. [Canvas](#6-canvas)
7. [Reasoning, search, code](#7-reasoning-search-code)
8. [Temporary chats, projects, limits](#8-temporary-chats-projects-limits)
9. [Open questions](#9-open-questions)
10. [Fixtures](#10-fixtures)

## 1. Key findings

- **ChatGPT serves JSON REST under `/backend-api/`**, but every call needs `Authorization: Bearer <accessToken>`, taken from `GET /api/auth/session` in the chatgpt.com tab. **Without it, the list answers `200` with no items** (`{"items":[],"total":0}`), not an error: an adapter must check the token and must not take an empty list for "no chats". The token is a session secret and is never stored.
- **The conversation is a tree** (`mapping`, `current_node`), as on Claude: a regenerated answer and an edited message are siblings. `current_node` is the newest leaf.
- **Answers are Markdown** with a few inline tags to clean: `<FileCite …/>`, `<Cite refs={…}/>`, `<Entity …/>`, `<WritingBlock …>`.
- **Every file downloads through one endpoint**, which returns a signed link on chatgpt.com: uploads byte for byte, generated images at full size, code-generated files through a sandbox path.
- **Canvas is inline**: a `<WritingBlock>` in the answer, with the user's later edits in the message metadata.
- **Some files are never given** (a long pasted text, old uploads: 404), but the text the model read is in the chat, cut at 16,384 characters (section 5).
- **ChatGPT limits the request rate**: a Team workspace answered 429 to most of a run of conversation reads for minutes, without `Retry-After` (section 5).

## 2. Requests

| Purpose             | Request                                                                                        | Notes                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Token               | `GET /api/auth/session`                                                                        | `{ accessToken, expires, user, account: { planType } … }`; cookies only                          |
| List                | `GET /backend-api/conversations?offset=0&limit=100&order=updated`                              | `{ items, total, limit, offset }`; `limit` at most 100 (101 gives 422)                           |
| Archived            | `…&is_archived=true`                                                                           | A separate list                                                                                  |
| Starred             | `…&is_starred=true`                                                                            |                                                                                                  |
| Projects            | `GET /backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5`                            | `{ items: [{ gizmo: { gizmo, files, tools, … }, conversations }], cursor }`, section 8           |
| One project         | `GET /backend-api/gizmos/{g-p-id}`                                                             | `{ gizmo, files, tools, … }`                                                                     |
| Its chats           | `GET /backend-api/gizmos/{g-p-id}/conversations?limit=50&owned_only=false`                     | `{ items, cursor }`: the list's entries                                                          |
| Conversation        | `GET /backend-api/conversation/{id}`                                                           | Section 4                                                                                        |
| File link           | `GET /backend-api/files/download/{file_id}?conversation_id={id}&inline=false`                  | `{ status, download_url, file_name, mime_type, file_size_bytes, … }`; `/files/{id}/download` too |
| Code-generated file | `GET /backend-api/conversation/{id}/interpreter/download?message_id={msg}&sandbox_path={path}` | Same answer; `sandbox_path` without the `sandbox:` prefix                                        |
| Delete a chat (UI)  | `PATCH /backend-api/conversation/{id}` with `{ "is_visible": false }`                          | Used for the cleanup only                                                                        |
| Library files (UI)  | `POST /backend-api/files/library`, `POST …/files/library/files/delete-batch`                   | Uploads and generated files stay in the Library after their chat is deleted                      |

The signed `download_url` points at chatgpt.com and downloads **without cookies**, so no extra host permission is needed. An error comes back as `200` with `{ "status": "error", "error_code": "file_not_found" }`: the adapter checks `status`.

## 3. Conversation list

Each item has `id` (UUID), `title`, `create_time` and `update_time` (ISO 8601), `pinned_time`, `is_archived`, `is_starred`, `is_temporary_chat`, `gizmo_id` (custom GPT or project) and `workspace_id`. **`total` is not the number of chats**: with `limit=2` it said 3, with `offset=2` 5, with `limit=100` 101; it only shows that there is more. Paging goes on until a page has fewer than `limit` items.

## 4. Conversation

`title`, `create_time` and `update_time` are **seconds since 1970** here (`1792050774.48`), not ISO. `default_model_slug` is the chat's setting (`auto`); the model of each answer is `message.metadata.model_slug`.

`mapping` holds nodes `{ id, parent, children, message }`; the root has no message (`client-created-root`). Branches, from the test chat:

- **Regenerate**: the user message gets a second assistant child.
- **Edit**: the edited message is a second child of the root, with its own answers.
- `current_node` is the leaf the page shows (the newest).

`message.content.content_type` values seen:

| Type                      | Author      | Meaning                                                                       |
| ------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `text`                    | user, model | `parts: [string]`, Markdown                                                   |
| `multimodal_text`         | user, tool  | `parts` mixing text and `image_asset_pointer` objects                         |
| `thoughts`                | model       | `thoughts: [{ summary, content, chunks, finished }]`: reasoning               |
| `reasoning_recap`         | model       | `content: "Worked for 10s"`                                                   |
| `code`                    | model       | `text`, `language`; `recipient` is the tool (`python`, `web.run`, image tool) |
| `execution_output`        | tool        | `text`: output of the code                                                    |
| `tether_browsing_display` | tool        | File reading step                                                             |

Service nodes (tool calls, results, the files' extracted text) sit on the path between the user message and the answer; `metadata.is_visually_hidden_from_conversation` marks some of them.

Inline tags in answers:

| Tag                                                        | Meaning                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `<FileCite ref_id="turn0file0" />`                         | A citation of an uploaded file: dropped                        |
| `<Cite refs={["turn446501search1"]}/>`                     | Web sources: `search1` is `ref_index: 1` of the search results |
| `<Entity category="organization" value="…" disambig="…"/>` | A named entity: replaced by `value`                            |
| `<WritingBlock id="…" variant="document">…</WritingBlock>` | Canvas, section 6                                              |

## 5. Files

- **Uploads**: `message.metadata.attachments: [{ id: "file_…", library_file_id, name, mime_type, size, width?, height? }]`. An image upload is also an `image_asset_pointer` part (`sediment://file_…`). The pdf, docx and png downloaded **byte for byte** through the file link.
- **Generated images**: an `image_asset_pointer` in a tool message (`sediment://file_…`, `mime_type`, `size_bytes`, `width`, `height`), with generation metadata. It downloaded **at full size** (1254×1254, the stated 952,394 bytes) under a title-like name (`Minimalist Red Circle on White.png`). No watermarked copy was listed.
- **Code-generated files**: the answer links `[Download fruits.csv](sandbox:/mnt/data/fruits.csv)`; the file comes through `interpreter/download` with the answer's message id and the path. The CSV came back as written.

### Seen in a Team workspace (2026-10-15)

Checked read-only in a Team workspace (plan `team`, structure `workspace`):

- **No workspace header is needed**: every request gave the same answer with and without `ChatGPT-Account-Id`.
- **Long pasted text** becomes an attachment with `is_big_paste: true` (named like `Pasted text.md`). Its file link answers **404 "File not found"**, and the page's preview shows only the name. The text the model read is in a tool message (`api_tool`, `multimodal_text`, hidden): a header part (`Use ref_id "turn<N>file<M>"`, `Full file size: <n> file lines.`), then the text with `[L<n>] ` before each line, **cut at 16,384 characters** markers included. A shorter text is the whole paste (11,408 bytes, byte for byte the stated size); a longer one is only its beginning. `file<M>` counts the user message's files that are not images. The same holds for documents: the extension saves this text as `<name>.extracted.txt` when the file itself is gone, marked complete or "beginning only".
- **Old uploads** without `library_file_id` answered 404 too, with no text to fall back to: they are noted as unavailable.
- **New tools**: code runs through `container.exec` (shell commands as plain text, output in `execution_output`), `container.open_image` (its result message carries the image in `metadata.attachments`), `local.handoff` (`{prompt, reason}`) and connectors (`api_tool.call_tool`, `api_tool.list_resources`). The image tool now sends its real arguments (`{prompt, size, n, …}`) to an internal recipient such as `t2uay3k.sj1i4kz`.
- **Rate limit**: after a few hundred quick reads in a row, the conversation endpoint answered **429** to most requests, even 4–8 s apart, with no `Retry-After`, for several minutes. The list kept answering.

## 6. Canvas

On this plan Canvas is **a block in the answer**, not a separate document: `<WritingBlock id="58321" variant="document"># Apple Notes …</WritingBlock>`. `message.metadata.writing_blocks[id]` has `content`, `variant`, `edited` and suggested follow-ups. **An edit the user makes in the canvas changes `writing_blocks[id].content`, not the answer text**, so the block's content is taken from the metadata. The old documents API (`/conversation/{id}/textdocs`) returned `[]`. A code canvas (`variant` other than `document`) was not seen.

## 7. Reasoning, search, code

- **Reasoning** ("Think longer", or automatic): `thoughts` nodes with step summaries and text, then a `reasoning_recap`. The "Think longer" answer in the test had only the recap.
- **Web search**: an assistant `text` node addressed to `web.run`, a tool node, then the answer with `metadata.search_result_groups: [{ domain, entries: [{ title, url, snippet, pub_date, attribution, ref_id: { turn_index, ref_type: "search", ref_index } }] }]`.
- **Code** (data analysis): `code` addressed to `python`, then `execution_output` with `metadata.aggregate_result`.

## 8. Temporary chats, projects, limits

- **Temporary chats** open at `/?temporary-chat=true`; after the first answer the address is `/c/<id>?temporary-chat=true`. The conversation API returns them (`is_temporary_chat: true`) while the chat is open, but **they are not in the list**, and the chat was gone (404) once the page moved on. So only "Save this chat" on the open page can save one.
- **Projects** (seen 2026-10-16, one project with two chats): the id is `g-p-<32 hex>`, the page `/g/g-p-<hex>-<slug>/project`, a chat `/g/g-p-<hex>-<slug>/c/<uuid>`; the chat's `gizmo_id` is the project. The gizmo has `display.name`, `display.description`, `instructions`, `short_url`, `created_at`, `updated_at`; custom GPTs have `g-` ids without `p-`. The project's own `files` were empty, so their shape is a guess: the adapter reads `file_id` or `id`, `name`, `type`, `size`, and asks `files/download/{id}` for a link without `conversation_id` (**unverified**).
- **Custom GPTs**: none in this account; **unverified**.
- **Rich answers** (2026-10-16): an answer can lay out cards with tags in the Markdown: `<row>`, `<box>`, `<text>`, `<icon/>` and `<button onClick={()=>…("sandbox:/mnt/data/x.pdf")}>`. The files the buttons download are files made by code, like `[x](sandbox:…)` links; the code ran through a tool with an opaque name, not `python`. The extension keeps the text of the layout and drops the tags.
- **Rate limits**: 40 conversations in a row, about 1.7 s each (slowest 3.1 s), all `200` on the Free plan. A Team workspace answered 429 after many more (section 5); the adapter keeps a gap between its requests that widens after each 429, waits 15, 30, 60 and 120 s for a refused one, and a bulk export stops if that is not enough.

## 9. Open questions

1. **A project's own files** (none in the test project) and **custom GPTs**.
2. **Code canvas** and canvas versions on a paid plan.
3. **Deep Research**: not tried (long, uses the quota).
4. **Image edits** and voice chats.
5. Whether a long conversation is ever truncated (`context_truncation_continuation`).
6. **Full text of a long paste**: no request found that gives more than the first 16,384 characters; ChatGPT's own preview shows only the name.
7. **The rate limit's rules**: how many reads, over how long; the Team account was limited after a few hundred reads in a row.

## 10. Fixtures

| File                          | What it shows                                                       |
| ----------------------------- | ------------------------------------------------------------------- |
| `conversation-branches.json`  | Markdown answer; a regenerated answer with reasoning recap; an edit |
| `conversation-uploads.json`   | pdf, docx and png uploads, file reading, code, thoughts, `FileCite` |
| `conversation-image.json`     | A generated image                                                   |
| `conversation-code-file.json` | A CSV made by code, linked as `sandbox:/mnt/data/fruits.csv`        |
| `conversation-canvas.json`    | A `WritingBlock` document, edited in the canvas afterwards          |
| `conversation-search.json`    | Web search: `Cite`, `Entity`, `search_result_groups`                |
| `conversation-temporary.json` | A temporary chat                                                    |
| `conversations-list.json`     | A list page, reduced to the test chats                              |

How they were made: test chats were created in a test account, the answers recorded, and the chats and their Library files deleted. UUIDs (conversations, messages, requests, generations) and `file_` / `libfile_` ids are replaced with stable fake values; the files were checked for emails, user and account ids and location fields before saving. Message texts are the synthetic test prompts, the test files' text, and public search results.
