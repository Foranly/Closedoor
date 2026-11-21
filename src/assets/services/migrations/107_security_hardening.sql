-- ==============================================
-- Migration 107: endurecimiento de RLS (auditoría de seguridad)
-- ==============================================
-- Cierra los vectores que quedaban abiertos para usuarios autenticados (y algún
-- residuo anónimo). La auditoría solo cubría peticiones anónimas, por eso estos
-- huecos pasaron desapercibidos:
--
--   1. follows: cualquiera podía insertarse status='accepted' contra un perfil
--      privado y leer todo su contenido (can_view_profile_content de 089).
--   2. chat_participants: INSERT WITH CHECK (true) → cualquiera se añadía a
--      cualquier conversación y leía el historial; messages INSERT no exigía
--      ser participante y UPDATE dejaba reescribir ciphertext/iv ajenos.
--   3. community_members: INSERT solo comprobaba user_id → auto-ascenso a
--      owner/admin (contenido privado, moderación completa).
--   4. profiles: UPDATE a nivel de tabla sin proteger `roles` → autoconcederse
--      admin/verified y saltarse can_create_community.
--   5. likes/dislikes/reposts/comment_likes/comment_dislikes/poll_votes
--      SELECT USING (true) → reconstruir interacciones de posts privados.
--   6. post_hashtags INSERT libre → inflar el trending.
--   7. notifications INSERT libre → avisos falsos a cualquier usuario.
--   8. RPCs SECURITY DEFINER ejecutables por anon como oráculos.
--
-- Aplicar a mano en el editor SQL de Supabase, como el resto.
-- Requiere el cambio de cliente de esta misma tanda:
--   · chatService.getOrCreateConversation inserta conversations.created_by.
--   · followService.acceptFollowRequest actualiza status en vez de delete+insert.

-- ════════════════════════════════════════════════
-- 1. FOLLOWS: no auto-aceptarse contra un perfil privado
-- ════════════════════════════════════════════════
-- Regla: el INSERT solo crea la fila del que sigue. Si el destino es privado y
-- quien inserta es el follower, la fila debe nacer 'pending'. La aceptación es
-- un UPDATE del dueño del perfil (política nueva), nunca un INSERT.

CREATE OR REPLACE FUNCTION public.follows_guard_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_is_private boolean;
BEGIN
  IF NEW.follower_id = NEW.following_id THEN
    RAISE EXCEPTION 'self_follow_not_allowed';
  END IF;

  IF NEW.status NOT IN ('pending', 'accepted') THEN
    RAISE EXCEPTION 'invalid_follow_status';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'accepted' AND v_uid = NEW.follower_id THEN
      SELECT COALESCE(is_private, false) INTO v_is_private
      FROM public.profiles WHERE id = NEW.following_id;

      IF COALESCE(v_is_private, false) THEN
        RAISE EXCEPTION 'follow_request_required';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: los extremos son inmutables y solo el dueño del perfil puede
  -- aceptar una solicitud (pending → accepted). El resto lo hacen las RPCs
  -- SECURITY DEFINER o el dashboard (auth.uid() IS NULL).
  IF NEW.follower_id <> OLD.follower_id OR NEW.following_id <> OLD.following_id THEN
    RAISE EXCEPTION 'follow_endpoints_immutable';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND v_uid IS NOT NULL
     AND v_uid <> NEW.following_id THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS follows_guard_status ON public.follows;
CREATE TRIGGER follows_guard_status
  BEFORE INSERT OR UPDATE ON public.follows
  FOR EACH ROW EXECUTE FUNCTION public.follows_guard_status();

DROP POLICY IF EXISTS "Users can follow others" ON public.follows;
CREATE POLICY "Users can follow others"
  ON public.follows FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = follower_id);

DROP POLICY IF EXISTS "Users can accept follow requests" ON public.follows;
CREATE POLICY "Users can accept follow requests"
  ON public.follows FOR UPDATE
  TO authenticated
  USING (auth.uid() = following_id)
  WITH CHECK (auth.uid() = following_id);

