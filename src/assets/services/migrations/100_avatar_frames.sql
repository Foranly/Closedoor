-- ==============================================
-- Migration 100: marco del avatar
-- ==============================================
-- Cada usuario puede subir un marco (PNG 1:1 con transparencia, 1000×1000
-- recomendado) que se pinta encima de su avatar. La imagen se sube al CDN como
-- el resto de imágenes del perfil y aquí se guarda solo la URL.
--
-- Se guarda en la propia fila del perfil para que llegue a todas las vistas que
-- ya reciben el avatar (posts, chat, explorar, hover card) con el mismo SELECT.
-- `NULL` = sin marco. La política de escritura de profiles ya limita el UPDATE
-- al dueño de la fila (auth.uid() = id), así que no hace falta nada más.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_frame_url TEXT;

COMMENT ON COLUMN public.profiles.avatar_frame_url IS
  'URL del CDN del marco PNG 1:1 que se dibuja sobre el avatar. NULL = sin marco.';
