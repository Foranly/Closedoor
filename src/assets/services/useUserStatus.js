import { useState, useEffect, useCallback, useRef, useContext } from 'react';
import { supabase } from './supabaseclient';
import { updateTrackedStatus } from './presenceService';
import { resetActivityDedupe } from './activityService';
import { UserStatusContext } from '../../context/UserStatusContext';

/**
 * useUserStatus — Hook para manejar el estado online/dnd/idle/disconnected
 * del usuario actual. La observación de OTROS usuarios se delega al
 * UserStatusContext global, que hace polling cada 3s en un solo query batch.
 *
 * @param {string} userId — ID del usuario actual (para init + heartbeat + setMyStatus)
 * @param {string|string[]} [otherUserId] — Ya no hace polling propio; solo usa UserStatusContext
 * @returns {{ status: string|null, statuses: object, myStatus: string, setMyStatus: fn }}
 */
export function useUserStatus(userId, otherUserId) {
  const [myStatus, setMyStatusState] = useState('online');
  const myStatusRef = useRef('online');
  const sessionTokenRef = useRef(null);
  const mountedCleanupRef = useRef(null);

  // ── Estados de otros usuarios desde el contexto global ──
  const globalStatuses = useContext(UserStatusContext);

  // Construir status/es a partir del contexto global (sin polling propio)
  let computedStatus = null;
  let computedStatuses = {};
  if (otherUserId) {
    const targetIds = (Array.isArray(otherUserId) ? otherUserId : [otherUserId]).filter(Boolean);
    for (const id of targetIds) {
      computedStatuses[id] = globalStatuses?.[id] || null;
    }
    if (!Array.isArray(otherUserId) && targetIds.length > 0) {
      computedStatus = computedStatuses[targetIds[0]];
    }
  }

  const persistPresence = useCallback(async (newStatus) => {
    if (!userId) return null;

    try {
      // La desconexión limpia la fila de actividad: invalidar el dedupe para que
      // al volver se vuelva a publicar la misma canción.
      if (newStatus === 'disconnected') resetActivityDedupe();

      const payload = {
        user_status: newStatus,
        user_status_updated_at: new Date().toISOString(),
        // Reportarse desconectado limpia la actividad del perfil (música/vídeo/
        // juego). Mismo criterio que el trigger de la migración 086.
        ...(newStatus === 'disconnected'
          ? { activity: null, activity_updated_at: null, program_activity: null }
          : {}),
      };

      const { error } = await supabase
        .from('profiles')
        .update(payload)
        .eq('id', userId);

      if (error) {/* empty */}
      return newStatus;
    } catch (err) {
      // ignore
      return newStatus;
    }
  }, [userId]);

  // ── Actualizar mi estado (DB + Presence + secureStorage) ──
  const setMyStatus = useCallback(async (newStatus) => {
    if (!userId) return;
    if (!['online', 'dnd', 'idle', 'disconnected'].includes(newStatus)) return;


    myStatusRef.current = newStatus;
    setMyStatusState(newStatus);

    // 1. Guardar en secureStorage
    try {
      const { setItem } = await import('./secureStorage');
      setItem('fc_user_status', newStatus);
    } catch {}

    // 2. Actualizar Presence (instantáneo, real-time)
    updateTrackedStatus(newStatus);

    // 3. Persistir en DB (fallback legacy)
    await persistPresence(newStatus);
  }, [persistPresence, userId]);

  // ── Inicializar estado al montar ──
  useEffect(() => {
    if (!userId) return;

    (async () => {
      let initialStatus = 'online';
      try {
        const { getItem } = await import('./secureStorage');
        const saved = getItem('fc_user_status');
        if (saved === 'online' || saved === 'dnd' || saved === 'idle') {
          initialStatus = saved;
        }
      } catch {}

      myStatusRef.current = initialStatus;
      setMyStatusState(initialStatus);

      // ── Setup session token ──
      let authSubscription = null;
      if (typeof supabase?.auth?.getSession === 'function') {
        supabase.auth.getSession().then(({ data } = {}) => {
          sessionTokenRef.current = data?.session?.access_token || null;
        }).catch(() => {});
      }
      if (typeof supabase?.auth?.onAuthStateChange === 'function') {
        const { data } = supabase.auth.onAuthStateChange((_event, session) => {
          sessionTokenRef.current = session?.access_token || null;
        });
        authSubscription = data?.subscription || null;
      }

      // ── Heartbeat cada 30s ──
      // ⚠️ Lee SIEMPRE secureStorage en cada tick (igual que el tracker
      // global de AuthContext). Usar solo myStatusRef congelaba el valor del
      // montaje: si el estado cambió por otra pestaña/vía, este heartbeat
      // sobreescribía la DB con un estado viejo ("resetea a online").
      const heartbeatRef = { current: null };
      const startHeartbeat = () => {
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = setInterval(async () => {
          let s = myStatusRef.current;
          try {
            const { getItem } = await import('./secureStorage');
            const saved = getItem('fc_user_status');
            if (saved === 'online' || saved === 'dnd' || saved === 'idle') {
              s = saved;
              if (myStatusRef.current !== s) {
                myStatusRef.current = s;
                setMyStatusState(s); // sincronizar UI propia entre pestañas
              }
            }
          } catch {
            // secureStorage no disponible → mantener ref actual
          }
          if (s === 'online' || s === 'idle' || s === 'dnd') {
            persistPresence(s).catch(() => {});
          }
        }, 30000);
      };
      startHeartbeat();

      // ── beforeunload/pagehide: poner disconnected ──
      const SB_URL = import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_DATA_API_URL || '';
      const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
      const restOrigin = (() => { try { return new URL(SB_URL).origin; } catch { return ''; } })();

      const handleDisconnect = () => {
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        resetActivityDedupe();

        // 1. DB vía fetch con keepalive: true — garantiza que llegue aunque
        //    el navegador cierre la pestaña
        const token = sessionTokenRef.current;
        if (SB_URL && SB_KEY && token) {
          try {
            fetch(`${restOrigin}/rest/v1/profiles?id=eq.${userId}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'apikey': SB_KEY,
              },                body: JSON.stringify({
                  user_status: 'disconnected',
                  user_status_updated_at: new Date().toISOString(),
                  // Limpieza de actividad en la MISMA petición keepalive (no se
                  // puede mandar una segunda al cerrar la pestaña).
                  activity: null,
                  activity_updated_at: null,
                  program_activity: null,
                }),
              keepalive: true,
            }).catch(() => {});
          } catch {}
        }

        // 2. Fallback persistPresence
        persistPresence('disconnected').catch(() => {});

        // NOTA: NO llamar a updateTrackedStatus aquí. El channel.track() durante
        // beforeunload puede dejar al usuario atascado en el canal Presence con
        // el último estado, impidiendo que otros clientes detecten la desconexión.
      };
      window.addEventListener('beforeunload', handleDisconnect);
      window.addEventListener('pagehide', handleDisconnect);

      mountedCleanupRef.current = () => {
        window.removeEventListener('beforeunload', handleDisconnect);
        window.removeEventListener('pagehide', handleDisconnect);
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        authSubscription?.unsubscribe?.();
      };

      // Sync inicial con la DB
      persistPresence(initialStatus).catch(() => {});
    })();

    return () => {
      if (mountedCleanupRef.current) {
        mountedCleanupRef.current();
        mountedCleanupRef.current = null;
      }
    };
  }, [userId, setMyStatus]);

  return { status: computedStatus, statuses: computedStatuses, myStatus, setMyStatus };
}

