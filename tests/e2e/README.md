# Stands (end-to-end tests)

Each stand runs the built extension in Chrome for Testing against a fake platform: a local HTTPS server answers as claude.ai, chatgpt.com, gemini.google.com or grok.com from `tests/fixtures/`, and Chrome is pointed at it with `--host-resolver-rules`. The extension is driven over the DevTools protocol the way a user would: a chat tab and the shortcut's export, or the export page and its buttons. Each scenario asserts what was saved: names, bytes, folders, the job's counts, what the page shows.

```sh
npm run e2e                 # every scenario
npm run e2e -- gemini list  # scenarios whose name contains "gemini" or "list"
```

Needs Chrome for Testing (`npx playwright install chromium`, or `CHROME_PATH=/path/to/chrome`) and `openssl` for a throwaway certificate. The extension is built into a temporary folder, never into `dist/`. The stands are not part of CI, which has no Chrome; run them before a release. All of them take about ten minutes.

| Scenario            | What it checks                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-bulk`       | Five Claude chats: uploads, files the model made and a published artifact byte for byte, every branch; a project with its knowledge base and chat                                |
| `chatgpt-current`   | Six ChatGPT chats as files and as a ZIP; uploads, a generated image and a file made by code byte for byte; the token only on API requests                                        |
| `chatgpt-bulk`      | The export page: history over two pages, archived and project chats; one ZIP; a file that never arrives brings its chats back on the next run, the rest are skipped as unchanged |
| `downloads-dropped` | Separate files over a dropped connection: a file cut twice is saved under its own name; one that never arrives leaves nothing behind                                             |
| `worker-restart`    | The worker is stopped during a stalled download; Chrome resumes it and the file keeps its name                                                                                   |
| `expired-link`      | An expired signed link is asked again, as files and in a ZIP                                                                                                                     |
| `folder-rewrite`    | A chat that missed a file completes its folder; a complete one makes a copy; overwriting deletes a file the chat no longer has                                                   |
| `gemini-current`    | Gemini chats, documents byte for byte, a generated image, a Gem's name                                                                                                           |
| `gemini-images`     | A re-encoded png saved as `.jpg`; fetched once for a ZIP                                                                                                                         |
| `gemini-search`     | Search results appear as they come, are remembered after a reload, and can be forgotten                                                                                          |
| `gemini-notebook`   | A notebook from the Notebooks tab: its sources listed by name, its four chats in `chats/`                                                                                        |
| `list-stop`         | A slow list stopped halfway keeps what it read; "Load the whole list" brings the rest                                                                                            |
| `grok-current`      | Grok chats; uploads and a generated image from assets.grok.com byte for byte                                                                                                     |

The Claude stand has no sandbox or timeline stream: chats whose files are only in the sandbox are covered by unit tests on recorded responses.
