-- ==============================================
-- Migration 083: chat_default_style como preferencia de cuenta
-- ==============================================
-- Ajuste "Chat con estilos por defecto": en /chat se ignoran el vidrio, el
-- color de superficie y el color de texto del perfil (el tema claro/oscuro se
-- mantiene). Como el resto de preferencias visuales, vive en profiles para
-- sobrevivir a reloads y cambios de dispositivo (localStorage puede perderse
-- con IndexedDB).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS chat_default_style BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.chat_default_style IS
  'Si true, /chat usa sus estilos originales e ignora vidrio/superficie/color de texto del perfil (mantiene el tema claro/oscuro).';
