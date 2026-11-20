-- ==============================================
-- Migration 106: comment_id de vuelta en las notificaciones de comentario
-- ==============================================
-- La migración 040 añadió comment_id a notify_comment(), pero la 058
-- reescribió la función (para revocar EXECUTE) sin la columna. Resultado: las
-- notificaciones de tipo 'comment' se creaban sin comment_id y el cliente no
-- podía hacer deep-link al comentario (scroll + remarcado) como sí hace con
-- comentarios respondidos, menciones o likes de comentario.
--
-- Esta migración:
--   1. Recrea notify_comment() guardando comment_id.
--   2. Rellena el comment_id de las notificaciones antiguas que apuntan a un
--      post concreto, emparejando actor + post por la fecha del comentario.

-- ── 1. Trigger con comment_id ──
CREATE OR REPLACE FUNCTION public.notify_comment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  post_owner UUID;
BEGIN
  SELECT user_id INTO post_owner FROM posts WHERE id = NEW.post_id;
  IF post_owner IS NOT NULL AND post_owner != NEW.user_id THEN
    INSERT INTO notifications (actor_id, user_id, type, reference_id, comment_id)
    VALUES (NEW.user_id, post_owner, 'comment', NEW.post_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.notify_comment() FROM anon, authenticated;

-- ── 2. Rellenar las notificaciones antiguas ──
-- Para cada notificación 'comment' sin comment_id se toma el comentario del
-- mismo actor en el mismo post más reciente que la propia notificación (el
-- trigger se dispara al insertar el comentario, así que es ese mismo).
UPDATE notifications n
SET comment_id = c.id
FROM comments c
WHERE n.type = 'comment'
  AND n.comment_id IS NULL
  AND n.reference_id IS NOT NULL
  AND c.post_id = n.reference_id
  AND c.user_id = n.actor_id
  AND c.created_at <= n.created_at
  AND c.id = (
    SELECT c2.id
    FROM comments c2
    WHERE c2.post_id = n.reference_id
      AND c2.user_id = n.actor_id
      AND c2.created_at <= n.created_at
    ORDER BY c2.created_at DESC
    LIMIT 1
  );
