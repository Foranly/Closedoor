-- ==============================================
-- Migration 108: cerrar EXECUTE de anon en los helpers de la 107
-- ==============================================
-- En PostgreSQL las funciones nacen con EXECUTE para PUBLIC, así que el
-- `GRANT ... TO authenticated` de la 107 no impedía que anon las llamara (se
-- comprobó con la anon key: devolvían datos). No exponen filas, pero sí sirven
-- de oráculo booleano sobre UUIDs ajenos.
--
-- Las políticas que las usan son `TO authenticated`, y los triggers corren como
-- el dueño de la tabla, así que revocar PUBLIC/anon no rompe nada.

REVOKE ALL ON FUNCTION public.is_group_moderator(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_conversation_creator(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.conversation_is_empty(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_view_comment(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_group_moderator(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_conversation_creator(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_is_empty(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_comment(uuid) TO authenticated;

-- Verificación (con la anon key): las cuatro deben responder 42501
-- "permission denied for function", no un booleano.
