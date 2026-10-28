# Platform notes: gemini.google.com

What the extension needs from Gemini, as observed on 2026-10-13 and 2026-10-14 (web app build `boq_gemini-web-uiserver_20261012.15_p0`, Pro plan, model "3.8 Flash"). The page changed between the two days ("Gemini 4" banner, a new Canvas), so the date matters. Items marked **unverified** were not seen in this account.

Fixtures live in [`tests/fixtures/gemini/`](../tests/fixtures/gemini/). They come from test chats created for this purpose and deleted afterwards; every id, token and personal value in them is replaced (see [Fixtures](#10-fixtures)).

## Contents

1. [Key findings](#1-key-findings)
2. [Calling the API](#2-calling-the-api)
3. [Conversation list](#3-conversation-list)
4. [Conversation history](#4-conversation-history)
5. [Files from the user](#5-files-from-the-user)
6. [Generated images, Canvas, Gems](#6-generated-images-canvas-gems)
7. [Notebooks](#7-notebooks)
8. [Branches](#8-branches)
9. [Open questions](#9-open-questions)
10. [Fixtures](#10-fixtures)

## 1. Key findings

- **The adapter can read Gemini through its API, not the page.** The `batchexecute` endpoint the web app uses can be called from a gemini.google.com tab with the user's cookies. The tokens it needs are in the HTML of `/app`. No DOM reading, no MAIN-world script and no HTML-to-Markdown conversion are needed: replies come as **Markdown**. This replaces the DOM strategy of the specification.
- **History comes in pages of 10 turns**, newest first, each turn with its time and the model.
- **The list has the last update time, not the creation time**: the creation date is the time of the oldest turn.
- **Uploaded documents download byte for byte.** Uploaded images come at full size but re-encoded.
- **Generated images are available at full size** (`=s0` or `=d` on their `lh3` URL).
- **Canvas now creates a Google Docs document** in the user's Drive; the chat keeps only a link.
- **Only the visible branch is kept**: Redo replaces the answer; "Branch in new chat" creates another chat.
- **The list stops at about 1,000 chats** on a large account: deep pages run past the server's 10 seconds and fail with status 13 (section 3). Gemini's own search reaches older chats ([Search](#search)), and Google Takeout links to every chat ([Google Takeout](#google-takeout)).
- **Files can be gone**: a file Gemini removed keeps its entry without a link (section 5).
- **Notebooks are NotebookLM notebooks**: Gemini lists them, their sources and their chats, but gives no way to download a source (section 7).

## 2. Calling the API

All calls are `POST https://gemini.google.com/_/BardChatUi/data/batchexecute` from the gemini.google.com origin with cookies:

| Part     | Value                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| Query    | `rpcids=<id>`, `source-path=<page path>`, `bl=<cfb2h>`, `f.sid=<FdrFJe>`, `hl=en`, `_reqid=<random>`, `rt=c` |
| Headers  | `content-type: application/x-www-form-urlencoded;charset=UTF-8`, `x-same-domain: 1`                          |
| Body     | `f.req=[[["<id>","<JSON args>",null,"generic"]]]&at=<SNlM0e>`                                                |
| Tokens   | `SNlM0e`, `cfb2h`, `FdrFJe`: read from the HTML of `GET /app` (`"SNlM0e":"…"`)                               |
| Response | `)]}'` then length-prefixed lines; the line with `["wrb.fr","<id>","<JSON payload>",…]` holds the result     |

Checked: a call built this way from the page returned 200 with the conversation. The `at` token is a session secret: it is never stored or logged.

| RPC      | Arguments                                                              | Returns                                                 |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `MaZiqc` | `[pageSize, pageToken, [null,null,1,null,null,null,null,null,null,1]]` | A page of the conversation list                         |
| `MaZiqc` | `[1, null, [null,null,1,null,1,"c_<id>"]]`                             | One conversation's list entry (title, update time, Gem) |
| `hNvQHb` | `["c_<id>", 10, pageToken, 1, [1], [4], null, 1]`                      | A page of history: 10 turns                             |
| `CNgdBe` | `[1, ["en"], 0]`                                                       | Google's premade Gems with names and descriptions       |
| `CNgdBe` | `[2, ["en"], 0]`                                                       | The user's own Gems                                     |
| `CNgdBe` | `[2, ["en"], 0, null, [2]]`                                            | The user's notebooks                                    |
| `HcT8bb` | `["notebooks/<uuid>", ["en"], 1]`                                      | One notebook with its sources                           |
| `MaZiqc` | `[20, pageToken, [null,null,1,"notebooks/<uuid>",1]]`                  | A page of a notebook's chats                            |

## 3. Conversation list

`MaZiqc` returns `[null, nextPageToken, [item, …]]`. The first page has 27 items, then 20. **Pinned chats come first**, then the others by update time.

| Item index | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| 0          | Conversation id, `c_<16 hex>`; the page URL is `/app/<16 hex>` |
| 1          | Title                                                          |
| 2          | `true` when pinned                                             |
| 5          | `[seconds, nanos]`: **last update**                            |
| 7          | Gem id (`brainstormer`), or null                               |
| 21         | Chosen candidate of the last turn                              |

A full pass over 380 chats worked; the last page still had a token, so the account had more. **Deep pages are slow and fail (2026-10-14, an account with 800+ chats).** Gemini answers each page in more time the deeper it is: about 0.7 s for the first 200 chats, 2 s at 200–400, 7–10 s past 400. Past about 600 chats it more and more often answers with status 13 (INTERNAL) instead of data; a smaller page after a pause often passes, and the same page may pass or fail on the next try. Past about 800 chats almost every request fails. The web app's own sidebar sends the same request (`[20, token, same filter]`). Reading the whole list took 5 to 9 minutes and stopped at 700 to 860 chats.

**Why, and what helps (2026-10-28, a large account):**

- **The cost is depth, not page size.** A failed page takes 10.2 s every time: status 13 is the server giving up after 10 seconds. The page token is opaque (one protobuf field holding an encrypted blob that starts with the same 5 bytes) and grows by about 14 characters with every chat already listed, whatever the page size: 1.5 KB after 100 chats, 14 KB after 1,000. At a depth of 1,000 a page of 1 chat fails like a page of 100.
- **A page holds up to 100 chats** (`[100, token, filter]`; 200 still gives 100). With pages of 100, reading the list reached about 1,000 chats in a few minutes: pages took under a second at the top, about 4 s at 500 and 8–10 s at 800–1,000, and a failed page often passed on the next try. Past about 1,000 every try failed.
- **No filter splits the list into shorter ones.** The filter is the web app's `ListConversations` request (field numbers from 1; the list sends fields 3 and 10):

  | Field    | Meaning, from the web app's code and tries                                                         |
  | -------- | -------------------------------------------------------------------------------------------------- |
  | 1        | Pinned (true) or not pinned (false); the sidebar reads them apart, the extension together          |
  | 3        | Set by the web app for its own requests                                                            |
  | 4        | A string (a notebook: `notebooks/<uuid>`); a Gem id there gives nothing                            |
  | 5        | Set with field 6 to read one chat's entry                                                          |
  | 6        | One chat: `c_<id>`                                                                                 |
  | 10       | Pinned and not pinned together                                                                     |
  | 11       | A kind of chat: 1 and 6 give the usual list, 2–5 and 7 nothing on that account                     |
  | 12       | A list of task states, for agent tasks (`[4,1]` ready, `[3,5]` needs attention, `[2]` in progress) |
  | 7, 8, 13 | Flags; set alone, the list comes back empty                                                        |

  Not pinned (field 1 false) is the same deep list, and every other value either gives the whole list or nothing.

The extension asks for pages of 100 and tries a failing page up to six times with pauses of 2 to 20 s; if all fail, it shows the chats read so far with a note that older ones are missing. An answer without data and without a status (`["wrb.fr","MaZiqc",null,…]`) is taken as the end of the list; one with a status at index 5 (`google.rpc.Code`) is an error: 8, 13 and 14 are retried, 7 and 16 mean signed out.

### Search

The chat list cannot go past about 800 chats (above). The web app's search reaches the whole history (checked on 2026-10-15 on an account with 1,600+ chats: chats from February 2025 that the list never returned):

- `GET /_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery?query_signature=<sig>&variables={"includeEnterpriseStatus":true,"query":"<text>","queryEmpty":false}`, from the gemini.google.com origin with cookies, no extra headers.
- The answer is `[{ data: { viewer: { rpcs: { searchHistory: { historySnippets: [{ conversation: { conversationId: "c_<id>", title }, snippets: [{ text, timestamp }] }] } } } } }]`; `searchHistory` is `null` when nothing matches.
- **At most 20 chats per query**: the page size is a literal (`pageSize: 20`) in the registered query, and extra variables (`first`, `after`, `pageSize`) are ignored.
- `<sig>` is the registered query `SearchChatsPageRefetchQuery` in the web app's `SearchModalDialog-*.js` chunk (`id:\`2/…\`,metadata:{},name:\`SearchChatsPageRefetchQuery\``). An empty query (`queryEmpty: true`) returns 13 recent chats; the "recent chats" pagination query (`SearchChatsRecentsPaginationQuery`, `count`and`cursor`) wraps the same `ListConversations`backend as`MaZiqc`, cursor included, so it has the same depth limit.

Searching with common words and then with words from the titles found reached 692 chats beyond a 916-chat list in 519 queries (about 9 minutes, no errors at about one query per second); new chats kept appearing more slowly. Each chat found downloads through `hNvQHb` like any other.

**Snippets hold most of the matching messages (2026-10-28):** each chat has up to two snippets, about 5 KB of text on average and sometimes over 100 KB, so they give far more words to search next than titles do. Over the same queries after the seed words, words from titles and snippets found about 1.5 times as many chats outside the list as words from titles taken in turn, and about 1.65 times as many when the words of chats outside the list go first and the words of listed chats last (each chat outside the list adds 1 to a word, each listed one takes 0.7). Dates as queries (`2024`, `январь`, `March`) find no more than other words.

### Google Takeout

**Takeout links to every chat (2026-10-28, a large account).** takeout.google.com, My Activity with only Gemini Apps, activity records as JSON: `Takeout/My Activity/Gemini Apps/MyActivity.json` (the folder names follow the account's language). It is an array of records, one per prompt (`title` "Prompted …") and a few others ("Created", "Cleared", "Gave feedback"): `header` "Gemini Apps", `time`, `products`, `activityControls`, the answer as `safeHtmlItem`, sometimes `subtitles`, `imageFile` and `attachedFiles`, and almost always `details: [{ name, url }]` with the chat's link, `https://gemini.google.com/app/<16 hex>`. There is no `titleUrl`. The file linked to every chat the list and the search had found but one, and to about a third more that neither had reached, back to the first months of the account. Every one of a sample of these opened through `hNvQHb`, and `MaZiqc` with the chat's id in the filter gave its list entry (title, update time), the same entry as the list's, in about 0.4 s whatever the chat's age. The archive also holds the files of the prompts (`imageFile`, `attachedFiles`) and can be over a gigabyte; unpacking only the activity file as the archive is read takes seconds. Through the export page, adding every chat the table lacked took about a minute for several hundred chats, four lookups at a time with no errors; one id had no entry (a deleted chat). On a larger import, four at a time, Gemini refused some chats past each request's three retries (1, 2 and 4 s); adding the file again read them all. So the lookups slow to one at a time once Gemini refuses, and the refused ones are asked again after longer pauses.

## 4. Conversation history

`hNvQHb` returns `[[turn, …], nextPageToken, …]`, **newest turn first**. A second call with the token returns the next 10 turns. A turn:

| Path                 | Meaning                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `[0]`                | `["c_<id>", "r_<id>"]`: conversation and response ids                                  |
| `[1]`                | Parent: `["c_<id>", "r_<previous>", "rc_<chosen candidate>"]`, null for the first turn |
| `[2][0][0]`          | The user's prompt                                                                      |
| `[2][0][4][0][3]`    | The user's uploaded files (section 5)                                                  |
| `[3][0]`             | Candidates: `[ "rc_<id>", [ "<Markdown>" ], … ]`                                       |
| `[3][3]`             | The chosen candidate id                                                                |
| `[3][21]`, `[3][31]` | Model: `3.8 Flash`, `gemini-3.8-flash`                                                 |
| `[4]`                | `[seconds, nanos]`: time of the turn                                                   |

Replies are Markdown: lists, `**bold**`, fenced code with the language. Two things need cleaning: **`[cite: N]` markers** pointing at uploaded files, and the image placeholder of section 6.

## 5. Files from the user

Each uploaded file in `[2][0][4][0][3]`:

| Index | Meaning                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1     | Kind: 1 image, 10 docx, 11 pdf                                                                                                |
| 2     | File name                                                                                                                     |
| 3     | Images: `https://lh3.googleusercontent.com/gg/…`                                                                              |
| 5     | An opaque token                                                                                                               |
| 7     | Documents: `[thumbnail, download, viewer]`; download is `https://contribution.usercontent.google.com/download?c=…&filename=…` |
| 15    | Images: `[width, height, bytes]`                                                                                              |

- **Documents**: the `contribution.usercontent.google.com` URL returned the pdf and the docx **byte for byte** (downloaded with the user's cookies).
- **Files that Gemini removed**: a file can keep its entry without a download link, with `[4] = [n, null, <id>]` in place of the link; the page then shows "This file has been removed" (seen 2026-10-15 for a spreadsheet that code execution had made). It cannot be saved. Audio uploads (`kind` 4 or 0, `audio/wav`) download from `contribution` like documents.
- **Images**: some `lh3.googleusercontent.com/gg/…` URLs redirect to `lh3.google.com/rd-gg/…` (seen 2026-10-14), which answers `Access-Control-Allow-Origin: *`; a fetch with cookies from the extension needs a host permission for that host too, or CORS blocks it. The `lh3` URL needs the user's Google cookies (without them it redirects to sign-in) and is CORS-protected from the page. Opened in a tab, it returned the image at full size (90×60) but **re-encoded**: 415 bytes instead of 198. The note should say so. The format can change too (a `.png` upload came back as a JPEG), so the extension renames such a file after its first bytes.
- Checked again on the new page on 2026-10-14: the same format, and the pdf and the docx again downloaded byte for byte. Gemini took about 2.5 minutes to answer a message with attachments.

## 6. Generated images, Canvas, Gems

- **Generated image**: the candidate text is a placeholder, `http://googleusercontent.com/image_generation_content/0_<n>`. The image is at `[3][0][0][12][7][0][0][0]`: name `watermarked_img_<n>.jpg`, `lh3` URL at index 3, mime at 11, `[width, height, bytes]` at 15 (1376×768). The plain URL gives a 512 px preview; **`=s0` gives the full size**, `=d` downloads it under its name. A `thought_signature_<n>.pb` file next to it is internal and not exported.
- **Canvas** (2026-10-14): Gemini creates a **Google Docs document** in the user's Drive. The reply says so in Markdown with a link, and the file appears as kind 8, `application/vnd.google-apps.document`, with `docs.google.com/document/d/<id>/edit` links. The document's text is not in the chat. On 2026-10-13 the same request put the document into the reply as Markdown. The exporter keeps the link; downloading the document would need Drive access, which is out of scope.
- **Gems**: a Gem chat lives at `/gem/<gem id>/<16 hex>`. The list entry has the Gem id at index 7; names come from `CNgdBe` (`[1,["en"],0]` for premade Gems, `[2,["en"],0]` for the user's own).

## 7. Notebooks

Seen on 2026-10-15 in one notebook with one pdf source and four chats. RPC names come from the web app's scripts, where each is declared as `{Ob:"<rpc>",Rb:"/BardFrontendService.<Method>"}`; the scripts are served from `gemini.gstatic.com`.

- **Page**: `/notebook/<uuid>` (also under `/u/<n>/`). The same id opens the notebook at `notebooklm.google.com/notebook/<uuid>`: a Gemini notebook is a NotebookLM notebook.
- **List** (`CNgdBe` with the filter `[2]`, method `ListBots`): `[null, null, [notebook, …]]`. A notebook entry starts with its id `notebooks/<uuid>`, then the details.
- **Notebook** (`HcT8bb`, `GetBot`): `[notebook]`. The title is at `[0][1][0]`, the sources at `[0][1][10][0]`, the update time at `[1][14][1]` and the creation time at `[1][14][4]` (`[seconds, nanos]`). A source has its file name at `[2]`, the token `notebooks/<uuid>/sources/<id>` at `[5]`, the time at `[9]` and the mime type at `[11]`.
- **Chats** (`MaZiqc` with the notebook in the filter): the usual list entries, with the notebook id at index 7 where a Gem chat has its Gem id. A notebook chat opens at `/app/<16 hex>`.
- **Sources cannot be downloaded.** The service has only `CreateNotebookSource`, `DeleteNotebookSource` and `RefreshNotebookSource` for them; no request in the page returns a file or a link. The exporter lists each source by name and says so in the note; the files stay in NotebookLM.

## 8. Branches

After **Redo**, the turn gets a new response id and the earlier answer is **no longer in the history**. Each turn keeps only its chosen candidate (an empty second candidate may appear, from a post-processor). **Branch in new chat** creates a separate conversation. The exporter exports what the user sees; there are no other branches to export.

## 9. Open questions

1. **Deep Research**: not tried (several minutes and the user's quota).
2. **Video and music generation**: not tried. **Notebooks** with several kinds of sources (links, Google Docs, YouTube, pasted text): only a pdf was seen.
3. **Temporary chats**: not tried.
4. **Rate limits**: no 429 seen; the list's deep pages answer status 13 instead (section 3).

## 10. Fixtures

| File                                 | What it shows                                                |
| ------------------------------------ | ------------------------------------------------------------ |
| `conversation-basic.json`            | Two turns, Markdown with a list, bold and code, after a Redo |
| `conversation-long.json`             | 11 turns: two pages of history, linked by a page token       |
| `conversation-image.json`            | A generated image                                            |
| `conversation-canvas.json`           | Canvas as a Google Docs document                             |
| `conversation-upload-image.json`     | An uploaded png                                              |
| `conversation-upload-documents.json` | An uploaded pdf and docx with their download links           |
| `conversation-gem.json`              | A chat with the Brainstormer Gem                             |
| `conversations-list.json`            | A list page, reduced to the test chats                       |
| `gems-premade.json`                  | Premade Gems                                                 |
| `notebooks-list.json`                | The notebook list                                            |
| `notebook-get.json`                  | A notebook with one pdf source                               |
| `notebook-chats.json`                | The notebook's four chats                                    |

Each conversation file is `{ history: [page, …], meta: <MaZiqc entry> }`. How they were made: test chats were created, the responses recorded, the chats deleted. Conversation ids, response and candidate ids, other 16-hex ids, UUIDs, page tokens, URL path segments and query values, the Google Docs id, the account id and the country are replaced with stable fake values; the files are checked for leftovers before saving. Message texts are the synthetic test prompts and answers.
