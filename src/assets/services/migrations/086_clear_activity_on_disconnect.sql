-- ==============================================
-- Migration 086: limpiar la actividad del perfil al quedar desconectado
-- ==============================================
-- `profiles.activity` la escribe la app de escritorio mientras hay sesión
-- (ActivitySync → services/activityService.js). Cuando el usuario se va, el
-- cliente marca `user_status = 'disconnected'` (beforeunload/pagehide en
-- useUserStatus, con fetch keepalive). Hasta ahora esa fila se quedaba con la
-- última canción/juego y el perfil seguía mostrando "Escuchando…" con el
-- usuario ya desconectado, hasta que caducaba por antigüedad
-- (ACTIVITY_TTL_MS = 15 min).
--
-- Este trigger limpia la actividad en la MISMA escritura que reporta la
-- desconexión, sin depender de que el cliente haga un PATCH extra (el keepalive
-- de la pestaña al cerrarse no admite dos peticiones fiables).
--
-- Detalles:
--   - BEFORE INSERT OR UPDATE (BEFORE para poder modificar NEW).
--   - Se aplica a toda escritura con `user_status = 'disconnected'`, no solo a
--     la transición: un cliente que reescriba actividad después de reportarse
--     desconectado tampoco debe dejarla publicada.
--   - NULL en `user_status` no entra (la comparación da NULL, no TRUE).
--   - No toca `program_activity`: es una elección manual del usuario (081), no
--     actividad detectada, y sigue vigente al reconectar.
--   - `activity_updated_at` se limpia también para no dejar una marca que haga
--     parecer fresco un registro vacío.

CREATE OR REPLACE FUNCTION public.clear_activity_on_disconnect()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_status = 'disconnected' THEN
    NEW.activity := NULL;
    NEW.activity_updated_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.clear_activity_on_disconnect() IS
  'Borra activity/activity_updated_at cuando el perfil pasa a user_status = disconnected.';

DROP TRIGGER IF EXISTS profiles_clear_activity_on_disconnect ON public.profiles;
CREATE TRIGGER profiles_clear_activity_on_disconnect
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_activity_on_disconnect();

-- Las funciones de trigger no deben ser ejecutables por los roles de la API
-- (mismo criterio que la 059 con el resto de notify_*/increment_*).
REVOKE EXECUTE ON FUNCTION public.clear_activity_on_disconnect() FROM anon, authenticated;

-- ── Limpieza única de las filas que quedaron sucias antes de este arreglo ──
-- El cliente no borraba la actividad al desconectarse, así que hay perfiles con
-- una canción/juego viejo y sin heartbeat reciente. Se usa el mismo umbral que
-- la app (3 min = STALE_STATUS_MS); a partir de ahí esa cuenta está fuera y su
-- actividad ya no es cierto que esté pasando.
UPDATE public.profiles
SET activity = NULL,
    activity_updated_at = NULL
WHERE activity IS NOT NULL
  AND (
    user_status = 'disconnected'
    OR user_status_updated_at IS NULL
    OR user_status_updated_at < NOW() - INTERVAL '3 minutes'
  );
