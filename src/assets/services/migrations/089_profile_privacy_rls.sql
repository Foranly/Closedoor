-- ==============================================
-- Migration 089: privacidad de perfiles aplicada en la base
-- ==============================================
-- Hasta ahora is_private solo se aplicaba en el cliente: las políticas de
-- posts y comments no lo miraban, así que con la anon key (o con la sesión de
-- cualquier usuario) se podían leer los posts y los comentarios de una cuenta
-- privada, incluidos los embeds de likes, guardados, reposts y respuestas.
--
-- Esta migración mueve la regla a RLS:
--
--   · Perfil privado → su contenido lo ven el dueño y las cuentas que ella
--                      sigue (follows.status = 'accepted').
--   · Perfil público → sin cambios.
--
-- Todo lo que cuelga de un post hereda la regla porque el filtro vive en la
-- tabla posts: posts_public (security_invoker), las relaciones embebidas de
-- likes/saved_posts/reposts y los comentarios. Los embeds de un post no
-- visible llegan como null, y el cliente ya los descarta.
--
-- Aplicar a mano en el editor SQL de Supabase, como el resto.

-- ════════════════════════════════════════════════
-- 1. Helper: ¿el visitante puede ver el contenido de este perfil?
-- ════════════════════════════════════════════════
-- SECURITY INVOKER (por defecto): no eleva privilegios, así que profiles y
-- follows siguen bajo su propio RLS. En follows el visitante siempre es el
-- follower de la fila que consulta, así que la EXISTS funciona sin bypass.
-- PL/pgSQL (no SQL) a propósito: anon no tiene SELECT en follows (056) y la
-- función debe devolver false para él, no lanzar "permission denied". Con
-- PL/pgSQL las sentencias se planifican al ejecutarse y el RETURN temprano
-- evita la consulta prohibida.

CREATE OR REPLACE FUNCTION public.can_view_profile_content(p_owner uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_private boolean;
BEGIN
  IF p_owner IS NULL OR v_uid = p_owner THEN
    RETURN true;
  END IF;

  SELECT COALESCE(p.is_private, false) INTO v_private
  FROM public.profiles p
  WHERE p.id = p_owner;

  IF NOT COALESCE(v_private, false) THEN
    RETURN true;
  END IF;

  -- Sin sesión no hay follows que consultar (ni permiso para leerlos).
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.follows f
    WHERE f.follower_id = v_uid
      AND f.following_id = p_owner
      AND f.status = 'accepted'
  );
END;
$$;

COMMENT ON FUNCTION public.can_view_profile_content(uuid) IS
  'true si el visitante actual puede ver el contenido del perfil: propio, publico o seguido con status accepted';

GRANT EXECUTE ON FUNCTION public.can_view_profile_content(uuid) TO anon, authenticated;

-- ════════════════════════════════════════════════
-- 2. Helper: ¿puede el visitante ver este post?
-- ════════════════════════════════════════════════
-- No repite reglas: pregunta por la fila y el RLS de posts (cifrado, comunidad
-- y privacidad de perfil) decide. Se usa en comments para no devolver
-- comentarios de posts que el visitante no puede abrir.

CREATE OR REPLACE FUNCTION public.can_view_post(p_post_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.posts p WHERE p.id = p_post_id
  );
$$;

COMMENT ON FUNCTION public.can_view_post(uuid) IS
  'true si el post es visible para el visitante segun el RLS de posts';

GRANT EXECUTE ON FUNCTION public.can_view_post(uuid) TO anon, authenticated;

-- ════════════════════════════════════════════════
-- 3. posts: la visibilidad del perfil entra en las políticas SELECT
-- ════════════════════════════════════════════════
-- Se recrean las dos políticas existentes en lugar de añadir una tercera: las
-- políticas RLS se combinan con OR, así que una política extra ampliaría el
-- acceso en vez de restringirlo. Se conservan las reglas de cifrado y de
-- comunidad de la migración 058.

DROP POLICY IF EXISTS "Anyone can view non-encrypted posts" ON public.posts;
CREATE POLICY "Anyone can view non-encrypted posts"
  ON public.posts FOR SELECT
  USING (
    is_encrypted IS DISTINCT FROM true
    AND (community_id IS NULL OR public.can_view_community(community_id))
    AND public.can_view_profile_content(user_id)
  );

-- Posts cifrados: el autor elige allowed_users explícitamente, así que esa
-- concesión manda sobre la privacidad del perfil; el resto de reglas se
-- mantienen (cifrado + comunidad).
DROP POLICY IF EXISTS "Authors and allowed users can view encrypted posts" ON public.posts;
CREATE POLICY "Authors and allowed users can view encrypted posts"
  ON public.posts FOR SELECT
  USING (
    is_encrypted = true
    AND (
      auth.uid() = user_id
      OR auth.uid() = ANY (COALESCE(allowed_users, '{}'))
    )
    AND (community_id IS NULL OR public.can_view_community(community_id))
  );

-- ════════════════════════════════════════════════
-- 4. comments: solo los comentarios de posts visibles
-- ════════════════════════════════════════════════
-- Antes: USING (true). Un comentario no puede ser más público que su post.

DROP POLICY IF EXISTS "Comments are viewable by everyone" ON public.comments;
DROP POLICY IF EXISTS "Comments are viewable by the post audience" ON public.comments;
CREATE POLICY "Comments are viewable by the post audience"
  ON public.comments FOR SELECT
  USING (public.can_view_post(post_id));

-- Y tampoco se puede comentar un post que no se puede abrir (antes bastaba
-- con conocer el post_id para escribir en un hilo privado).
DROP POLICY IF EXISTS "Users can create comments" ON public.comments;
CREATE POLICY "Users can create comments"
  ON public.comments FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND public.can_view_post(post_id)
  );

-- ════════════════════════════════════════════════
-- 5. Índices para las comprobaciones nuevas
-- ════════════════════════════════════════════════
-- La política de comments resuelve el post por id (PK de posts) y las
-- consultas de comentarios filtran por post_id, que no tenía índice.
-- follows(follower_id, status) ya existe desde 040 para la EXISTS.

CREATE INDEX IF NOT EXISTS idx_comments_post_id
  ON public.comments (post_id);

-- ════════════════════════════════════════════════
-- Verificación manual (sustituir los UUID)
-- ════════════════════════════════════════════════
-- Con la sesión de un usuario que NO sigue a una cuenta privada:
--   select count(*) from public.posts    where user_id = '<uuid_privado>'; -- 0
--   select count(*) from public.posts_public where user_id = '<uuid_privado>'; -- 0
--   select count(*) from public.comments where post_id = '<post_privado>'; -- 0
-- (La fila de likes sí se devuelve, pero su embed del post llega null y el
--  cliente la descarta; lo que no se puede leer es el contenido del post.)
-- Y con la cuenta del dueño o de un seguidor aceptado: los mismos counts > 0.
