-- ==============================================
-- Migration 082: Chat E2E — dispositivos y claves de conversación
-- ==============================================
-- Diseño completo en docs/security/E2E_CHAT.md. Resumen:
--
--   · e2e_devices        → una clave pública ECDH P-256 por DISPOSITIVO
--                          (navegador o instalación de Electron). La privada
--                          nunca sale del cliente (IndexedDB, no exportable).
--   · conversation_keys  → la clave AES-256-GCM de cada conversación, envuelta
--                          (ECIES) para cada dispositivo destinatario y por epoch.
--   · messages           → enc_v / key_epoch / sender_device_id para distinguir
--                          los mensajes v1 (esquema viejo) de los v2 (E2E).
--
-- El servidor solo ve claves PÚBLICAS y blobs envueltos: con un dump no se
-- puede descifrar nada. Por eso no hay ninguna columna con la clave en claro.
--
-- ⚠️ Aplicar ANTES de desplegar el cliente v2. El cliente está preparado para
--    detectar que estas tablas no existen (42P01 / PGRST205) y seguir en v1.
--
-- Idempotente: se puede re-ejecutar sin efectos secundarios.

-- ── Helper: ¿este usuario participa en la conversación? ──
-- SECURITY DEFINER para consultar chat_participants sin disparar su RLS desde
-- las políticas de conversation_keys (mismo patrón que is_conversation_participant
-- de la migración 032).
CREATE OR REPLACE FUNCTION public.is_conversation_user(conv_id uuid, usr_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM chat_participants
    WHERE conversation_id = conv_id AND user_id = usr_id
  );
$$;

-- ════════════════════════════════════════════
-- 1. Dispositivos
-- ════════════════════════════════════════════
-- `id` lo genera el cliente (crypto.randomUUID) y se guarda también en su
-- IndexedDB: es la identidad del dispositivo, no del usuario. Un usuario puede
-- tener varios (móvil, portátil, app de escritorio) y cada uno recibe su propia
-- copia envuelta de la clave.
CREATE TABLE IF NOT EXISTS public.e2e_devices (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pub_jwk      jsonb NOT NULL,        -- JWK público ECDH P-256 (kty, crv, x, y)
  label        text,                  -- "Chrome · Linux", "Closedoor Desktop"…
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at timestamptz NOT NULL DEFAULT NOW(),
  revoked_at   timestamptz            -- NULL = activo
);

CREATE INDEX IF NOT EXISTS idx_e2e_devices_user
  ON public.e2e_devices(user_id);

-- ── Helper: ¿el dispositivo existe, es de ese usuario y está activo? ──
-- Va DESPUÉS del CREATE TABLE a propósito: una función LANGUAGE sql valida su
-- cuerpo al crearse (check_function_bodies), así que la tabla debe existir ya.
-- Evita que un cliente (viejo o manipulado) siga envolviendo la clave para un
-- dispositivo revocado: la revocación tiene que cortar la entrega en el
-- servidor, no depender de que todos los clientes se hayan actualizado.
CREATE OR REPLACE FUNCTION public.is_active_e2e_device(dev_id uuid, usr_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM e2e_devices
    WHERE id = dev_id AND user_id = usr_id AND revoked_at IS NULL
  );
$$;

-- Solo se aceptan claves EC P-256 con coordenadas con pinta de base64url.
-- Evita basura que rompería el importKey de todos los clientes.
ALTER TABLE public.e2e_devices DROP CONSTRAINT IF EXISTS e2e_devices_pub_jwk_shape;
ALTER TABLE public.e2e_devices ADD CONSTRAINT e2e_devices_pub_jwk_shape CHECK (
  jsonb_typeof(pub_jwk) = 'object'
  AND pub_jwk->>'kty' = 'EC'
  AND pub_jwk->>'crv' = 'P-256'
  AND length(COALESCE(pub_jwk->>'x', '')) BETWEEN 40 AND 100
  AND length(COALESCE(pub_jwk->>'y', '')) BETWEEN 40 AND 100
);

