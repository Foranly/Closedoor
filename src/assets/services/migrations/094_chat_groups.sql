-- ==============================================
-- Migration 094: Chat groups
-- ==============================================
-- Los chats grupales reutilizan `conversations`, `chat_participants` y
-- `messages`: el cifrado por mensaje ya soporta N destinatarios
-- (`messages.encrypted_for`), así que un mensaje de grupo se cifra una vez
-- para cada miembro igual que en un chat directo.
--
-- - conversations.kind: 'direct' (1:1) | 'group'
-- - conversations.title / avatar_url: solo grupos
-- - conversations.created_by: quién creó el grupo (NULL en directos antiguos)
-- - chat_participants.role: 'owner' | 'admin' | 'member'
-- ==============================================

-- ── 1. Columnas nuevas ──
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE chat_participants ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

-- Los chats existentes son todos 1:1 (así están hoy en producción).
UPDATE conversations SET kind = 'direct' WHERE kind IS NULL;

-- ── 2. Restricciones (idempotentes) ──
DO $$
BEGIN
  ALTER TABLE conversations
    ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('direct', 'group'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE conversations
    ADD CONSTRAINT conversations_group_title_check
    CHECK (kind <> 'group' OR char_length(coalesce(title, '')) <= 80);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE chat_participants
    ADD CONSTRAINT chat_participants_role_check CHECK (role IN ('owner', 'admin', 'member'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. Índices ──
CREATE INDEX IF NOT EXISTS idx_conversations_kind ON conversations(kind);
CREATE INDEX IF NOT EXISTS idx_conversations_created_by ON conversations(created_by);

-- ── 4. RLS: salir de un grupo ──
-- Sin política DELETE no había forma de abandonar una conversación: cada uno
-- solo puede borrar su propia fila de participante (el historial queda para el
-- resto de miembros). Los mensajes siguen protegidos por `encrypted_for`.
DROP POLICY IF EXISTS "Leave conversation" ON chat_participants;
CREATE POLICY "Leave conversation"
  ON chat_participants FOR DELETE
  USING (user_id = auth.uid());

-- ── 5. RPC para añadir miembros ──
-- Un miembro no puede añadir participantes a un chat directo por su cuenta:
-- eso convertiría un 1:1 en grupo sin que la otra persona lo sepa. La política
-- INSERT de chat_participants sigue abierta (la necesita la creación de chats
-- directos, donde el creador inserta a las dos partes); esta función de
-- comprobación la usa la RPC de abajo para los grupos.
CREATE OR REPLACE FUNCTION public.add_group_members(conv_id uuid, member_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller uuid := auth.uid();
  conv_kind text;
  added integer := 0;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT kind INTO conv_kind FROM conversations WHERE id = conv_id;
  IF conv_kind IS NULL THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;
  IF conv_kind <> 'group' THEN
    RAISE EXCEPTION 'not_a_group';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chat_participants WHERE conversation_id = conv_id AND user_id = caller
  ) THEN
    RAISE EXCEPTION 'not_a_member';
  END IF;

  INSERT INTO chat_participants (conversation_id, user_id, role)
  SELECT conv_id, u, 'member'
  FROM unnest(member_ids) AS u
  WHERE u IS NOT NULL
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END;
$$;

-- El dueño (o un admin) puede sacar a alguien; cualquiera puede irse por su
-- cuenta con la política DELETE de arriba.
CREATE OR REPLACE FUNCTION public.remove_group_member(conv_id uuid, target uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller uuid := auth.uid();
  caller_role text;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT role INTO caller_role
  FROM chat_participants
  WHERE conversation_id = conv_id AND user_id = caller;

  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  IF target = caller THEN
    RAISE EXCEPTION 'use_leave';
  END IF;

  -- Un admin no puede sacar al dueño.
  IF caller_role = 'admin' AND EXISTS (
    SELECT 1 FROM chat_participants
    WHERE conversation_id = conv_id AND user_id = target AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  DELETE FROM chat_participants WHERE conversation_id = conv_id AND user_id = target;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_group_members(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_group_member(uuid, uuid) TO authenticated;