-- Quitar seguidores (y rechazar solicitudes) sin poder borrar follows ajenos.
DROP POLICY IF EXISTS "Users can remove their followers" ON public.follows;
CREATE POLICY "Users can remove their followers"
  ON public.follows FOR DELETE
  TO authenticated
  USING (auth.uid() = following_id);

-- ════════════════════════════════════════════════
-- 2. CHAT: participants, messages
-- ════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_group_moderator(conv_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM chat_participants p
    JOIN conversations c ON c.id = p.conversation_id
    WHERE p.conversation_id = conv_id
      AND p.user_id = auth.uid()
      AND c.kind = 'group'
      AND p.role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_conversation_creator(conv_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversations
    WHERE id = conv_id AND created_by = auth.uid()
  );
$$;

-- Conversación recién creada por un cliente antiguo (sin created_by): vacía de
-- participantes y de mensajes. Es la única concesión que se mantiene para no
-- romper la creación de chats 1:1 ya desplegada.
CREATE OR REPLACE FUNCTION public.conversation_is_empty(conv_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM chat_participants WHERE conversation_id = conv_id)
     AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = conv_id);
$$;

GRANT EXECUTE ON FUNCTION public.is_group_moderator(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_conversation_creator(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_is_empty(uuid) TO authenticated;

-- INSERT de participantes: solo el creador del hilo, un moderador del grupo o
-- el arranque de una conversación vacía. Ya no vale "cualquiera con el UUID".
DROP POLICY IF EXISTS "Insert participants" ON public.chat_participants;
CREATE POLICY "Insert participants"
  ON public.chat_participants FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_conversation_creator(conversation_id)
    OR public.is_group_moderator(conversation_id)
    OR public.conversation_is_empty(conversation_id)
  );

-- Crear conversaciones solo con sesión (antes también anon).
DROP POLICY IF EXISTS "Insert conversations" ON public.conversations;
DROP POLICY IF EXISTS "Create conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can create conversations" ON public.conversations;
CREATE POLICY "Users can create conversations"
  ON public.conversations FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Escribir mensajes exige ser participante del hilo.
DROP POLICY IF EXISTS "Insert own messages" ON public.messages;
CREATE POLICY "Insert own messages"
  ON public.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND public.is_conversation_participant(conversation_id)
    AND (
      shared_post_id IS NULL
      OR public.can_repost_post(auth.uid(), shared_post_id)
    )
  );

-- UPDATE de mensajes: cualquier participante puede seguir reaccionando,
-- fijando o ocultando para sí, pero solo el emisor (o owner/admin del grupo)
-- puede tocar contenido, cifrado, metadatos o el estado de borrado global.
CREATE OR REPLACE FUNCTION public.messages_guard_updates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR auth.uid() = OLD.sender_id
     OR public.is_group_moderator(OLD.conversation_id) THEN
    RETURN NEW;
  END IF;

  IF NEW.ciphertext          IS DISTINCT FROM OLD.ciphertext
     OR NEW.iv                IS DISTINCT FROM OLD.iv
     OR NEW.encrypted_for     IS DISTINCT FROM OLD.encrypted_for
     OR NEW.sender_id         IS DISTINCT FROM OLD.sender_id
     OR NEW.conversation_id   IS DISTINCT FROM OLD.conversation_id
     OR NEW.reply_to          IS DISTINCT FROM OLD.reply_to
     OR NEW.created_at        IS DISTINCT FROM OLD.created_at
     OR NEW.edited_at         IS DISTINCT FROM OLD.edited_at
     OR NEW.shared_post_id    IS DISTINCT FROM OLD.shared_post_id
     OR NEW.shared_community_id IS DISTINCT FROM OLD.shared_community_id
     OR NEW.shared_invite_token IS DISTINCT FROM OLD.shared_invite_token
     OR NEW.shared_song       IS DISTINCT FROM OLD.shared_song
     OR NEW.enc_v             IS DISTINCT FROM OLD.enc_v
     OR NEW.key_epoch         IS DISTINCT FROM OLD.key_epoch
     OR NEW.sender_device_id  IS DISTINCT FROM OLD.sender_device_id
     OR NEW.is_system         IS DISTINCT FROM OLD.is_system
     OR NEW.removed_by        IS DISTINCT FROM OLD.removed_by
     OR NEW.removed_at        IS DISTINCT FROM OLD.removed_at
  THEN
    RAISE EXCEPTION 'message_content_immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_guard_updates ON public.messages;