ALTER TABLE public.e2e_devices ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier usuario autenticado necesita ver las públicas para poder
-- envolver la clave de una conversación (también el primer día, antes de tener
-- relación previa). Un dispositivo revocado solo lo ve su dueño.
DROP POLICY IF EXISTS "Read e2e devices" ON public.e2e_devices;
CREATE POLICY "Read e2e devices"
  ON public.e2e_devices FOR SELECT
  USING (auth.uid() IS NOT NULL AND (revoked_at IS NULL OR user_id = auth.uid()));

DROP POLICY IF EXISTS "Register own e2e device" ON public.e2e_devices;
CREATE POLICY "Register own e2e device"
  ON public.e2e_devices FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Update own e2e device" ON public.e2e_devices;
CREATE POLICY "Update own e2e device"
  ON public.e2e_devices FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Delete own e2e device" ON public.e2e_devices;
CREATE POLICY "Delete own e2e device"
  ON public.e2e_devices FOR DELETE
  USING (user_id = auth.uid());

-- Blindaje: la clave pública y el dueño son inmutables y un dispositivo
-- revocado no revive. Sin esto, alguien con la sesión abierta podría sustituir
-- su pública por otra (los contactos que ya la fijaron dejarían de coincidir,
-- pero mejor impedirlo en origen) o "des-revocar" un dispositivo robado.
CREATE OR REPLACE FUNCTION public.e2e_devices_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'e2e_devices: id y user_id son inmutables';
  END IF;
  IF NEW.pub_jwk IS DISTINCT FROM OLD.pub_jwk THEN
    RAISE EXCEPTION 'e2e_devices: la clave publica es inmutable (revoca el dispositivo y crea otro)';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'e2e_devices: un dispositivo revocado no se puede reactivar';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_e2e_devices_guard ON public.e2e_devices;
CREATE TRIGGER trg_e2e_devices_guard
  BEFORE UPDATE ON public.e2e_devices
  FOR EACH ROW
  EXECUTE FUNCTION public.e2e_devices_guard();

-- ════════════════════════════════════════════
-- 2. Claves de conversación envueltas
-- ════════════════════════════════════════════
-- Una fila por (conversación, epoch, dispositivo destinatario). El cliente
-- genera una clave AES-256-GCM aleatoria por epoch, la envuelve una vez por
-- dispositivo con ECDH efímero + HKDF + AES-GCM y publica solo el resultado.
-- La PK evita duplicados y hace que el rewrap sea un simple upsert lógico:
-- si ya existe la fila para ese dispositivo, no se vuelve a envolver.
CREATE TABLE IF NOT EXISTS public.conversation_keys (
  conversation_id     uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  epoch               integer NOT NULL,
  recipient_user_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_device_id uuid NOT NULL REFERENCES public.e2e_devices(id) ON DELETE CASCADE,
  ephemeral_pub       jsonb NOT NULL,   -- JWK público de la clave efímera del emisor
  iv                  text NOT NULL,    -- base64 del IV de la envoltura
  wrapped_key         text NOT NULL,    -- base64 de la clave de conversación envuelta
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, epoch, recipient_device_id)
);

-- El rewrap busca "qué dispositivos activos no tienen fila todavía" por
-- dispositivo; este índice evita escanear la tabla.
CREATE INDEX IF NOT EXISTS idx_conversation_keys_recipient_device
  ON public.conversation_keys(recipient_device_id);

ALTER TABLE public.conversation_keys DROP CONSTRAINT IF EXISTS conversation_keys_valid_epoch;
ALTER TABLE public.conversation_keys ADD CONSTRAINT conversation_keys_valid_epoch
  CHECK (epoch >= 1);

ALTER TABLE public.conversation_keys DROP CONSTRAINT IF EXISTS conversation_keys_blob_shape;
ALTER TABLE public.conversation_keys ADD CONSTRAINT conversation_keys_blob_shape CHECK (
  length(iv) BETWEEN 12 AND 64
  AND length(wrapped_key) BETWEEN 40 AND 512
  AND jsonb_typeof(ephemeral_pub) = 'object'
  AND ephemeral_pub->>'kty' = 'EC'
  AND ephemeral_pub->>'crv' = 'P-256'
);

ALTER TABLE public.conversation_keys ENABLE ROW LEVEL SECURITY;

