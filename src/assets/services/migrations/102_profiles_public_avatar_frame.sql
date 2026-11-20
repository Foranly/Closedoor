-- ==============================================
-- Migration 102: marcos en la vista pública
-- ==============================================
-- El frontend lee los perfiles de `profiles_public` (dbPublic.from('profiles')),
-- no de la tabla. La migración 100/101 añadió `avatar_frame_url` y
-- `avatar_frame_position` solo a `profiles`, así que cualquier SELECT que
-- pidiera esas columnas a la vista fallaba con 400 (column does not exist).
--
-- Aquí se recrea la vista con las columnas nuevas. Se usa CREATE OR REPLACE
-- (no DROP + CREATE) para no perder permisos, `security_invoker` ni las
-- dependencias que otros objetos tengan sobre la vista; por eso las columnas
-- nuevas van AL FINAL, después de la lista original de la migración 051.
--
-- ⚠️ Si en el futuro se añaden columnas a `profiles` que la UI necesite leer,
--    hay que añadirlas también aquí (al final).

-- Por si esta migración se ejecuta antes que 100/101.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_frame_url TEXT;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_frame_position TEXT;

CREATE OR REPLACE VIEW public.profiles_public AS
SELECT
  id,
  username,
  displayname,
  avatar_url,
  banner_url,
  bio,
  pronouns,
  roles,
  created_at,
  is_private,
  stats_private,
  stats_visibility,
  interests,
  social_links,
  song,
  accent_color,
  accent_color_secondary,
  accent_surface_color,
  accent_surface_glass,
  accent_visibility,
  show_accent_profile,
  show_accent_explore,
  banner_position,
  avatar_position,
  profile_background_url,
  profile_background_position,
  profile_background_blur,
  profile_background_dim,
  show_interests,
  show_profile_stats,
  show_trending,
  show_likes,
  show_saves,
  profile_views_count,
  allow_mention,
  allow_encrypted_add,
  show_badges,
  profile_text_color,
  user_status,
  user_status_updated_at,
  -- Marco del avatar (migraciones 100 y 101).
  avatar_frame_url,
  avatar_frame_position
FROM profiles;

-- Mantener SECURITY INVOKER para que RLS se aplique al usuario que consulta.
ALTER VIEW public.profiles_public SET (security_invoker = true);

GRANT SELECT ON public.profiles_public TO anon, authenticated;
