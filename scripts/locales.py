"""Source of truth for UI strings. Writes public/_locales/{en,ru}/messages.json.

Run: python3 scripts/locales.py

Substitutions are written as $1, $2 here and converted to Chrome's documented
placeholder form ($ARG1$ plus a "placeholders" entry).
"""
import json
import re
from pathlib import Path

# key: (English, Russian)
STRINGS = {
    "extName": ("CodingCat AI Chat Exporter", "CodingCat AI Chat Exporter"),
    "extDescription": (
        "Export Claude, Gemini, Grok and ChatGPT chats to Markdown with all attachments.",
        "Экспорт чатов Claude, Gemini, Grok и ChatGPT в Markdown со всеми вложениями.",
    ),
    "commandExportCurrent": ("Save the current chat", "Сохранить текущий чат"),
    "untitledChat": ("Untitled", "Без названия"),
    "untitledProject": ("Untitled project", "Проект без названия"),
    "untitledNotebook": ("Untitled notebook", "Блокнот без названия"),
    # Popup
    "popupUnsupported": (
        "Open a chat on claude.ai, gemini.google.com, grok.com or chatgpt.com to export it.",
        "Откройте чат на claude.ai, gemini.google.com, grok.com или chatgpt.com, чтобы сохранить его.",
    ),
    "popupDetected": ("$1 chat is open.", "Открыт чат $1."),
    "popupNotAChat": (
        "Open a conversation to save it.",
        "Откройте разговор, чтобы сохранить его.",
    ),
    "popupSaveChat": ("Save this chat", "Сохранить этот чат"),
    "popupSaving": ("Saving…", "Сохраняю…"),
    "popupDone": ("Done: $1 messages, $2 files.", "Готово: сообщений $1, файлов $2."),
    "popupDonePartial": (
        "Saved $1 messages and $2 files; $3 files could not be saved (marked in the note).",
        "Сохранено сообщений $1 и файлов $2; файлов не удалось сохранить: $3 (помечены в заметке).",
    ),
    "savedToDownloads": ("Saved to Downloads:", "Сохранено в Загрузки:"),
    "savedToFolder": ("Saved to the folder “$1”:", "Сохранено в папку «$1»:"),
    "savedTo": ("Saved to:", "Сохранено:"),
    "savedToArchive": ("In the archive “$1”:", "В архиве «$1»:"),
    "saveAsZip": ("Save as .zip", "Сохранить в .zip"),
    "saveWithFiles": ("Save with files", "Сохранять с файлами"),
    "copyToClipboard": (
        "Copy to the clipboard instead of saving",
        "Копировать в буфер обмена вместо сохранения",
    ),
    "popupCopyChat": ("Copy this chat", "Скопировать этот чат"),
    "popupCopying": ("Copying…", "Копирую…"),
    "popupCopied": ("Copied to the clipboard: $1 messages.", "Скопировано в буфер обмена: сообщений $1."),
    "panelClose": ("Close", "Закрыть"),
    "popupChooseChats": ("Choose chats…", "Выбрать чаты…"),
    "popupChooseProjects": ("Choose projects…", "Выбрать проекты…"),
    "popupChooseNotebooks": ("Choose notebooks…", "Выбрать блокноты…"),
    "popupProjectPage": ("Claude project page.", "Открыта страница проекта Claude."),
    "popupNotebookPage": ("Gemini notebook page.", "Открыт блокнот Gemini."),
    "popupProject": ("Project: $1", "Проект: $1"),
    "popupNotebook": ("Notebook: $1", "Блокнот: $1"),
    "popupSaveProject": ("Save project with its chats", "Сохранить проект с чатами"),
    "popupSaveNotebook": ("Save notebook with its chats", "Сохранить блокнот с чатами"),
    "popupJobRunning": ("Bulk export: $1 of $2.", "Массовый экспорт: $1 из $2."),
    "popupJobOpen": ("Open", "Открыть"),
    # Export page
    "exportTitle": ("Export from $1", "Экспорт из $1"),
    "exportPlatform": ("Platform", "Платформа"),
    "exportUpdatedFrom": ("Updated from", "Изменён с"),
    "exportColGem": ("Gem", "Gem"),
    "exportIntro": (
        "Pick the chats or projects to save. The export goes on in the background if you close this tab.",
        "Отметьте чаты или проекты для сохранения. Экспорт продолжится в фоне, даже если закрыть эту вкладку.",
    ),
    "exportSearch": ("Search", "Поиск"),
    "exportSearchPlaceholder": ("Title or project", "Заголовок или проект"),
    "exportFrom": ("Created from", "Создан с"),
    "exportTo": ("to", "по"),
    "exportLoading": ("Loading the chat list…", "Загружаю список чатов…"),
    "exportSearchMore": (
        "Find more chats with Gemini search",
        "Найти больше чатов через поиск Gemini",
    ),
    "exportSearchHint": (
        "Gemini's list stops at about 800 chats. Its search reaches older ones, 20 per query, so this takes a few minutes and may still miss some.",
        "Список Gemini обрывается примерно на 800 чатах. Его поиск достаёт и более старые, по 20 за запрос: это займёт несколько минут, и часть чатов всё равно может не найтись.",
    ),
    "exportSearchRunning": (
        "Searching Gemini… $1 more chats found, $2 queries.",
        "Ищу через поиск Gemini… найдено ещё $1, запросов $2.",
    ),
    "exportSearchStop": ("Stop", "Стоп"),
    "exportSearchDone": (
        "Search found $1 more chats ($2 queries).",
        "Поиск нашёл ещё $1 чатов (запросов: $2).",
    ),
    "exportSearchAgain": ("Search more", "Искать ещё"),
    "exportSearchRemembered": (
        "$1 chats found by an earlier search are in the list.",
        "В списке $1 чатов, найденных прошлым поиском.",
    ),
    "exportSearchForget": ("Forget them", "Забыть их"),
    "exportFoundBySearch": ("found by search", "найден поиском"),
    "exportArchived": ("archived", "в архиве"),
    "exportLoadingCount": (
        "Loading the chat list… $1 so far. A long list can take a few minutes.",
        "Загружаю список чатов… пока $1. Длинный список может грузиться несколько минут.",
    ),
    "exportRetry": ("Try again", "Повторить"),
    "exportSelectAll": ("Select all shown chats", "Выбрать все показанные чаты"),
    "exportSelectAllProjects": ("Select all shown projects", "Выбрать все показанные проекты"),
    "exportSelectAllNotebooks": ("Select all shown notebooks", "Выбрать все показанные блокноты"),
    "exportTabChats": ("Chats", "Чаты"),
    "exportTabProjects": ("Projects", "Проекты"),
    "exportTabNotebooks": ("Notebooks", "Блокноты"),
    "exportProjectSearchPlaceholder": ("Name or description", "Название или описание"),
    "exportProjectsLoading": ("Loading projects…", "Загружаю проекты…"),
    "exportNotebooksLoading": ("Loading notebooks…", "Загружаю блокноты…"),
    "exportNoProjects": ("No projects in this account.", "В аккаунте нет проектов."),
    "exportNoNotebooks": ("No notebooks in this account.", "В аккаунте нет блокнотов."),
    "exportColName": ("Name", "Название"),
    "exportColFiles": ("Files", "Файлов"),
    "exportStartProjects": (
        "Save selected projects with their chats ($1)",
        "Сохранить выбранные проекты с чатами ($1)",
    ),
    "exportStartNotebooks": (
        "Save selected notebooks with their chats ($1)",
        "Сохранить выбранные блокноты с чатами ($1)",
    ),
    "exportColTitle": ("Title", "Заголовок"),
    "exportColCreated": ("Created", "Создан"),
    "exportColUpdated": ("Updated", "Изменён"),
    "exportColProject": ("Project", "Проект"),
    "exportColStatus": ("Status", "Статус"),
    "exportNothingFound": ("No chats match the search.", "Нет чатов, подходящих под условия."),
    "exportSelected": ("Selected: $1 of $2", "Выбрано: $1 из $2"),
    "exportStart": ("Save selected ($1)", "Сохранить выбранные ($1)"),
    "exportBusy": ("Another export is running.", "Идёт другой экспорт."),
    "jobRunning": ("Saving…", "Сохраняю…"),
    "jobCancelling": ("Stopping after the current chat…", "Останавливаю после текущего чата…"),
    "jobCancelled": ("Export cancelled", "Экспорт отменён"),
    "jobStopped": ("Export stopped", "Экспорт остановлен"),
    "jobFinished": ("Export finished", "Экспорт завершён"),
    "jobCancel": ("Cancel", "Отменить"),
    "jobNew": ("Hide", "Скрыть"),
    "jobCounts": (
        "$1 of $2 · saved $3 · with warnings $4 · errors $5 · skipped $6",
        "$1 из $2 · сохранено $3 · с предупреждениями $4 · ошибок $5 · пропущено $6",
    ),
    "jobCurrent": ("Now: $1", "Сейчас: $1"),
    "jobReport": ("Report:", "Отчёт:"),
    "jobParts": (
        "The archive is saved in $1 parts, about 500 MB each. Unpack them into one folder.",
        "Архив сохранён частями ($1), примерно по 500 МБ. Распакуйте их в одну папку.",
    ),
    "jobFailedList": ("Chats that failed ($1)", "Чаты с ошибками ($1)"),
    "jobStatus_pending": ("Waiting", "Ожидает"),
    "jobStatus_running": ("Saving", "Сохраняется"),
    "jobStatus_done": ("Saved", "Сохранён"),
    "failedFilesMore": ("and $1 more", "и ещё $1"),
    "jobRecovered": (
        "The unsaved part of the archive was lost from memory (the extension restarted or ran out of memory), so its chats are saved again. Times: $1.",
        "Несохранённая часть архива пропала из памяти (расширение перезапустилось или ему не хватило памяти), поэтому её чаты сохраняются заново. Раз: $1.",
    ),
    "jobStatus_warning": ("Saved, some files missing", "Сохранён, не все файлы"),
    "jobStatus_error": ("Failed", "Ошибка"),
    "jobStatus_skipped": ("Skipped: not changed", "Пропущен: не изменился"),
    "jobNotifyDone": (
        "Export finished: $1 chats saved ($2 with warnings), $3 errors, $4 skipped.",
        "Экспорт завершён: сохранено чатов $1 (с предупреждениями $2), ошибок $3, пропущено $4.",
    ),
    "jobNotifyStopped": ("Export stopped: $1", "Экспорт остановлен: $1"),
    # Report
    "reportTitle": ("Export report: $1", "Отчёт об экспорте: $1"),
    "reportStarted": ("Started", "Начало"),
    "reportFinished": ("Finished", "Конец"),
    "reportSummary": (
        "Saved $1 (with warnings $2), errors $3, skipped $4, of $5",
        "Сохранено $1 (с предупреждениями $2), ошибок $3, пропущено $4, всего $5",
    ),
    "reportCancelled": ("The export was cancelled.", "Экспорт отменён."),
    "reportStopped": ("The export stopped: $1", "Экспорт остановлен: $1"),
    "reportErrors": ("Errors", "Ошибки"),
    "reportWarnings": ("Saved with missing files", "Сохранены не со всеми файлами"),
    "reportFailedFiles": ("files not saved: $1", "файлов не сохранено: $1"),
    "reportSkipped": ("Skipped: not changed since the last export", "Пропущены: не изменились с прошлого экспорта"),
    "reportNotReached": ("Not reached", "Не обработаны"),
    "reportSaved": ("Saved", "Сохранены"),
    "popupShortcut": ("Shortcut: $1", "Горячая клавиша: $1"),
    "popupShortcutNotSet": ("Keyboard shortcut is not set.", "Горячая клавиша не назначена."),
    "saveDialogWarning": (
        "Chrome asks where to save each file. Turn off “Ask where to save each file before downloading” in Chrome settings, otherwise every exported file opens a dialog. Or save to a folder you choose (extension settings) or tick “Save as .zip” when saving.",
        "Chrome спрашивает, куда сохранять каждый файл. Отключите «Всегда указывать место для скачивания» в настройках Chrome, иначе каждый файл экспорта откроет диалог. Или выберите сохранение в свою папку (настройки расширения) или отметьте «Сохранить в .zip» при сохранении.",
    ),
    "saveDialogWarningEarlier": (
        "Last time Chrome asked where to save a file, and the export stopped. Turn off “Ask where to save each file before downloading” in Chrome settings, or save to a folder you choose (extension settings) or tick “Save as .zip” below. If the Chrome setting is already off, just save the chat.",
        "В прошлый раз Chrome спросил, куда сохранить файл, и экспорт остановился. Отключите «Всегда указывать место для скачивания» в настройках Chrome или выберите сохранение в свою папку (настройки расширения) или отметьте «Сохранить в .zip» ниже. Если настройка Chrome уже отключена, просто сохраните чат.",
    ),
    "openDownloadSettings": ("Open download settings", "Открыть настройки скачивания"),
    "openSettings": ("Settings", "Настройки"),
    # Notifications
    "notifyDone": ("Saved: $1 messages, $2 files.", "Сохранено: сообщений $1, файлов $2."),
    "notifyPartial": (
        "Saved $1 messages and $2 files; $3 files could not be saved.",
        "Сохранено сообщений $1 и файлов $2; не удалось сохранить файлов: $3.",
    ),
    # Errors (error_<code>, see src/shared/errors.ts)
    "error_unsupported_page": (
        "Open a Claude, Gemini, Grok or ChatGPT chat first.",
        "Сначала откройте чат Claude, Gemini, Grok или ChatGPT.",
    ),
    "error_tab_not_loaded": (
        "The site did not open in a background tab. Open it in a tab, wait until it loads, and try again.",
        "Сайт не открылся в фоновой вкладке. Откройте его во вкладке, дождитесь загрузки и повторите.",
    ),
    "error_rate_limited": (
        "The service limits how often it can be asked and kept refusing for several minutes, so the export stopped. Start it again in 10–15 minutes; with \u201cskip unchanged chats\u201d on, it goes on from where it stopped.",
        "Сервис ограничивает частоту запросов и несколько минут отказывал, поэтому экспорт остановлен. Запустите его снова через 10–15 минут; с включённым \u00abпропускать неизменённые\u00bb он продолжит с места остановки.",
    ),
    "error_chat_not_found": (
        "The chat is not on the service any more: it was deleted.",
        "Этого чата на сервисе больше нет: он удалён.",
    ),
    "error_platform_busy": (
        "The service keeps answering with a server error. Try again later.",
        "Сервис отвечает внутренней ошибкой. Попробуйте позже.",
    ),
    "exportListStop": ("Stop and use these", "Остановить и взять эти"),
    "exportListStopping": ("Stopping after this page…", "Останавливаю после этой страницы…"),
    "exportListStopped": (
        "Loading was stopped at $1 chats: the list shows the newest ones.",
        "Загрузка остановлена на $1 чатах: в списке самые новые.",
    ),
    "exportListLoadAll": ("Load the whole list", "Загрузить весь список"),
    "exportListIncomplete": (
        "$1 returned $2 chats and then stopped answering, so older chats are not listed. Try again later to load the rest.",
        "$1 отдал $2 чатов и перестал отвечать, поэтому более старых чатов в списке нет. Попробуйте позже, чтобы загрузить остальные.",
    ),
    "error_platform_not_ready": (
        "This is not available on this site yet.",
        "На этом сайте это пока недоступно.",
    ),
    "error_not_a_chat": (
        "This page is not a conversation. Open a chat first.",
        "Эта страница не разговор. Сначала откройте чат.",
    ),
    "error_not_signed_in": (
        "Sign in to the chat service and try again.",
        "Войдите в сервис и попробуйте снова.",
    ),
    "error_format_changed": (
        "The service changed its data format. Update the extension.",
        "Сервис изменил формат данных. Обновите расширение.",
    ),
    "error_format_changed_at": (
        "The service changed its data format (field $1). Update the extension, or report the field name.",
        "Сервис изменил формат данных (поле $1). Обновите расширение или сообщите название поля.",
    ),
    "error_busy": ("This chat is already being saved.", "Этот чат уже сохраняется."),
    "error_save_dialog": (
        "Export stopped: Chrome asks where to save each file.",
        "Экспорт остановлен: Chrome спрашивает, куда сохранять каждый файл.",
    ),
    "error_save_cancelled": ("Saving was cancelled.", "Сохранение отменено."),
    "error_archive_lost": (
        "The ZIP archive being built was lost (the extension was reloaded or ran out of memory).",
        "Собираемый ZIP-архив потерян (расширение перезагрузилось или не хватило памяти).",
    ),
    "error_folder_not_chosen": (
        "No folder is chosen. Choose one in the extension settings.",
        "Папка для сохранения не выбрана. Выберите её в настройках расширения.",
    ),
    "error_folder_permission": (
        "No access to the chosen folder. Click “Save chat” in the extension window and allow access.",
        "Нет доступа к выбранной папке. Нажмите «Сохранить чат» в окне расширения и разрешите доступ.",
    ),
    "error_folder_missing": (
        "The chosen folder is not available. It may have been deleted or moved. Choose it again in the extension settings.",
        "Выбранная папка недоступна: возможно, её удалили или переместили. Выберите её заново в настройках расширения.",
    ),
    "error_failed": ("Could not save the chat: $1", "Не удалось сохранить чат: $1"),
    # Markdown
    "mdUser": ("User", "Пользователь"),
    "mdThinking": ("Thinking", "Рассуждения"),
    "mdWebSearch": ("Web search: “$1”", "Веб-поиск: «$1»"),
    "mdWebSearchNoQuery": ("Web search", "Веб-поиск"),
    "mdNoResults": ("No results", "Нет результатов"),
    "mdTools": ("Tools ($1)", "Инструменты ($1)"),
    "mdToolError": ("error", "ошибка"),
    "mdAttachments": ("Attachments", "Вложения"),
    "mdAttachmentFailed": ("could not download: $1", "не удалось скачать: $1"),
    "mdExtractedOnly": ("extracted text only", "только извлечённый текст"),
    "mdExtractedPartial": (
        "only the beginning of the extracted text: the service keeps no more",
        "только начало извлечённого текста: больше сервис не хранит",
    ),
    "mdRebuiltFromChat": ("rebuilt from the chat", "восстановлено по истории чата"),
    "failUnavailable": ("the service does not provide this file", "сервис не отдаёт этот файл"),
    "failForbidden": ("access denied", "доступ запрещён"),
    "failNotFound": ("not found on the server", "не найден на сервере"),
    "failNetwork": ("network or server error", "ошибка сети или сервера"),
    "failFile": ("could not write the file ($1)", "не удалось записать файл ($1)"),
    "failOther": ("$1", "$1"),
    "mdOtherBranches": ("Other branches", "Другие ветки"),
    "mdRecompressed": ("re-encoded by the service, full size", "пережато сервисом, полный размер"),
    "mdUnreadable": (
        "A part of this message could not be read ($1). The rest of the chat is saved.",
        "Часть этого сообщения не удалось прочитать ($1). Остальной чат сохранён.",
    ),
    "mdProjectDescription": ("Description", "Описание"),
    "mdProjectInstructions": ("Project instructions", "Инструкции проекта"),
    "mdProjectKnowledge": ("Knowledge base files", "Файлы базы знаний"),
    "mdProjectChats": ("Chats", "Чаты"),
    "mdProjectNoKnowledge": ("No files.", "Файлов нет."),
    "mdNotebookSources": ("Sources", "Источники"),
    "mdNotebookNoSources": ("No sources.", "Источников нет."),
    "mdNotebookSourcesElsewhere": (
        "The source files stay in NotebookLM: [open the notebook]($1).",
        "Файлы источников остаются в NotebookLM: [открыть блокнот]($1).",
    ),
    "mdFileSkipped": ("not saved: saving files is off", "не сохранён: сохранение файлов выключено"),
    "mdFileNotGiven": (
        "the service keeps this file without a download, so only its name is here",
        "сервис хранит этот файл без возможности скачать, поэтому здесь только его имя",
    ),
    "mdProjectNoChats": ("No chats.", "Чатов нет."),
    "mdProjectChatFailed": ("could not save: $1", "не удалось сохранить: $1"),
    "mdBranchFromStart": ("Branch $1, from the start", "Ветка $1, с начала"),
    "mdBranchAfter": ("Branch $1, after message $2", "Ветка $1, после сообщения $2"),
    "mdBranchAfterIn": ("Branch $1, after message $2 of branch $3", "Ветка $1, после сообщения $2 ветки $3"),
    # Options
    "optionsTitle": ("CodingCat AI Chat Exporter settings", "Настройки CodingCat AI Chat Exporter"),
    "optionsSectionSaving": ("Saving", "Сохранение"),
    "optionsDestination": ("Save to", "Куда сохранять"),
    "optionsDestinationDownloads": ("Chrome's Downloads folder", "Папка «Загрузки» Chrome"),
    "optionsDestinationFolder": ("A folder you choose", "Выбранная вами папка"),
    "optionsDestinationFolderHint": (
        "Files are written straight into the folder, with no Save As dialogs, whatever Chrome's download settings are. An Obsidian vault folder works too.",
        "Файлы записываются прямо в папку, без диалогов «Сохранить как», при любых настройках скачивания Chrome. Подойдёт и папка хранилища Obsidian.",
    ),
    "optionsChooseFolder": ("Choose folder…", "Выбрать папку…"),
    "optionsChangeFolder": ("Choose another folder…", "Выбрать другую папку…"),
    "optionsFolderChosen": ("Folder: $1", "Папка: $1"),
    "optionsFolderNotChosen": ("No folder chosen yet.", "Папка ещё не выбрана."),
    "optionsFolderPickerHint": (
        "Chrome may not let you pick Documents, Downloads or Desktop themselves: create a folder inside them, for example “AI Chats”.",
        "Chrome может не дать выбрать сами «Документы», «Загрузки» или рабочий стол: создайте внутри отдельную папку, например «AI Chats».",
    ),
    "optionsFolderNeedsAccess": (
        "Chrome will ask for permission to write to this folder on the next save. You can allow it now.",
        "Chrome спросит разрешение на запись в эту папку при следующем сохранении. Можно разрешить сейчас.",
    ),
    "optionsFolderDenied": (
        "Access to the folder is blocked. Choose the folder again.",
        "Доступ к папке запрещён. Выберите папку заново.",
    ),
    "optionsGrantAccess": ("Allow access", "Разрешить доступ"),
    "optionsFolderError": ("Could not open the folder: $1", "Не удалось открыть папку: $1"),
    "optionsRootFolder": ("Folder inside Downloads", "Папка внутри Загрузок"),
    "optionsSectionBulk": ("Repeated and bulk exports", "Повторный и массовый экспорт"),
    "optionsFolderExists": ("When a chat was saved before", "Если чат уже сохранялся"),
    "optionsFolderExistsCopy": ("Save a new copy: “Chat (2)”", "Сохранить новую копию: «Чат (2)»"),
    "optionsFolderExistsOverwrite": ("Overwrite the earlier copy", "Перезаписать прежнюю копию"),
    "optionsSkipUnchanged": ("Skip chats that have not changed", "Пропускать неизменённые чаты"),
    "optionsSkipUnchangedHint": (
        "In bulk exports, a chat saved before and not updated since is skipped.",
        "При массовом экспорте чат, который уже сохранялся и с тех пор не менялся, пропускается.",
    ),
    "optionsDelay": ("Pause between chats, ms", "Пауза между чатами, мс"),
    "optionsDelayHint": (
        "Keeps the load on the service low. 800 ms is enough for most accounts.",
        "Снижает нагрузку на сервис. Для большинства аккаунтов достаточно 800 мс.",
    ),
    "optionsReport": ("Export report in _reports/", "Отчёт об экспорте в _reports/"),
    "optionsReportOnErrors": ("Only when something failed", "Только если были ошибки"),
    "optionsReportAlways": ("Always", "Всегда"),
    "optionsReportNever": ("Never", "Никогда"),
    "optionsRegistry": ("Export registry", "Реестр экспортов"),
    "optionsRegistryCount": ("Chats in the export registry: $1", "Чатов в реестре экспортов: $1"),
    "optionsRegistryClear": ("Clear", "Очистить"),
    "optionsRegistryConfirm": (
        "Forget which chats were saved and which folder names were used?",
        "Забыть, какие чаты сохранялись и какие имена папок использовались?",
    ),
    "optionsRegistryHint": (
        "The extension cannot see your Downloads folder, so it remembers what it saved: to name copies and to skip unchanged chats.",
        "Расширение не видит папку «Загрузки», поэтому запоминает, что сохраняло: чтобы называть копии и пропускать неизменённые чаты.",
    ),
    "optionsRootFolderHint": (
        "Leave empty to save straight to Downloads. Use / for nested folders.",
        "Оставьте пустым, чтобы сохранять прямо в Загрузки. Вложенные папки через /.",
    ),
    "optionsIncludePlatform": (
        "Add the platform name to folder names",
        "Добавлять название платформы в имя папки",
    ),
    "optionsIncludePlatformHint": (
        "Example: “Notes - 2026-10-13 (Claude)”.",
        "Пример: «Заметки - 2026-10-13 (Claude)».",
    ),
    "optionsSectionContent": ("Markdown content", "Содержимое Markdown"),
    "optionsArtifactVersions": ("Artifact versions", "Версии артефактов"),
    "optionsArtifactVersionsLatest": ("Latest only", "Только последняя"),
    "optionsArtifactVersionsAll": ("All versions", "Все версии"),
    "optionsSaveThinking": ("Save the model's thinking", "Сохранять рассуждения модели"),
    "optionsSaveToolCalls": (
        "Save web searches and tool calls",
        "Сохранять веб-поиск и вызовы инструментов",
    ),
    "optionsSaveToolCallsHint": (
        "Shown as collapsed blocks in Obsidian.",
        "В Obsidian отображаются свёрнутыми блоками.",
    ),
    "optionsToolCallDetail": ("Tool calls", "Вызовы инструментов"),
    "optionsToolCallDetailCompact": ("One line per call", "Одна строка на вызов"),
    "optionsToolCallDetailFull": ("With input and output", "С входными данными и результатом"),
    "optionsClaudeBranches": ("Branches (Claude, Grok, ChatGPT)", "Ветки (Claude, Grok, ChatGPT)"),
    "optionsClaudeBranchesActive": ("Only the branch you see", "Только видимая ветка"),
    "optionsClaudeBranchesAll": ("All branches", "Все ветки"),
    "optionsSectionShortcut": ("Keyboard shortcut", "Горячая клавиша"),
    "optionsShortcutCurrent": ("Save the current chat: $1", "Сохранить текущий чат: $1"),
    "optionsShortcutChange": ("Change in Chrome settings", "Изменить в настройках Chrome"),
    "optionsShowNotifications": (
        "Show the result of saving with the shortcut (a panel on the chat page)",
        "Показывать результат сохранения по горячей клавише (панель на странице чата)",
    ),
    "optionsSaved": ("Saved", "Сохранено"),
    "optionsMoreLater": (
        "“Save as .zip” is chosen where you save: in the extension window, on the export page, or in the panel after the shortcut.",
        "«Сохранить в .zip» выбирается там, где вы сохраняете: в окне расширения, на странице экспорта или в панели после горячей клавиши.",
    ),
}


def entry(text: str) -> dict:
    numbers = sorted(set(re.findall(r"\$(\d)", text)))
    if not numbers:
        return {"message": text}
    message = re.sub(r"\$(\d)", r"$ARG\1$", text)
    return {
        "message": message,
        "placeholders": {f"arg{n}": {"content": f"${n}"} for n in numbers},
    }


root = Path(__file__).resolve().parent.parent / "public" / "_locales"
for index, locale in enumerate(("en", "ru")):
    data = {key: entry(pair[index]) for key, pair in STRINGS.items()}
    path = root / locale / "messages.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{path.relative_to(root.parent.parent)}: {len(data)} strings")
