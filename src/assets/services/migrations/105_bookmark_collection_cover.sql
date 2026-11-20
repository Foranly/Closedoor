-- ==============================================
-- Migration 105: portada y descripción de bookmarks
-- ==============================================
-- Las colecciones se muestran como cards 1:1 en el perfil, así que aceptan una
-- portada (imagen subida al CDN o URL) con su ajuste de arrastre/zoom, igual
-- que el avatar (`cover_position` guarda el mismo JSON {x,y,zoom}).
--
-- `description` es una línea corta (30 caracteres en la UI).

ALTER TABLE public.bookmark_collections
  ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE public.bookmark_collections
  ADD COLUMN IF NOT EXISTS cover_url TEXT;

ALTER TABLE public.bookmark_collections
  ADD COLUMN IF NOT EXISTS cover_position TEXT;

ALTER TABLE public.bookmark_collections
  DROP CONSTRAINT IF EXISTS bookmark_collections_description_len;

ALTER TABLE public.bookmark_collections
  ADD CONSTRAINT bookmark_collections_description_len
  CHECK (description IS NULL OR char_length(description) <= 60);
