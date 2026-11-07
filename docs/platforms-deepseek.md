# Platform notes: chat.deepseek.com

What the extension needs from DeepSeek, as observed on 2026-11-07 (free account, web app `main.9120333998.js`). Items marked **unverified** were not available on this account or not tried.

Fixtures live in [`tests/fixtures/deepseek/`](../tests/fixtures/deepseek/). They keep the shape of real answers, with every text, title, file name, link and id replaced (see [Fixtures](#8-fixtures)).

## Contents

1. [Key findings](#1-key-findings)
2. [Endpoints](#2-endpoints)
3. [Conversation format](#3-conversation-format)
4. [Branches](#4-branches)
5. [Files from the user](#5-files-from-the-user)
6. [The official export](#6-the-official-export)
7. [Open questions](#7-open-questions)
8. [Fixtures](#8-fixtures)

## 1. Key findings

- **The web app reads plain JSON** under `/api/v0/`. A same-origin `fetch` from a chat.deepseek.com tab works with one header: `Authorization: Bearer <token>`, where the token is `value` in the page's `localStorage.userToken` (`{"value":"…","__version":"0"}`). Cookies are not needed. Reads need no proof-of-work header; only writes (sending a message, uploading) do.
- **Every answer is HTTP 200** with an envelope `{ code, msg, data: { biz_code, biz_msg, biz_data } }`. `code` 40003 (`INVALID_TOKEN`) means signed out, 40029 means too many requests; `biz_code` other than 0 means the request was refused, with the reason in `biz_msg`.
- **A chat comes whole** in one request, as a tree of messages made of typed fragments. Answers are Markdown.
- **Documents download byte for byte; images do not.** For an uploaded image the file host serves only a re-encoded preview (about 1800 px on the long side). Old uploads have no file at all any more.
- **No projects, folders or custom agents.** Pinned chats exist.
- Pages sit behind an AWS WAF challenge; the API does not.

## 2. Endpoints

| Purpose      | Request                                                                           | Notes                                                                         |
| ------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| List chats   | `GET /api/v0/chat_session/fetch_page?count=100&lte_cursor.pinned=false`           | `{ chat_sessions, has_more }`; pinned chats first, then newest first          |
| Next page    | `…&lte_cursor.pinned=<last.pinned>&lte_cursor.updated_at=<last.updated_at>`       | The cursor is inclusive: the page starts with the last chat of the one before |
| One chat     | `GET /api/v0/chat/history_messages?chat_session_id={id}`                          | `{ chat_session, chat_messages, cache_control: "REPLACE", cache_reset_at }`   |
| File links   | `GET /api/v0/file/fetch_files?file_ids={id}` (the parameter repeated for several) | `{ files: [...] }` with a fresh `signed_path`; an empty list for old uploads  |
| File bytes   | `GET https://files.deepseeksvc.com/api{signed_path}&ty={r\|p\|t}`                 | No cookies, no token, no CORS headers (section 5)                             |
| Shared chat  | `GET /api/v0/share/content?share_id={id}`                                         | `{ title, model_type, messages }`; works without the token                    |
| Shared links | `GET /api/v0/share/list?count=20&lte_date=<seconds>`                              | `{ shares: [{ share_id, hint, created_at, chat_session_id }] }`               |
| Export       | `GET /api/v0/export_all`, then `GET /api/v0/download_export_history`              | Section 6                                                                     |
| Search       | `GET /api/v0/index/query`                                                         | The server's full-text search, with highlighted parts; **unverified**         |

`count` must be more than 1 and at most 100: `count=1` is refused with `illegal count`, a larger value returns nothing. `has_more` is false on the last page.

The web app's other paths, for reference: `auth/ticket`; `chat/` `completion`, `continue`, `create_pow_challenge`, `edit_message`, `message_feedback`, `regenerate`, `resume_stream`, `stop_stream`, `tts`; `chat_session/` `batch_update_pinned`, `create`, `delete`, `delete_all`, `update_title`; `client/settings`; `file/` `fork_file_task`, `upload_file`; `index/prepare`; `share/` `create`, `delete`, `fork`; `users/…`.

## 3. Conversation format

A list entry: `id`, `title`, `title_type` (`SYSTEM`), `model_type` (`default`), `pinned`, `updated_at`. The chat's `chat_session` adds `inserted_at`, `current_message_id`, `seq_id`, `agent` (`chat`), `version` and `is_empty`. Times are seconds since the epoch, with a fraction.

**`updated_at` moves on pinning and unpinning too**, without a new message, so a changed `updated_at` does not always mean new messages.

A message: `message_id` (a number, from 1 in each chat), `parent_id` (null for a root), `role` (`USER`, `ASSISTANT`), `status` (`FINISHED`, `INCOMPLETE`), `inserted_at`, `thinking_enabled`, `search_enabled`, `conversation_mode` (missing, or `SEARCH`), `fragments`, and fields the extension does not use (`model`, always empty; `feedback`; `accumulated_token_usage`; `ban_edit`, `ban_regenerate`; `incomplete_message`, null even on `INCOMPLETE`). Older formats with flat `content` and `thinking_content` were not seen.

Fragments, in the order the page shows them:

| Type                | Fields                                              | What it is                                                              |
| ------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `REQUEST`           | `content`                                           | The user's prompt                                                       |
| `FILE`              | `files`                                             | The user's uploads (section 5)                                          |
| `SEARCH`            | `status`, `queries` (always empty), `results`       | Web results: `url, title, snippet, cite_index, site_name, published_at` |
| `THINK`             | `content`, `elapsed_secs`, `references`, `stage_id` | Reasoning ("DeepThink")                                                 |
| `RESPONSE`          | `content`, `references` (always empty), `stage_id`  | The answer, Markdown                                                    |
| `TEMPLATE_RESPONSE` | `content`                                           | "The server is busy. Please try again later." in place of an answer     |
| `TIP`               | `content`, `style` (`INFO`), `hide_on_wip`          | A hint from the web app                                                 |

The web app also knows `TOOL_SEARCH`, `TOOL_OPEN`, `TOOL_FIND` and `READ_LINK`; none was seen. "Deep Search" (`conversation_mode: DEEP_SEARCH`) is in the code but not offered in the web app.

**Citations** are `[citation:N]` in an answer, where N is the `cite_index` of a result in the same message's `SEARCH` fragment. Results without `cite_index` were found but not cited. The adapter turns a run of marks into `([Site](url), …)` and lists every result in a web search block.

An answer stopped before it said anything is an `ASSISTANT` message with status `INCOMPLETE` and no fragments.

## 4. Branches

The tree is held by `parent_id`. Editing a prompt adds a sibling `USER` message; editing the first prompt adds a second root (`parent_id: null`). Regenerating adds a sibling `ASSISTANT` message under the same prompt. `current_message_id` is the last message of the branch the page shows; walking `parent_id` from it gives that branch. The adapter keeps every other leaf as a branch.

## 5. Files from the user

A file in a `FILE` fragment: `id`, `file_name`, `file_size`, `is_image`, `status` (`SUCCESS`; the code also knows `PARSING`, `FAILED`, `CONTENT_FILTER`, `CONTENT_TOO_LONG`, `CANCELLED`, `CONTENT_EMPTY`), `from_share`, `token_usage`, `model_kind`, `audit_result`, `error_code`, `inserted_at`, `updated_at`. A recent upload also has `signed_path`, and an image `width` and `height`.

`signed_path` is `/file?file_id=<uuid>&state=<signature>`. The link is `https://files.deepseeksvc.com/api` + `signed_path` + `&ty=`, and `ty` is required:

| `ty` | Document           | Image                                            |
| ---- | ------------------ | ------------------------------------------------ |
| `r`  | The original bytes | HTTP 400, empty body                             |
| `p`  | HTTP 400           | A preview, WebP (about 1800 px on the long side) |
| `t`  | HTTP 400           | A thumbnail, WebP (240 px)                       |

`fmt=jpeg` turns a preview or a thumbnail into JPEG; an unknown `fmt` is ignored. The answers carry no `Content-Disposition` and no `Access-Control-Allow-Origin`, so a page cannot read them, while the extension can with a host permission for `files.deepseeksvc.com`. Cookies and the token are not needed. `history_messages` gave the same signature minutes apart and it still worked; `fetch_files` gives a new one.

The adapter saves a document by `ty=r` and an image by `ty=p&fmt=jpeg`, named `.jpg` and marked as a preview in the note (Word notes cannot show WebP).

**Old uploads have no `signed_path`**, `fetch_files` returns nothing for them, and the web app shows them as a card that cannot be opened: the server keeps only their name and size. The note names them as files the service does not provide.

## 6. The official export

Settings > Data > Export data. It was ready within seconds; `download_export_history` gives `status` (`FINISHED`), `history_download_url`, `legacy_history_download_url`, `exported_at` and `expires_at` (7 days), or `biz_code 1, TASK_NOT_FOUND` before the first export. `export_all` has a rate limit. The file is a ZIP on Huawei Cloud OBS (`deepseek-chat-history-exports-prod.obs.cn-east-3.myhuaweicloud.com`, a signed link) with `user.json` and `conversations.json`.

`conversations.json` is a list of `{ id, title, inserted_at, updated_at, mapping }` with ISO times. `mapping` is a tree like ChatGPT's: a node `root` without a message, then `{ id, parent, children, message }`. Every branch is kept, but nothing says which one is current, and there is no role (a `REQUEST` fragment means the user). Fragments keep only `type` and `content`; `FILE` keeps `file_id, file_name, file_size` and no file; `SEARCH` keeps `title, url` without `cite_index`; `TEMPLATE_RESPONSE` comes out as `RESPONSE`. The API gives more in every respect, so the extension does not use the export.

## 7. Open questions

- Whether the list's paging holds over hundreds of chats on a real account (tested on the stand only).
- Tool fragments (`TOOL_SEARCH`, `TOOL_OPEN`, `TOOL_FIND`, `READ_LINK`) and Deep Search: not offered on this account.
- How long `signed_path` stays valid; the adapter asks `fetch_files` for a new one when a file is refused.
- When the server drops upload bytes: seen missing on uploads from months before, present on uploads from the same day.

## 8. Fixtures

`history-*.json` are `history_messages` answers and `chat-sessions.json` a list page, made in the browser from real answers: prompts, answers, reasoning, titles and file names replaced with synthetic text, search results pointed at `example.com`, signatures replaced with `TEST-STATE`, and every id replaced with `00000000-0000-4000-8000-…`. Citation marks, fragment types, statuses, times and the tree are as they were.
