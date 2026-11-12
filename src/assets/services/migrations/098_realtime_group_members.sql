-- ==============================================
-- Migration 098: Realtime para el panel de miembros del grupo
-- ==============================================
-- El rail derecho de /chat (UsersRail) se suscribe a:
--   · chat_participants → altas, bajas y cambios de rol del grupo.
--   · profiles         → ediciones de nick, @usuario, avatar… de los miembros.
-- Sin esas tablas en la publicación de Realtime, los cambios no llegan y el
-- panel se queda con datos viejos hasta recargar.

DO $$
BEGIN
  -- chat_participants
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_participants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_participants;
  END IF;

  -- profiles
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE profiles;
  END IF;
END $$;

-- Los UPDATE de perfiles traen la fila completa en `new`, pero con REPLICA
-- IDENTITY FULL el filtro `id=in.(…)` también funciona en DELETE y los payloads
-- incluyen todas las columnas. Es barato para una tabla de perfiles.
ALTER TABLE profiles REPLICA IDENTITY FULL;