CREATE TRIGGER messages_guard_updates
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_guard_updates();

-- ════════════════════════════════════════════════
-- 3. COMMUNITY_MEMBERS: no auto-ascenso
-- ════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.community_members_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_owner   uuid;
  v_private boolean;
  -- Las RPCs de confianza (canje de invitación) marcan la escritura para
  -- poder crear la membresía ya activa sin abrir la puerta al cliente directo.
  v_trusted boolean := COALESCE(current_setting('closedoor.trusted_write', true), '') = 'on';
BEGIN
  SELECT owner_id, COALESCE(is_private, false)
    INTO v_owner, v_private
  FROM public.communities
  WHERE id = NEW.community_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'community_not_found';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_uid = NEW.user_id THEN
      IF v_uid = v_owner THEN
        -- Fila del dueño al crear la comunidad.
        NEW.role := 'owner';
        NEW.status := 'active';
      ELSIF NOT v_trusted THEN
        -- Alta normal: nunca owner/admin a dedo; privadas entran como pendientes.
        NEW.role := 'member';
        NEW.status := CASE WHEN v_private THEN 'pending' ELSE 'active' END;
      END IF;
    ELSIF v_uid IS NOT NULL AND NOT public.is_community_moderator(NEW.community_id, 'manage_members') THEN
      RAISE EXCEPTION 'not_allowed';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.community_id <> OLD.community_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'membership_keys_immutable';
  END IF;

  IF OLD.role = 'owner' AND NEW.role <> 'owner' THEN
    RAISE EXCEPTION 'cannot_demote_owner';
  END IF;

  IF NEW.role NOT IN ('owner', 'admin', 'moderator', 'member')
     AND NOT EXISTS (
       SELECT 1 FROM public.community_roles r
       WHERE r.community_id = NEW.community_id AND r.name = NEW.role
     ) THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  -- Un miembro no puede cambiar su propio rol ni su estado (solo irse).
  IF v_uid IS NOT NULL
     AND v_uid = OLD.user_id
     AND NOT public.is_community_moderator(OLD.community_id, 'manage_members') THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_members_guard ON public.community_members;
CREATE TRIGGER community_members_guard
  BEFORE INSERT OR UPDATE ON public.community_members
  FOR EACH ROW EXECUTE FUNCTION public.community_members_guard();

-- El dueño no puede ser expulsado por nadie más (ni por un moderador).
CREATE OR REPLACE FUNCTION public.community_members_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF OLD.role = 'owner' AND v_uid IS NOT NULL AND v_uid <> OLD.user_id THEN
    RAISE EXCEPTION 'cannot_remove_owner';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS community_members_guard_delete ON public.community_members;
CREATE TRIGGER community_members_guard_delete
  BEFORE DELETE ON public.community_members
  FOR EACH ROW EXECUTE FUNCTION public.community_members_guard_delete();

