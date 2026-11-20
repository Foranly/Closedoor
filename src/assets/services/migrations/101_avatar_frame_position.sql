-- ==============================================
-- Migration 101: posición/zoom del marco del avatar
-- ==============================================
-- El marco (migración 100) no siempre queda centrado en el borde del avatar:
-- algunos PNG dejan margen transparente alrededor del aro o lo dibujan algo
-- desplazado. Igual que `avatar_position`, se guarda la posición elegida en el
-- editor de arrastre + zoom.
--
-- Formato JSON: {"x":0-100,"y":0-100,"zoom":1-3}. NULL = centrado, zoom 1.
-- No es una URL, así que no pasa por `normalizeProfileUrls`.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_frame_position TEXT;

COMMENT ON COLUMN public.profiles.avatar_frame_position IS
  'Posición/zoom del marco del avatar: JSON {"x":50,"y":50,"zoom":1}. NULL = centrado.';
