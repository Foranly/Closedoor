-- ==============================================
-- Migration 084: preferencias del sidebar (colores y estilos por defecto)
-- ==============================================
-- Dos ajustes nuevos de Ajustes → Sistema → Apariencia:
--
--   sidebar_default_style  → el sidebar usa su aspecto original: no hereda el
--                            vidrio, el color de superficie ni el color de texto
--                            del perfil. Al activarse, la opción de colores
--                            por defecto del sidebar queda desactivada.
--   sidebar_default_colors → conserva el vidrio del fondo del sidebar pero
--                            ignora el color de superficie/acento del perfil.
--
-- Como el resto de preferencias visuales viven en profiles para sobrevivir a
-- reloads y cambios de dispositivo (localStorage puede perderse con IndexedDB).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS sidebar_default_style BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sidebar_default_colors BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.sidebar_default_style IS
  'Si true, el sidebar usa su estilo original e ignora vidrio/color de superficie/color de texto del perfil.';

COMMENT ON COLUMN public.profiles.sidebar_default_colors IS
  'Si true, el sidebar mantiene el vidrio del fondo pero ignora el color de acento del perfil.';
