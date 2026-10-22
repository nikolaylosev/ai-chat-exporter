# Chrome Web Store listing

What goes into each field of the listing in the [Chrome Web Store developer console](https://chrome.google.com/webstore/devconsole). The images are made by `node scripts/store-images.mjs` from the real extension on a stand with made-up chats; run it again after a visible change to the popup or the export page.

## Package

Upload `ai-chat-exporter-<version>.zip` from the [release](https://github.com/nikolaylosev/ai-chat-exporter/releases) as it is: `manifest.json` is at its root. Each upload needs a higher version than the last one.

## Store listing tab

| Field                  | Value                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Name                   | From the package: "CodingCat AI Chat Exporter" (both languages)                                                          |
| Summary                | From the package (`extDescription` in `scripts/locales.py`), English and Russian                                         |
| Description            | [description.en.txt](description.en.txt); for Russian, [description.ru.txt](description.ru.txt)                          |
| Category               | Productivity › Tools (a category is chosen inside a group; Workflow & Planning would be the second choice)               |
| Language               | English; add Russian as a second language with its description                                                           |
| Store icon             | From the package (`icons/icon-128.png`)                                                                                  |
| Screenshots (1280×800) | `screenshot-1-popup.png`, `screenshot-2-choose.png`, `screenshot-3-progress.png`, `screenshot-4-note.png`, in this order |
| Small promo tile       | `promo-small-440x280.png` (required)                                                                                     |
| Marquee promo tile     | Not needed                                                                                                               |
| Homepage URL           | https://github.com/nikolaylosev/ai-chat-exporter                                                                         |
| Support URL            | https://github.com/nikolaylosev/ai-chat-exporter/issues                                                                  |
| Mature content         | No                                                                                                                       |

The screenshots are in English; the same ones can be used for the Russian listing.

## Not here yet

The Privacy practices tab (single purpose, a justification for each permission, data use, a privacy policy URL) and the Distribution tab.
