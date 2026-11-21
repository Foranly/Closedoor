-- ==============================================
-- Migration 109: preferencia de GIF por usuario (sincroniza entre dispositivos)
-- ==============================================
-- Ajustes → Sistema → Rendimiento deja de ser solo local: el valor se guarda en
-- `profiles` y se hidrata al cargar el perfil, igual que `theme` o
-- `time_format_24h`.
--
--   always → los GIF se animan siempre (por defecto)
--   hover  → primer fotograma hasta que pasas el cursor
--   never  → nunca se animan
--
-- La columna NO se añade a `profiles_public`: solo la necesita el dueño de la
-- cuenta, y el frontend la lee de `profiles` (PROFILE_PUBLIC_COLUMNS).
--
-- ⚠️ Aplicar ANTES de desplegar el código: el SELECT del perfil incluye
--    `gif_behavior`, así que sin la columna las lecturas de perfil fallan.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS gif_behavior TEXT NOT NULL DEFAULT 'always';

DO $$
BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_gif_behavior_check
    CHECK (gif_behavior IN ('always', 'hover', 'never'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.profiles.gif_behavior IS
  'Comportamiento de los GIF para este usuario: always | hover | never';

-- Verificación:
--   select gif_behavior, count(*) from profiles group by 1;
--   update profiles set gif_behavior = 'hover' where id = auth.uid();
