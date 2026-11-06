-- ==============================================
-- Migration 085: bloquear en la BD el compartir por chat de posts privados
-- ==============================================
-- La UI deshabilita "Compartir por chat" y chatService.sendMessage valida antes
-- de insertar, pero la política de INSERT de messages solo comprobaba
-- sender_id = auth.uid(): un cliente con la anon key podía insertar un mensaje
-- con shared_post_id apuntando a cualquier post, privado incluido, y dejar el
-- contenido a la vista de gente que no sigue a ese perfil.
--
-- Se reutiliza public.can_repost_post() (SECURITY DEFINER, migración 011) para
-- no duplicar la regla: perfil privado + autor distinto de quien comparte ⇒
-- bloqueado; el dueño sigue pudiendo compartir sus propios posts. Al ser
-- SECURITY DEFINER el chequeo no depende de lo que la RLS de posts/profiles
-- deje ver al que inserta, y no hay recursión de políticas.

DROP POLICY IF EXISTS "Insert own messages" ON public.messages;

CREATE POLICY "Insert own messages"
  ON public.messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    -- Post compartido: solo si puede repostearse, es decir, no viene de un
    -- perfil privado ajeno.
    AND (
      shared_post_id IS NULL
      OR public.can_repost_post(auth.uid(), shared_post_id)
    )
  );

-- Los mensajes ya enviados no se tocan: esto solo impide compartir de ahora en
-- adelante. Si se quisiera limpiar lo existente, habría que filtrar antes por
-- conversación y participantes, no en bloque.
