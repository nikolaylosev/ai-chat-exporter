"""Source of truth for UI strings. Writes public/_locales/{en,ru}/messages.json,
and for the Chrome Web Store listing's other languages only the name and the
summary (LISTING); Chrome shows English for every other string there.

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
        "Save Claude, Gemini, Grok and ChatGPT chats and projects as Markdown with every file. No account, no server, open source.",
        "Сохраняет чаты и проекты Claude, Gemini, Grok и ChatGPT в Markdown со всеми файлами. Без аккаунта и сервера, открытый код.",
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
    "saveWithFiles": ("Save with files", "Сохранять с файлами"),
    "noteFormat": ("Note format", "Формат заметки"),
    "noteFormatMarkdown": ("Markdown (.md)", "Markdown (.md)"),
    "noteFormatHtml": ("HTML page (.html)", "Страница HTML (.html)"),
    "noteFormatJson": ("JSON (.json)", "JSON (.json)"),
    "noteFormatDocx": ("Word document (.docx)", "Документ Word (.docx)"),
    "popupCopyChat": ("Copy", "Копировать"),
    "popupCopyHint": (
        "Copy the chat to the clipboard as Markdown, without its files",
        "Скопировать чат в буфер обмена как Markdown, без файлов",
    ),
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
        "Gemini's list stops at about 1,000 chats. Its search reaches older ones, 20 per query, so this takes a few minutes and may still miss some.",
        "Список Gemini обрывается примерно на 1000 чатах. Его поиск достаёт и более старые, по 20 за запрос: это займёт несколько минут, и часть чатов всё равно может не найтись.",
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
    "exportSources": (
        "In the table: $1 chats from the list, $2 found by search, $3 from Takeout, $4 saved before.",
        "В таблице: из списка $1 чатов, найдено поиском $2, из Takeout $3, сохранено раньше $4.",
    ),
    "exportTakeoutAdd": ("Add chats from Google Takeout…", "Добавить чаты из Google Takeout…"),
    "exportTakeoutHint": (
        "Takeout links to every chat, however old. On takeout.google.com choose My Activity with only Gemini Apps, in JSON, then pick the .zip or MyActivity.json here. The file is read on this computer only.",
        "Takeout ссылается на все чаты, даже самые старые. На takeout.google.com выберите «Мои действия» только с «Приложениями Gemini», в формате JSON, затем укажите здесь .zip или файл с действиями. Файл читается только на этом компьютере.",
    ),
    "exportTakeoutReading": ("Reading the Takeout file…", "Читаю файл Takeout…"),
    "exportTakeoutRunning": (
        "Adding chats from Takeout: $1 of $2.",
        "Добавляю чаты из Takeout: $1 из $2.",
    ),
    "exportTakeoutWaiting": (
        "Gemini is refusing for now: $1 chats will be asked again shortly, more slowly.",
        "Gemini пока отказывает: чаты ($1) будут запрошены ещё раз чуть позже, медленнее.",
    ),
    "exportTakeoutAgain": (
        "Asking Gemini again, more slowly: $1 of $2.",
        "Запрашиваю у Gemini ещё раз, медленнее: $1 из $2.",
    ),
    "exportTakeoutDone": (
        "Takeout: $1 chats added, $2 were already here, $3 no longer on Gemini.",
        "Takeout: добавлено чатов $1, уже были здесь $2, больше нет в Gemini $3.",
    ),
    "exportTakeoutFailed": (
        "$1 could not be read now. Add the file again to try them.",
        "Сейчас не удалось прочитать чатов: $1. Добавьте файл ещё раз, чтобы попробовать снова.",
    ),
    "exportTakeoutNone": (
        "No Gemini chats in this file. Pick the Takeout .zip, or the JSON file from My Activity, Gemini Apps.",
        "В этом файле нет чатов Gemini. Укажите .zip из Takeout или JSON-файл из «Мои действия», «Приложения Gemini».",
    ),
    "exportSearchCoverage": (
        "Search has come across $1% of the chats in the list. If it has found about as large a share of the older chats, there are about $2 of them, perhaps more.",
        "Поиск встретил $1% чатов из списка. Если более старых он нашёл примерно такую же долю, всего их около $2, а может, и больше.",
    ),
    "exportSearchForget": ("Forget the found ones", "Забыть найденные"),
    "exportStatusFilter": ("Saved", "Сохранение"),
    "exportStatusAll": ("All chats", "Все чаты"),
    "exportStatusNew": ("Not saved yet ($1)", "Ещё не сохранены ($1)"),
    "exportStatusChanged": (
        "Changed since saved ($1)",
        "Изменились после сохранения ($1)",
    ),
    "exportStatusSaved": ("Saved, unchanged ($1)", "Сохранены, без изменений ($1)"),
    "exportSourceFilter": ("Source", "Источник"),
    "exportSourceAll": ("All sources", "Все источники"),
    "exportSourceList": ("Gemini's list ($1)", "Список Gemini ($1)"),
    "exportSourceSearch": ("Found by search ($1)", "Найдены поиском ($1)"),
    "exportSourceTakeout": ("Google Takeout ($1)", "Google Takeout ($1)"),
    "exportSourceSaved": ("Only saved before ($1)", "Только сохранённые раньше ($1)"),
    "exportProjectAll": ("All", "Все"),
    "exportProjectNone": ("Without a project ($1)", "Без проекта ($1)"),
    "exportGemNone": ("Without a Gem ($1)", "Без Gem ($1)"),
    "exportFoundBySearch": ("found by search", "найден поиском"),
    "exportFromTakeout": ("from Takeout", "из Takeout"),
    "exportSavedBefore": ("saved before", "сохранён раньше"),
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
    "exportBusy": (
        "An export is in progress; a new one can start when it ends.",
        "Экспорт идёт, новый можно начать после его окончания.",
    ),
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
    "exportListKept": (
        "Only the newest chats were read from $1 ($2 new or changed); the rest are as on your last visit.",
        "Из $1 прочитаны только новые чаты (новых или изменённых: $2), остальные как в прошлый раз.",
    ),
    "exportListReadAll": ("Read the whole list again", "Прочитать весь список заново"),
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
        "Chrome asked where to save a file, so the export stopped: otherwise it would ask about every file.",
        "Chrome спросил, куда сохранить файл, и экспорт остановлен, иначе он спрашивал бы про каждый файл.",
    ),
    "error_save_cancelled": ("Saving was cancelled.", "Сохранение отменено."),
    "error_download_cancelled": ("Saving was cancelled, so the export stopped.", "Сохранение отменено, экспорт остановлен."),
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
    "error_folder_unsupported": (
        "This browser does not let extensions write into a folder you choose (in Brave, turn on brave://flags/#file-system-access-api). Choose Downloads in the extension settings.",
        "Этот браузер не даёт расширениям записывать в выбранную папку (в Brave включите brave://flags/#file-system-access-api). Выберите «Загрузки» в настройках расширения.",
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
    "mdSelection": ("$1 of the chat's $2 messages", "$1 из $2 сообщений чата"),
    # Options
    "optionsTitle": ("CodingCat AI Chat Exporter settings", "Настройки CodingCat AI Chat Exporter"),
    "optionsSectionSaving": ("Saving", "Сохранение"),
    "optionsDestination": ("Save to", "Куда сохранять"),
    "optionsDestinationDownloads": ("Chrome's Downloads folder", "Папка «Загрузки» Chrome"),
    "optionsDestinationFolder": ("A folder you choose", "Выбранная вами папка"),
    "optionsFolderUnsupported": (
        "This browser does not let extensions write into a folder on your disk, so exports go to Downloads.",
        "Этот браузер не даёт расширениям записывать в папку на диске, поэтому всё сохраняется в «Загрузки».",
    ),
    "optionsFolderBrave": (
        "In Brave, turn it on at brave://flags/#file-system-access-api and restart the browser.",
        "В Brave это включается на странице brave://flags/#file-system-access-api, после чего браузер нужно перезапустить.",
    ),
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
    "pageButtonTitle": ("Save or copy this chat (CodingCat AI Chat Exporter)", "Сохранить или скопировать этот чат (CodingCat AI Chat Exporter)"),
    "pageMenuWithFiles": ("Save chat with files", "Сохранить чат с файлами"),
    "pageMenuTextOnly": ("Save text only", "Сохранить только текст"),
    "pageMenuCopy": ("Copy as Markdown", "Копировать как Markdown"),
    "pageMenuChoose": ("Choose messages…", "Выбрать сообщения…"),
    "searchTitle": ("Search the archive", "Поиск по архиву"),
    "searchHint": (
        "Searches every saved chat of every service at once, on this computer: nothing is sent anywhere. Choose the folder that holds your exports; .zip exports inside it are read too.",
        "Ищет сразу по всем сохранённым чатам всех сервисов, на этом компьютере: ничего никуда не отправляется. Выберите папку с вашими экспортами; архивы .zip внутри неё тоже читаются.",
    ),
    "searchNoFolder": ("No folder chosen yet.", "Папка ещё не выбрана."),
    "searchUnsupported": (
        "This browser does not let extensions read a folder on your disk, so the archive cannot be searched here.",
        "Этот браузер не даёт расширениям читать папку на диске, поэтому искать по архиву здесь нельзя.",
    ),
    "searchFolder": ("Folder: “$1”", "Папка: «$1»"),
    "searchAllow": ("Allow reading the folder", "Разрешить чтение папки"),
    "searchUseExportFolder": ("Search “$1” (the export folder)", "Искать в «$1» (папка экспорта)"),
    "searchChoose": ("Choose a folder…", "Выбрать папку…"),
    "searchChooseOther": ("Another folder…", "Другая папка…"),
    "searchZipHint": (
        "Exports saved into Downloads are in Downloads/AI Chats: choose that folder (Chrome does not let you choose Downloads itself).",
        "Экспорты, сохранённые в «Загрузки», лежат в «Загрузки/AI Chats»: выберите эту папку (сами «Загрузки» Chrome выбрать не даёт).",
    ),
    "searchReading": (
        "Reading the archive: $1 of $2 files, $3 chats found…",
        "Читаю архив: $1 из $2 файлов, найдено чатов: $3…",
    ),
    "searchReadError": ("Could not read the folder: $1", "Не удалось прочитать папку: $1"),
    "searchPlaceholder": ("Search $1 chats: words or a \"phrase\"", "Поиск по $1 чатам: слова или \"фраза\""),
    "searchPlatform": ("Service", "Сервис"),
    "searchAllPlatforms": ("All services", "Все сервисы"),
    "searchWho": ("Who wrote it", "Кто написал"),
    "searchEveryone": ("Everyone", "Все"),
    "searchProject": ("Project", "Проект"),
    "searchFrom": ("From", "С"),
    "searchTo": ("To", "По"),
    "searchWithin": ("In chats that also mention…", "В чатах, где есть ещё…"),
    "searchWithinHint": (
        "Words that must also be somewhere in the chat, in any message or file. -word leaves out the chats that have it.",
        "Слова, которые должны быть ещё где-то в чате, в любом сообщении или файле. -слово убирает чаты, где оно есть.",
    ),
    "searchWhere": ("Where", "Где"),
    "searchWhereAll": ("In messages and files", "В сообщениях и файлах"),
    "searchWhereMessages": ("Only in messages", "Только в сообщениях"),
    "searchWhereFiles": ("Only in files", "Только в файлах"),
    "searchSort": ("Order", "Порядок"),
    "searchSortNewest": ("Newest chats first", "Сначала новые чаты"),
    "searchSortOldest": ("Oldest chats first", "Сначала старые чаты"),
    "searchSortMatches": ("Most matches first", "Сначала больше совпадений"),
    "searchFound": ("Found in $1 messages of $2 chats.", "Найдено в $1 сообщениях из $2 чатов."),
    "searchFirst": ("The first $1 are shown.", "Показаны первые $1."),
    "searchNothing": ("Nothing found.", "Ничего не найдено."),
    "searchOpenChat": ("Open the chat on $1", "Открыть чат в $1"),
    "popupSearchArchive": ("Search the archive", "Поиск по архиву"),
    "messagesTitle": ("Choose messages", "Выбор сообщений"),
    "messagesLoading": ("Reading the chat…", "Читаю чат…"),
    "messagesReopen": (
        "Open the chat in its tab and choose “Choose messages…” again.",
        "Откройте чат в его вкладке и снова выберите «Выбрать сообщения…».",
    ),
    "messagesHint": (
        "Tick the messages to keep; Shift-click ticks a range. They are saved in the chat's order, each with its files; other branches are left out.",
        "Отметьте нужные сообщения; Shift+клик отмечает диапазон. Они сохранятся в порядке чата, каждое со своими файлами; другие ветки не попадут.",
    ),
    "messagesAll": ("All", "Все"),
    "messagesNone": ("None", "Ничего"),
    "messagesMine": ("Only mine", "Только мои"),
    "messagesReplies": ("Only AI replies", "Только ответы ИИ"),
    "messagesChoose": ("Message $1", "Сообщение $1"),
    "messagesNoText": ("No text: files or tool calls only", "Без текста: только файлы или вызовы инструментов"),
    "messagesFiles": ("Files: $1", "Файлы: $1"),
    "messagesCount": ("Chosen: $1 of $2", "Выбрано: $1 из $2"),
    "messagesCopy": ("Copy", "Копировать"),
    "messagesSave": ("Save $1", "Сохранить $1"),
    "panelCopied": ("Copied to the clipboard: $1 messages.", "Скопировано в буфер обмена: сообщений $1."),
    "panelCopying": ("Copying…", "Копирую…"),
    "panelFiles": ("Files: $1 of $2", "Файлы: $1 из $2"),
    "optionsShowPageButton": ("Save button on chat pages", "Кнопка сохранения на страницах чатов"),
    "optionsShowPageButtonHint": (
        "A small round button in the bottom right corner of a chat, with a menu: save the chat with its files, save its text only, or copy it as Markdown.",
        "Маленькая круглая кнопка в правом нижнем углу чата с меню: сохранить чат с файлами, только текст или скопировать как Markdown.",
    ),
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


# The store listing's other languages: the summary only (at most 132 characters).
LISTING = {
    "de": "Speichert Chats und Projekte aus Claude, Gemini, Grok und ChatGPT als Markdown mit allen Dateien. Ohne Konto, Open Source.",
    "es": "Guarda chats y proyectos de Claude, Gemini, Grok y ChatGPT en Markdown con todos sus archivos. Sin cuenta ni servidor.",
    "fr": "Enregistre les chats et projets Claude, Gemini, Grok et ChatGPT en Markdown avec tous les fichiers. Sans compte ni serveur.",
    "pt_BR": "Salva chats e projetos do Claude, Gemini, Grok e ChatGPT em Markdown com todos os arquivos. Sem conta nem servidor.",
    "ja": "Claude・Gemini・Grok・ChatGPT のチャットとプロジェクトを、すべてのファイルごと Markdown で保存。アカウント不要、サーバーなし、オープンソース。",
    "zh_CN": "将 Claude、Gemini、Grok 和 ChatGPT 的聊天与项目连同所有文件保存为 Markdown。无需账号，无服务器，开源。",
}


def write(locale: str, data: dict) -> None:
    path = root / locale / "messages.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{path.relative_to(root.parent.parent)}: {len(data)} strings")


root = Path(__file__).resolve().parent.parent / "public" / "_locales"
for index, locale in enumerate(("en", "ru")):
    write(locale, {key: entry(pair[index]) for key, pair in STRINGS.items()})
for locale, summary in LISTING.items():
    assert len(summary) <= 132, (locale, len(summary))
    write(locale, {"extName": entry(STRINGS["extName"][0]), "extDescription": entry(summary)})
assert all(len(pair[0]) <= 132 and len(pair[1]) <= 132 for pair in [STRINGS["extDescription"]])