-- Canje de invitación en una sola transacción: valida token/expiración/usos y
-- da de alta la membresía activa. Antes lo hacía el cliente en tres pasos y el
-- trigger de arriba lo degradaría a 'pending' en comunidades privadas.
CREATE OR REPLACE FUNCTION public.redeem_community_invite(p_token text)
RETURNS TABLE (community_id uuid, role text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_invite public.community_invites;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT * INTO v_invite FROM public.community_invites WHERE token = p_token;
  IF v_invite.id IS NULL THEN
    RAISE EXCEPTION 'invite_invalid';
  END IF;
  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < now() THEN
    RAISE EXCEPTION 'invite_expired';
  END IF;
  IF v_invite.max_uses IS NOT NULL AND v_invite.uses >= v_invite.max_uses THEN
    RAISE EXCEPTION 'invite_used';
  END IF;

  PERFORM set_config('closedoor.trusted_write', 'on', true);

  DELETE FROM public.community_members
  WHERE community_id = v_invite.community_id AND user_id = v_uid;

  INSERT INTO public.community_members (community_id, user_id, role, status, joined_at)
  VALUES (v_invite.community_id, v_uid, 'member', 'active', now());

  UPDATE public.community_invites SET uses = uses + 1 WHERE id = v_invite.id;

  RETURN QUERY SELECT v_invite.community_id, 'member'::text, 'active'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_community_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_community_invite(text) TO authenticated;

-- ════════════════════════════════════════════════
-- 4. PROFILES: roles no se auto-asignan
-- ════════════════════════════════════════════════
-- `roles` incluye 'admin', 'verified', 'dev' y alimenta insignias y
-- can_create_community(). Solo el dashboard / service_role (auth.uid() NULL)
-- puede cambiarlo.

CREATE OR REPLACE FUNCTION public.profiles_guard_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.roles IS DISTINCT FROM OLD.roles AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'roles_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_roles ON public.profiles;
CREATE TRIGGER profiles_guard_roles
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_roles();

-- ════════════════════════════════════════════════
-- 5. Interacciones: solo sobre contenido visible
-- ════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.can_view_comment(p_comment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.comments c WHERE c.id = p_comment_id);
$$;

COMMENT ON FUNCTION public.can_view_comment(uuid) IS
  'true si el comentario pertenece a un post visible para el visitante (RLS de comments)';

GRANT EXECUTE ON FUNCTION public.can_view_comment(uuid) TO authenticated;

DROP POLICY IF EXISTS "Authenticated users can view likes" ON public.likes;
CREATE POLICY "Authenticated users can view likes"
  ON public.likes FOR SELECT
  TO authenticated
  USING (public.can_view_post(post_id));

DROP POLICY IF EXISTS "Authenticated users can view dislikes" ON public.dislikes;
CREATE POLICY "Authenticated users can view dislikes"
  ON public.dislikes FOR SELECT
  TO authenticated
  USING (public.can_view_post(post_id));

DROP POLICY IF EXISTS "Authenticated users can view reposts" ON public.reposts;
DROP POLICY IF EXISTS "Users can view own reposts" ON public.reposts;
CREATE POLICY "Authenticated users can view reposts"
  ON public.reposts FOR SELECT
  TO authenticated
  USING (public.can_view_post(post_id));

DROP POLICY IF EXISTS "Authenticated users can view comment likes" ON public.comment_likes;
CREATE POLICY "Authenticated users can view comment likes"
  ON public.comment_likes FOR SELECT
  TO authenticated
  USING (public.can_view_comment(comment_id));

DROP POLICY IF EXISTS "Authenticated users can view comment dislikes" ON public.comment_dislikes;
CREATE POLICY "Authenticated users can view comment dislikes"
  ON public.comment_dislikes FOR SELECT
  TO authenticated
  USING (public.can_view_comment(comment_id));

DROP POLICY IF EXISTS poll_votes_select ON public.poll_votes;
CREATE POLICY poll_votes_select
  ON public.poll_votes FOR SELECT
  TO authenticated
  USING (public.can_view_post(post_id));

-- ════════════════════════════════════════════════
-- 6. HASHTAGS: solo en posts propios
-- ════════════════════════════════════════════════

DROP POLICY IF EXISTS "Authenticated users can insert post_hashtags" ON public.post_hashtags;
CREATE POLICY "Users can tag their own posts"
  ON public.post_hashtags FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = post_id AND p.user_id = auth.uid()
    )
  );

