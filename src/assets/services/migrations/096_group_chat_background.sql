-- ==============================================
-- Migration 096: Fondo compartido en grupos
-- ==============================================
-- En los chats 1:1 el fondo sigue siendo privado de cada usuario
-- (`chat_background_settings`, migración 078). En grupos el fondo pasa a ser
-- de la CONVERSACIÓN: lo ve todo el mundo y cualquiera del grupo puede
-- cambiarlo, como el nombre o la imagen del grupo.
--
-- - conversations.chat_background_url / _by / _updated_at
-- - messages.is_system: aviso dentro del hilo («Ana cambió el fondo del
--   grupo»). El contenido se cifra igual que el resto (encrypted_for), así que
--   no hace falta tocar la política de lectura.
-- ==============================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_background_url TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_background_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_background_updated_at TIMESTAMPTZ;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- El aviso de sistema no debe contar como mensaje normal en los filtros por
-- texto del cliente; el índice que ya existe (conversation_id) sirve para
-- listarlos, no hace falta índice propio.
