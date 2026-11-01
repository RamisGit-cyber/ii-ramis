-- v1.0.3: короткий пересказ сессии (2-3 предложения), который ИИ Рамис пишет по согласию ученика.
-- НЕ применять автоматически. Перед применением: бэкап (Supabase -> Database -> Backups).
-- Колонка называется recap, а не summary: summary в public.sessions уже занята (jsonb со счётчиками).
-- Применяется до или после выкладки v1.0.3: клиент v1.0.3 при ответе 400 повторяет отправку без recap.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS recap text;

ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_recap_length;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_recap_length CHECK (recap IS NULL OR char_length(recap) <= 400);

-- Если у роли anon права на INSERT выданы по колонкам (column-level GRANT), добавь новую колонку:
-- GRANT INSERT (recap) ON public.sessions TO anon;
-- Если вставка разрешена политикой RLS "WITH CHECK" и общим GRANT INSERT, отдельных действий не нужно.
-- Проверка после применения:
--   SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'recap';
