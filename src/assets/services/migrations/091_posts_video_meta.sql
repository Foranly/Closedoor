-- ==============================================
-- Migration 091: dimensiones del video del post
-- ==============================================
-- 1) Añade `posts.video_meta` (jsonb) con el tamaño real del video adjunto:
--      { width, height }
--
--    Se lee en el cliente al publicar (metadata del <video>) y permite que el
--    feed reserve el hueco exacto antes de que cargue el archivo, sin salto de
--    altura. Los posts antiguos quedan en NULL: su reproductor mide el video al
--    cargar los metadatos, como antes.
--
-- 2) Recrea `posts_public` con `video_meta`. Los SELECT de solo lectura del
--    cliente van a la VISTA (dbPublic → posts_public), no a la tabla: sin este
--    paso los feeds fallan con 42703 "column posts_public.video_meta does not
--    exist". Definición idéntica a la de 090 + video_meta (patrón DROP CASCADE
--    + CREATE + security_invoker + GRANT).
--
-- Sin cambios de RLS: la columna viaja en la fila del post y la vista la
-- respeta (security_invoker). Sin índice: nunca se filtra por ella.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS video_meta jsonb;

COMMENT ON COLUMN posts.video_meta IS
  'Dimensiones del video adjunto: { width, height } (para reservar el hueco en el feed)';

-- ── Vista pública ──

DROP VIEW IF EXISTS public.posts_public CASCADE;

CREATE OR REPLACE VIEW public.posts_public AS
SELECT
  id,
  user_id,
  content,
  image_url,
  image_urls,
  image_meta,
  video_url,
  video_meta,
  mentions,
  is_pinned,
  pinned_at,
  likes_count,
  dislikes_count,
  comments_count,
  reposts_count,
  views_count,
  comments_allowed,
  is_encrypted,
  -- allowed_users — no expuesto (igual que 055/058/090)
  obfuscated_display,
  poll_data,
  song,
  scheduled_at,
  is_sensitive,
  community_id,
  created_at,
  updated_at
FROM posts;

ALTER VIEW public.posts_public SET (security_invoker = true);

GRANT SELECT ON public.posts_public TO anon, authenticated;