-- ════════════════════════════════════════════════
-- 7. NOTIFICATIONS: sin avisos fabricados
-- ════════════════════════════════════════════════
-- Los tipos con `reference_id` deben apuntar a contenido del destinatario
-- (post suyo o comentario suyo). Los de mención solo se permiten si el
-- destinatario no desactivó allow_mention. Los de seguimiento exigen la fila
-- en follows (o vienen de un trigger de confianza con auth.uid() NULL).

CREATE OR REPLACE FUNCTION public.notifications_guard_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.actor_id IS NULL OR NEW.user_id = NEW.actor_id OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.type IN ('follow', 'follow_request') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.follows f
      WHERE f.follower_id = NEW.actor_id AND f.following_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'notification_without_follow';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.type IN ('mention', 'comment_mention') THEN
    IF EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = NEW.user_id AND p.allow_mention = false
    ) THEN
      RAISE EXCEPTION 'mentions_disabled';
    END IF;
    RETURN NEW;
  END IF;

  -- Tipos en los que el destinatario es el dueño del post o del comentario.
  IF NEW.type IN ('comment', 'comment_like', 'poll_vote', 'like', 'dislike', 'repost') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = NEW.reference_id AND p.user_id = NEW.user_id
    ) AND NOT EXISTS (
      SELECT 1 FROM public.comments c
      WHERE c.id = NEW.comment_id AND c.user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'notification_without_reference';
    END IF;
    RETURN NEW;
  END IF;

  -- "Te añadieron a un post": solo el autor del post puede etiquetar.
  IF NEW.type = 'encrypted_add' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.posts p
      WHERE p.id = NEW.reference_id AND p.user_id = NEW.actor_id
    ) THEN
      RAISE EXCEPTION 'notification_without_reference';
    END IF;
    RETURN NEW;
  END IF;

  -- Respuesta: el actor debe ser el autor de la respuesta referenciada.
  IF NEW.type = 'comment_reply' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.comments c
      WHERE c.id = NEW.comment_id AND c.user_id = NEW.actor_id
    ) THEN
      RAISE EXCEPTION 'notification_without_reference';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notifications_guard_insert ON public.notifications;
CREATE TRIGGER notifications_guard_insert
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_guard_insert();

-- ════════════════════════════════════════════════
-- 8. RPCs SECURITY DEFINER: fuera del alcance de anon
-- ════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_conversation_user') THEN
    REVOKE EXECUTE ON FUNCTION public.is_conversation_user(uuid, uuid) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_active_e2e_device') THEN
    REVOKE EXECUTE ON FUNCTION public.is_active_e2e_device(uuid, uuid) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'add_group_members') THEN
    REVOKE EXECUTE ON FUNCTION public.add_group_members(uuid, uuid[]) FROM anon, PUBLIC;
    GRANT EXECUTE ON FUNCTION public.add_group_members(uuid, uuid[]) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'remove_group_member') THEN
    REVOKE EXECUTE ON FUNCTION public.remove_group_member(uuid, uuid) FROM anon, PUBLIC;
    GRANT EXECUTE ON FUNCTION public.remove_group_member(uuid, uuid) TO authenticated;
  END IF;
END $$;

-- ==============================================
-- Verificación rápida tras aplicar
-- ==============================================
--   -- 1. accepted a un perfil privado ajeno debe fallar:
--   insert into follows (follower_id, following_id, status)
--   values ('<yo>', '<privado>', 'accepted');            -- ERROR
--
--   -- 2. añadirse a una conversación ajena debe fallar:
--   insert into chat_participants (conversation_id, user_id)
--   values ('<conv_ajena>', '<yo>');                     -- ERROR
--
--   -- 3. auto-owner de una comunidad debe quedar como member:
--   insert into community_members (community_id, user_id, role, status)
--   values ('<comunidad>', '<yo>', 'owner', 'active');
--   select role, status from community_members where ...; -- member / pending|active
--
--   -- 4. roles propios no se pueden tocar:
--   update profiles set roles = array['admin'] where id = auth.uid();  -- ERROR
