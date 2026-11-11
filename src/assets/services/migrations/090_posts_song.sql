-- ==============================================
-- Migration 090: canción adjunta a un post
-- ==============================================
-- 1) Añade `posts.song` (jsonb) para publicar una canción con el post y
--    reproducirla desde la PostCard con el reproductor global.
--
--    Shape (mismo que `profiles.song` y `messages.shared_song`, normalizado en
--    el cliente antes de guardar):
--      { provider, trackId, title, artist, album, artwork, previewUrl,
--        externalUrl, duration }
--
--    `previewUrl` (30 s) es el respaldo del reproductor: en la web YouTube
--    suele negar el stream completo y suena el preview; en la app de escritorio
--    el stream llega entero desde el servidor local de música.
--
-- 2) Recrea `posts_public` con `song`. Los SELECT de solo lectura del cliente
--    van a la VISTA (dbPublic → posts_public), no a la tabla: sin este paso
--    todos los feeds fallan con 42703 "column posts_public.song does not exist".
--    Definición idéntica a la de 073 + song (patrón DROP CASCADE + CREATE +
--    security_invoker + GRANT).
--
-- Sin cambios de RLS: la columna viaja en la fila del post, así que hereda las
-- políticas de la tabla (055 + 089) y la vista las respeta (security_invoker).
-- Sin índice: nunca se filtra por ella.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS song jsonb;

COMMENT ON COLUMN posts.song IS
  'Canción adjunta al post: { provider, trackId, title, artist, album, artwork, previewUrl, externalUrl, duration }';

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
  -- allowed_users — no expuesto (igual que 055/058)
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
