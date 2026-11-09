# Благодарности

Идея и часть подхода: **vibe-coding-mentor** Азамата Раймбекова (лицензия MIT): формат ответа «итог, по-человечески, что сделать тебе», принцип «делай сам и объявляй сделанное», формат «просто скилл» с установкой одной командой. Тексты здесь написаны заново под уровень учеников курса «ИИнутый».

В 2.3 по мотивам его правил добавлены (своими словами): правила простого языка («Тебе с ним: …», не больше двух терминов, команда в трёх частях), предсказание и пересказ как проверка понимания, похвала за дело и поправка в три части, проверка установки по диску, вопрос с контекстом, «платное вслух и заранее», памятка к каждому сообщению.

## Сторонние инструменты набора урока 5 (2.4, дополнено в 2.5)

Плагин не содержит их кода: он ставит их у ученика из первоисточников. У каждого своя лицензия и свои условия: find-skills и установщик навыков `skills` (vercel-labs, MIT), impeccable (Paul Bakaus, Apache-2.0), emil-design-eng (Emil Kowalski, MIT), Agent Reach (Panniantong, MIT), superpowers (Jesse Vincent, MIT), humanizer (blader, MIT), `@playwright/mcp` (Microsoft, Apache-2.0), HyperFrames (HeyGen, Apache-2.0, 2.5), навыки Remotion (remotion-dev/skills; у самого Remotion собственная лицензия, условия на remotion.dev/docs/license, 2.5), 21st Magic MCP (21st.dev, ISC; сервис 21st.dev по своим условиям и с личным ключом пользователя). GSAP (навыки greensock/gsap-skills, MIT, 2.6), Node.js и FFmpeg (ставятся системным менеджером пакетов, 2.6). Подробности и проверенные версии: `plugins/ii-ramis/skills/nabor/references/istochniki.md`.

## Монтаж рилсов (2.6)

В плагин вложены шрифты **Onest** (Copyright 2021 The Onest Project Authors), **Oswald** (Copyright 2016 The Oswald Project Authors) и **Cormorant Garamond** (Copyright 2015 The Cormorant Project Authors), все под SIL Open Font License 1.1 (текст в `plugins/ii-ramis/skills/montazh/fonts/OFL.txt`): статические начертания, полученные из переменных шрифтов Google Fonts. Расшифровка речи делается библиотекой **faster-whisper** (MIT, SYSTRAN) и моделями `Systran/faster-whisper-small` и `-base` (MIT), которые скачиваются у ученика один раз, на закреплённой версии; сами они в репозиторий не входят. Субтитры рисует **FFmpeg** (LGPL/GPL, библиотека libass), он ставится у ученика отдельно.

## Набор 2.7

Плагин по-прежнему не содержит чужого кода навыков, а ставит их из первоисточников: **ffmpeg-skill** (kajisho5, MIT), **Teardown** (elvarofficial, MIT; основан на whaleyxbt/claude-motion, MIT), **Anatomy** (Ryan, wheresryan22, MIT), навыки веб-движков из **awesome-gamedev-agent-skills** (gamedev-skills, Apache-2.0; ставятся 7 из 77, файлы не изменяются). Earshot (Leonxlnx, MIT) в набор не входит, описан как установка по желанию. Библиотека референсов `montazh/references/primery/` — собственные тексты (описания приёмов и структуры, без кадров, видео и аудио авторов), ссылки ведут на оригиналы.

**Музыка в `montazh/assets/music/`**: 12 треков Kevin MacLeod (incompetech.com), Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/); обрезаны до 75 секунд с затуханием и перекодированы в MP3. Звуки в `assets/sfx/`: CC0 (Kenney.nl и собственный синтез автора плагина). Подробности и обязательная строка атрибуции для описания ролика: `plugins/ii-ramis/skills/montazh/assets/LICENSES.md`.

## Афиша 2.8

В плагин добавлены шрифты **Fira Sans Extra Condensed** Medium и ExtraBold (Copyright 2012-2015 The Mozilla Foundation and Telefonica S.A.) и **Bad Script** (Copyright 2011 The Bad Script Project Authors), оба под SIL Open Font License 1.1 (тексты: `plugins/ii-ramis/skills/montazh/fonts/OFL-FiraSansExtraCondensed.txt`, `OFL-BadScript.txt`). Платные шрифты стиля Афиша (Druk Cyr, Benzin, Denistina) в плагин и в этот репозиторий НЕ входят: ученик ставит их сам из архива, который выдаёт Рамис в закрытой группе курса (скрипт проверяет SHA256 архива, ссылка в репозитории не хранится).

