/**
 * Estado de conexión efectivo de un usuario.
 *
 * La columna `user_status` la mantiene el cliente con un heartbeat cada 30 s
 * (useUserStatus). Si el heartbeat se para (app cerrada sin limpieza, equipo
 * apagado, crash) la fila se queda con el último estado; aquí se considera
 * desconectado pasado el umbral.
 *
 * Ventana de 3 min: el heartbeat nominal es 30 s, pero los navegadores clampan
 * los timers de pestañas en segundo plano a ~60 s o más. Con cortes de 60 s los
 * usuarios con la app en una pestaña de fondo parpadeaban a disconnected; los
 * cierres limpios igual marcan disconnected al instante vía
 * beforeunload/pagehide.
 *
 * Vive fuera de UserStatusContext para poder reutilizarlo desde componentes sin
 * romper react-refresh (ese archivo solo debe exportar componentes).
 */

export const STALE_STATUS_MS = 3 * 60 * 1000;

/**
 * @param {{user_status?: string|null, user_status_updated_at?: string|null}|null} user
 *   Fila con el estado (perfil). Sin `user_status` devuelve null (desconocido).
 * @returns {string|null} 'online' | 'dnd' | 'idle' | 'disconnected' | null
 */
export function computeEffectiveStatus(user) {
  if (!user?.user_status) return null;
  if (user.user_status === 'disconnected') return 'disconnected';
  if (!user.user_status_updated_at) return user.user_status;
  const ageMs = Date.now() - new Date(user.user_status_updated_at).getTime();
  return ageMs > STALE_STATUS_MS ? 'disconnected' : user.user_status;
}
