# Благодарности

Идея и часть подхода: **vibe-coding-mentor** Азамата Раймбекова (лицензия MIT): формат ответа «итог, по-человечески, что сделать тебе», принцип «делай сам и объявляй сделанное», формат «просто скилл» с установкой одной командой. Тексты здесь написаны заново под уровень учеников курса «ИИнутый».

В 2.3 по мотивам его правил добавлены (своими словами): правила простого языка («Тебе с ним: …», не больше двух терминов, команда в трёх частях), предсказание и пересказ как проверка понимания, похвала за дело и поправка в три части, проверка установки по диску, вопрос с контекстом, «платное вслух и заранее», памятка к каждому сообщению.

## Сторонние инструменты набора урока 5 (2.4, дополнено в 2.5)

Плагин не содержит их кода: он ставит их у ученика из первоисточников. У каждого своя лицензия и свои условия: find-skills и установщик навыков `skills` (vercel-labs, MIT), impeccable (Paul Bakaus, Apache-2.0), emil-design-eng (Emil Kowalski, MIT), Agent Reach (Panniantong, MIT), superpowers (Jesse Vincent, MIT), humanizer (blader, MIT), `@playwright/mcp` (Microsoft, Apache-2.0), HyperFrames (HeyGen, Apache-2.0, 2.5), навыки Remotion (remotion-dev/skills; у самого Remotion собственная лицензия, условия на remotion.dev/docs/license, 2.5), 21st Magic MCP (21st.dev, ISC; сервис 21st.dev по своим условиям и с личным ключом пользователя). GSAP (навыки greensock/gsap-skills, MIT, 2.6), Node.js и FFmpeg (ставятся системным менеджером пакетов, 2.6). Подробности и проверенные версии: `plugins/ii-ramis/skills/nabor/references/istochniki.md`.

## Монтаж рилсов (2.6)

В плагин вложены шрифты **Onest** (Copyright 2021 The Onest Project Authors), **Oswald** (Copyright 2016 The Oswald Project Authors) и **Cormorant Garamond** (Copyright 2015 The Cormorant Project Authors), все под SIL Open Font License 1.1 (текст в `plugins/ii-ramis/skills/montazh/fonts/OFL.txt`): статические начертания, полученные из переменных шрифтов Google Fonts. Расшифровка речи делается библиотекой **faster-whisper** (MIT, SYSTRAN) и моделями `Systran/faster-whisper-small` и `-base` (MIT), которые скачиваются у ученика один раз, на закреплённой версии; сами они в репозиторий не входят. Субтитры рисует **FFmpeg** (LGPL/GPL, библиотека libass), он ставится у ученика отдельно.
