-- ==============================================
-- Migration 110: historial de avatares, banners y marcos
-- ==============================================
-- El modal de edición del perfil guarda cada avatar/banner/marco que el dueño
-- aplica, para poder volver a uno anterior desde los diálogos de avatar/banner.
--
-- Privacidad: SOLO el dueño. RLS por `auth.uid() = user_id` en SELECT/INSERT/
-- UPDATE/DELETE, igual que las colecciones de guardados (migración 104).
--
-- El par (user_id, kind, url) es único: reutilizar una imagen ya usada solo
-- actualiza `created_at` (la sube al principio del historial) en vez de
-- duplicarla. El frontend recorta a las 12 más recientes por tipo.
--
-- ⚠️ Opcional para el frontend: si la tabla no existe, el historial funciona
--    en modo local (caché cifrada del navegador) sin romper la app.

CREATE TABLE IF NOT EXISTS public.profile_media_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT profile_media_history_kind_check
    CHECK (kind IN ('avatar', 'banner', 'frame')),
  CONSTRAINT profile_media_history_url_len
    CHECK (char_length(url) BETWEEN 1 AND 2048)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_media_history_unique
  ON public.profile_media_history (user_id, kind, url);

CREATE INDEX IF NOT EXISTS idx_profile_media_history_user_kind
  ON public.profile_media_history (user_id, kind, created_at DESC);

ALTER TABLE public.profile_media_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profile_media_history'
      AND policyname = 'Users can view their own media history'
  ) THEN
    CREATE POLICY "Users can view their own media history"
      ON public.profile_media_history FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profile_media_history'
      AND policyname = 'Users can insert their own media history'
  ) THEN
    CREATE POLICY "Users can insert their own media history"
      ON public.profile_media_history FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profile_media_history'
      AND policyname = 'Users can update their own media history'
  ) THEN
    CREATE POLICY "Users can update their own media history"
      ON public.profile_media_history FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profile_media_history'
      AND policyname = 'Users can delete their own media history'
  ) THEN
    CREATE POLICY "Users can delete their own media history"
      ON public.profile_media_history FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

REVOKE ALL ON public.profile_media_history FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_media_history TO authenticated;

COMMENT ON TABLE public.profile_media_history IS
  'Historial de avatares, banners y marcos aplicados por el dueño del perfil';

-- Verificación:
--   select kind, count(*) from profile_media_history group by 1;
--   select url from profile_media_history where user_id = auth.uid() order by created_at desc limit 5;