Маска человека для Афиши: **Robust Video Matting** (PeterL1n/RobustVideoMatting, лицензия GPL-3.0, код и веса авторов). Ни код, ни модель в плагин и репозиторий не входят и плагином не раздаются: по «да» ученика скрипт `install_rvm.py` скачивает файл `rvm_mobilenetv3_fp32.onnx` с официального GitHub-релиза авторов (v1.0.0, проверка SHA256) в `~/.ii-ramis/mask/models`, а считает его **onnxruntime** (Microsoft, MIT) у ученика на компьютере. Код плагина сам RVM не содержит, только обращается к модели через публичный интерфейс ONNX. Тем не менее GPL-3.0 на веса модели юридически не проверена на практике (вопрос открытый): если автор плагина решит иначе, `segment.py` уже умеет считать маску MediaPipe (Apache-2.0).

Остаточный риск (честно): Афиша рисуется командой `npx --yes hyperframes@0.9.19`; версия пакета закреплена, но его собственные зависимости и скрипты установки npm берёт сам (хешей нет). Скрипт GSAP (3.14.2) грузится с jsdelivr с проверкой SRI. Хеши пакетов onnxruntime и других для маски не закреплены (только версии, `--no-deps`, `--only-binary`).



## Урок 7 (2.9): харнесы и безопасность

Плагин не содержит кода этих проектов: он ставит их у ученика из первоисточников по фразе ученика (кроме Strix, он только описан). У каждого своя лицензия, авторские права сохраняются у авторов:
- **ECC** (github.com/affaan-m/ECC, Copyright (c) 2026 Affaan Mustafa, MIT; npm `ecc-universal@2.2.3`, плагин `ecc@ecc`);
- **Superpowers** (github.com/obra/superpowers, Copyright (c) 2025 Jesse Vincent, MIT; из маркетплейса `claude-plugins-official`);
- **security-audit** (github.com/cloudflare/security-audit-skill, Copyright (c) 2025-2026 Cloudflare, Inc., MIT; коммит c1c8a8c). Копия в репозиторий плагина **не вложена**: навык скачивается из репозитория Cloudflare на закреплённом коммите и ставится ученику целиком, как есть, без правок. Условие лицензии MIT (сохранить текст лицензии и уведомление об авторских правах при распространении копий) выполняется тем, что плагин сам копий не распространяет, а текст лицензии лежит в репозитории-источнике (`LICENSE`); здесь указан автор и ссылка;
- **Strix** (github.com/usestrix/strix, Apache-2.0): плагин его не содержит и не ставит сам; в `skills/bezopasnost/references/strix.md` лишь описано, что это, что нужно (Docker, ключ модели) и что запускать можно только на своём сайте или с письменного разрешения владельца. Ставит Claude по фразе ученика после явного «да».

Честно про ECC: в режиме хуков Standard (так решено для курса) установщик ECC сам сообщает, что автоматика может менять файлы проекта, управлять процессами, **отправлять текст из разговора во внешнюю модель**, проверять MCP и вести записи о сессии. Это включается только по просьбе ученика, «выключи ECC» отключает.

## Безопасность запуска HyperFrames (2.9)

`afisha_hf.py` запускает `npx --yes hyperframes@0.9.19` теперь из пустой временной папки (а не из папки проекта ученика), с абсолютными путями слоя и кадров и окружением: `NPM_CONFIG_REGISTRY=https://registry.npmjs.org/`, пользовательский и системный конфиг npm заменены пустым файлом, любые чужие `NPM_CONFIG_*` убраны, `HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`. Так чужие настройки npm и `package.json` в папке проекта не подменят реестр и не исполнят код. Остаточный риск прежний: зависимости самого пакета hyperframes выполняются по установке npm при первом запуске (версия пакета закреплена; скрипты зависимостей не отключены, потому что HyperFrames ставит браузер при первом запуске).