-- Lectura: participantes de la conversación. Los blobs son inútiles sin la
-- privada del dispositivo, y así cada cliente detecta qué wraps faltan.
DROP POLICY IF EXISTS "Read conversation keys" ON public.conversation_keys;
CREATE POLICY "Read conversation keys"
  ON public.conversation_keys FOR SELECT
  USING (public.is_conversation_participant(conversation_id));

-- Escritura: cualquier participante puede envolver para otro participante
-- (incluido él mismo). No hace falta ser el creador: eso es lo que permite
-- rellenar huecos cuando un dispositivo nuevo se aprueba.
DROP POLICY IF EXISTS "Wrap conversation keys" ON public.conversation_keys;
CREATE POLICY "Wrap conversation keys"
  ON public.conversation_keys FOR INSERT
  WITH CHECK (
    public.is_conversation_participant(conversation_id)
    AND public.is_conversation_user(conversation_id, recipient_user_id)
    AND public.is_active_e2e_device(recipient_device_id, recipient_user_id)
  );

-- Sin política de UPDATE/DELETE a propósito: una clave envuelta no se modifica
-- ni se borra a mano; las filas desaparecen con el cascade de la conversación
-- o del dispositivo. Rotar = insertar un epoch nuevo.

-- ════════════════════════════════════════════
-- 3. Mensajes v2
-- ════════════════════════════════════════════
-- enc_v = 1 → esquema viejo (clave derivada de UUID, descifrable por el server).
-- enc_v = 2 → clave de conversation_keys para `key_epoch`; el AAD incluye
--             conversation_id, sender_id, id del mensaje y epoch.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS enc_v smallint NOT NULL DEFAULT 1;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS key_epoch integer;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS sender_device_id uuid
  REFERENCES public.e2e_devices(id) ON DELETE SET NULL;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_enc_v_known;
ALTER TABLE public.messages ADD CONSTRAINT messages_enc_v_known
  CHECK (enc_v IN (1, 2));

-- Un mensaje v2 sin epoch ni dispositivo emisor no se podría descifrar ni
-- auditar; mejor rechazarlo en el INSERT que dejar un mensaje huérfano.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_e2e_state;
ALTER TABLE public.messages ADD CONSTRAINT messages_e2e_state CHECK (
  enc_v = 1
  OR (key_epoch IS NOT NULL AND key_epoch >= 1 AND sender_device_id IS NOT NULL)
);

-- ════════════════════════════════════════════
-- 4. Permisos
-- ════════════════════════════════════════════
-- La RLS ya limita las filas; los GRANT son la primera barrera y evitan que
-- `anon` (sin sesión) pueda siquiera tocar las tablas.
REVOKE ALL ON public.e2e_devices      FROM anon;
REVOKE ALL ON public.conversation_keys FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.e2e_devices      TO authenticated;
GRANT SELECT, INSERT                 ON public.conversation_keys TO authenticated;
-- Las claves envueltas no se actualizan ni se borran desde el cliente: rotar
-- es insertar un epoch nuevo y el cascade se encarga del resto.
REVOKE UPDATE, DELETE ON public.conversation_keys FROM authenticated;

-- ════════════════════════════════════════════
-- 5. Documentación en el catálogo
-- ════════════════════════════════════════════
COMMENT ON TABLE public.e2e_devices IS
  'Clave pública ECDH P-256 por dispositivo. La privada vive solo en el cliente (IndexedDB, no exportable).';

COMMENT ON COLUMN public.e2e_devices.pub_jwk IS
  'JWK público {kty:"EC", crv:"P-256", x, y}. Inmutable: para rotar, revocar y crear otro dispositivo.';

COMMENT ON TABLE public.conversation_keys IS
  'Clave AES-256-GCM de cada conversación envuelta (ECIES) para un dispositivo concreto y un epoch.';

COMMENT ON COLUMN public.conversation_keys.epoch IS
  'Versión de la clave. Sube al revocar un dispositivo o al rotar a mano; los mensajes viejos conservan su epoch.';

COMMENT ON COLUMN public.messages.enc_v IS
  '1 = cifrado derivado (legacy, descifrable por el servidor). 2 = E2E con conversation_keys.';

COMMENT ON COLUMN public.messages.key_epoch IS
  'Epoch de la clave usada en mensajes enc_v = 2.';
