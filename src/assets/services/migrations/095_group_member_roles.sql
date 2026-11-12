-- ==============================================
-- Migration 095: Roles dentro de grupos
-- ==============================================
-- `chat_participants.role` ya existe desde la 094 ('owner' | 'admin' |
-- 'member'), pero no había forma de cambiar el rol de nadie después de crear
-- el grupo. Solo el dueño puede hacerlo: un admin puede sacar a miembros, pero
-- no nombrar más admins (evita que dos admins se degraden entre ellos).
-- El dueño no puede cambiarse el rol a sí mismo: para eso está salir del grupo.
-- ==============================================

CREATE OR REPLACE FUNCTION public.set_group_member_role(conv_id uuid, target uuid, new_role text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller uuid := auth.uid();
  caller_role text;
  conv_kind text;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF new_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  SELECT kind INTO conv_kind FROM conversations WHERE id = conv_id;
  IF conv_kind IS NULL THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;
  IF conv_kind <> 'group' THEN
    RAISE EXCEPTION 'not_a_group';
  END IF;

  SELECT role INTO caller_role
  FROM chat_participants
  WHERE conversation_id = conv_id AND user_id = caller;

  IF caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  IF target = caller THEN
    RAISE EXCEPTION 'use_leave';
  END IF;

  UPDATE chat_participants
  SET role = new_role
  WHERE conversation_id = conv_id
    AND user_id = target
    AND role <> 'owner';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  RETURN new_role;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_group_member_role(uuid, uuid, text) TO authenticated;
