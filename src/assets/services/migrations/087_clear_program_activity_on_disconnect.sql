-- ==============================================
-- Migration 087: limpiar también `program_activity` al quedar desconectado
-- ==============================================
-- La 086 limpiaba `activity` / `activity_updated_at` (lo detectado por el
-- watcher). Faltaba `program_activity` (081): el programa elegido a mano en
-- Ajustes. Su bloque de la card se leía de la fila sin mirar el estado, así que
-- con el usuario fuera seguía apareciendo "Usando VS Code" y en la DB se
-- quedaba el JSON para siempre (no tiene `*_updated_at`, nunca caduca).
--
-- Se vacía igual que la actividad detectada: el perfil de una cuenta
-- desconectada no debe conservar ni publicar qué estaba usando. La actividad se
-- pierde del todo y solo vuelve cuando se detecta una nueva o el usuario elige
-- otra en Ajustes → Actividad (no se restaura desde copia local).
--
-- Ejecutar DESPUÉS de la 086 (redefine su función; el trigger se recrea por si
-- acaso esta migración se corre sola).

CREATE OR REPLACE FUNCTION public.clear_activity_on_disconnect()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_status = 'disconnected' THEN
    NEW.activity := NULL;
    NEW.activity_updated_at := NULL;
    NEW.program_activity := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.clear_activity_on_disconnect() IS
  'Borra activity/activity_updated_at/program_activity cuando el perfil pasa a user_status = disconnected.';

DROP TRIGGER IF EXISTS profiles_clear_activity_on_disconnect ON public.profiles;
CREATE TRIGGER profiles_clear_activity_on_disconnect
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_activity_on_disconnect();

REVOKE EXECUTE ON FUNCTION public.clear_activity_on_disconnect() FROM anon, authenticated;

-- ── Limpieza única de lo que quedó guardado antes de este arreglo ──
-- Mismo umbral que la app (3 min = STALE_STATUS_MS): pasado ese tiempo sin
-- heartbeat la cuenta está fuera y su actividad ya no es cierta.
UPDATE public.profiles
SET activity = NULL,
    activity_updated_at = NULL,
    program_activity = NULL
WHERE (
    activity IS NOT NULL
    OR program_activity IS NOT NULL
  )
  AND (
    user_status = 'disconnected'
    OR user_status_updated_at IS NULL
    OR user_status_updated_at < NOW() - INTERVAL '3 minutes'
  );
