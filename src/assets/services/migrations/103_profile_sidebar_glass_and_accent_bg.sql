-- ==============================================
-- Migration 103: sidebar translúcido + quitar acento del fondo
-- ==============================================
-- Dos preferencias nuevas del perfil, editables desde el modal de edición:
--   * sidebar_glass   → el sidebar (Header) usa el vidrio del perfil aunque el
--                       modo translúcido de las cards esté apagado.
--   * hide_accent_bg  → el fondo del perfil no lleva el gradiente de acento
--                       (.profile-page::after), solo la imagen/tema.
--
-- Ambas se leen desde `profiles_public` (dbPublic.from('profiles')), así que la
-- vista se recrea con las columnas nuevas AL FINAL (mismo patrón que 102).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS sidebar_glass BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS hide_accent_bg BOOLEAN NOT NULL DEFAULT false;

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
  avatar_frame_position,
  -- Preferencias visuales nuevas (migración 103).
  sidebar_glass,
  hide_accent_bg
FROM profiles;

ALTER VIEW public.profiles_public SET (security_invoker = true);

GRANT SELECT ON public.profiles_public TO anon, authenticated;
