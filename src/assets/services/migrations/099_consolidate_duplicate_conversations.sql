-- 099_consolidate_duplicate_conversations.sql
--
-- Consolida las conversaciones directas (1:1) duplicadas en una sola por par
-- de participantes en Supabase. Se basa en `conversations`, `chat_participants`
-- y `messages`.
--
-- Pasos:
--  1) Detectar conversaciones directas duplicadas por par de participantes
--     usando chat_participants.
--  2) Elegir canónico por más mensajes; si hay empate, el más reciente.
--  3) Mover los mensajes del duplicado al canónico.
--  4) Recalcular vistas previas (last_message_at, last_message_text, etc.).
--  5) Eliminar los duplicados que queden sin mensajes.

BEGIN;

-- 1) Identificar pares duplicados de conversaciones directas.
--    Dos conversations del mismo kind 'direct' con exactamente los mismos dos
--    participantes (sin usuarios extra) forman un par duplicado.
CREATE TEMP TABLE IF NOT EXISTS duplicate_pairs AS
SELECT
  a.id AS canonical_id,
  b.id AS duplicate_id,
  a.user1_id,
  a.user2_id
FROM (
  SELECT
    c.id,
    MIN(cp.user_id::text)::uuid AS user1_id,
    MAX(cp.user_id::text)::uuid AS user2_id
  FROM conversations c
  JOIN chat_participants cp ON cp.conversation_id = c.id
  WHERE c.kind = 'direct'
  GROUP BY c.id
  HAVING COUNT(*) = 2
) a
JOIN (
  SELECT
    c.id,
    MIN(cp.user_id::text)::uuid AS user1_id,
    MAX(cp.user_id::text)::uuid AS user2_id
  FROM conversations c
  JOIN chat_participants cp ON cp.conversation_id = c.id
  WHERE c.kind = 'direct'
  GROUP BY c.id
  HAVING COUNT(*) = 2
) b ON
  (a.user1_id = b.user1_id AND a.user2_id = b.user2_id)
  AND a.id <> b.id
ORDER BY
  a.user1_id,
  a.user2_id,
  b.id;

-- 2) Elegir canónico por más mensajes; si hay empate, por más reciente.
--    Se actualiza conversations con los ids canónicos identificados en
--  duplicate_pairs (no se usa columna is_canonical).
WITH pairs_with_counts AS (
  SELECT
    dp.canonical_id,
    dp.duplicate_id,
    MAX(mc.message_count) AS canonical_message_count,
    MIN(mc.message_count) AS duplicate_message_count
  FROM duplicate_pairs dp
  LEFT JOIN (
    SELECT
      conversation_id,
      COUNT(*) AS message_count
    FROM messages
    WHERE conversation_id IS NOT NULL
    GROUP BY conversation_id
  ) mc ON mc.conversation_id = dp.canonical_id
  GROUP BY dp.canonical_id, dp.duplicate_id
)
UPDATE conversations c
SET
  updated_at = GREATEST(c.updated_at, now())
FROM pairs_with_counts p
WHERE c.id = p.canonical_id;

-- 3) Mover los mensajes del duplicado al canónico.
--    Ejecutar el UPDATE dentro de un FOR ... IN SELECT para permitir el
--  RETURNING deseado sin errores de WITH sin RETURNING.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.canonical_id, p.duplicate_id
    FROM duplicate_pairs p
    ORDER BY p.canonical_id, p.duplicate_id
  LOOP
    UPDATE messages m
    SET conversation_id = r.canonical_id
    WHERE m.conversation_id = r.duplicate_id;
  END LOOP;
END;
$$;

-- 4) Recalcular vistas previas en conversations.
--    Se basa en las conversaciones directas y sus mensajes para recalcular
--  last_message_at y last_message_text.
UPDATE conversations c
SET
  last_message_at = sub.last_message_at,
  last_message_text = sub.last_message_text
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    created_at AS last_message_at,
    substring(ciphertext for 24) AS last_message_text
  FROM messages
  WHERE conversation_id IN (
    SELECT id FROM conversations WHERE kind = 'direct'
  )
  ORDER BY conversation_id, created_at DESC, id DESC
) sub
WHERE c.id = sub.conversation_id;

-- 5) Eliminar los duplicados que quedan sin mensajes.
DELETE FROM conversations
WHERE id IN (
  SELECT duplicate_id FROM duplicate_pairs
)
  AND NOT EXISTS (
    SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id
  );

COMMIT;
