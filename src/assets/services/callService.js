import { supabase } from './supabaseclient';

/**
 * callService — Coordinación de llamadas de voz (LiveKit Cloud).
 *
 * La tabla `calls` guarda el estado del ring y el historial. El media
 * y el signaling los maneja LiveKit Cloud: el cliente obtiene un
 * AccessToken desde /api/livekit-token y se une a la sala room_name.
 *
 * Flujo:
 *  - caller:  startCall() → status 'ringing'
 *  - callee:  recibe el INSERT por Realtime → decide aceptar/rechazar
 *  - accept:  updateCallStatus(id, 'active') → ambos piden token y entran
 *  - fin:     updateCallStatus(id, 'ended' | 'missed' | 'declined')
 */

/**
 * Crear una llamada (status 'ringing').
 * @param {string} conversationId
 * @param {string} callerId
 * @param {string} calleeId
 * @returns {Promise<object>} la fila de calls creada
 */
export async function startCall(conversationId, callerId, calleeId) {
  if (!conversationId || !callerId || !calleeId) {
    throw new Error('Missing call parameters');
  }

  const callId = crypto.randomUUID();
  const roomName = `call-${callId}`;

  const { data, error } = await supabase
    .from('calls')
    .insert({
      id: callId,
      conversation_id: conversationId,
      caller_id: callerId,
      callee_id: calleeId,
      room_name: roomName,
      status: 'ringing',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Actualizar el estado de una llamada.
 * @param {string} callId
 * @param {'ringing'|'active'|'ended'|'missed'|'declined'} status
 */
export async function updateCallStatus(callId, status) {
  const patch = { status };
  if (status === 'active') {
    patch.started_at = new Date().toISOString();
  }
  if (status === 'ended' || status === 'missed' || status === 'declined') {
    patch.ended_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('calls')
    .update(patch)
    .eq('id', callId);

  if (error) throw error;
}

/**
 * Obtener una llamada por id.
 */
export async function getCall(callId) {
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('id', callId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Historial de llamadas de varias conversaciones: alimenta tanto el preview de
 * la lista de chats como los eventos dentro de la conversación.
 * @param {string[]} conversationIds
 * @returns {Promise<object[]>} filas de calls, más recientes primero
 */
export async function getCallsForConversations(conversationIds) {
  if (!conversationIds || conversationIds.length === 0) return [];

  const { data, error } = await supabase
    .from('calls')
    .select('id, conversation_id, caller_id, callee_id, status, started_at, ended_at, created_at')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: false })
    .limit(300);

  if (error) throw error;
  return data || [];
}

/**
 * Suscribirse a eventos de llamadas del usuario (ring entrante + cambios de estado).
 * @param {string} userId
 * @param {(call: object, eventType: string) => void} onCall
 * @param {string} [channelSuffix] — para abrir un segundo canal (p. ej. el
 *   historial de /Chat) sin reutilizar el topic del CallContext global.
 * @returns {() => void} unsubscribe
 */
export function subscribeToCalls(userId, onCall, channelSuffix = '') {
  const channel = supabase
    .channel(`calls-${userId}${channelSuffix}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'calls',
        // Sin filtro de servidor: los filtros or=(...) pueden fallar silenciosamente
        // en Realtime (canal SUBSCRIBED pero sin eventos). RLS ya limita las filas
        // visibles a participantes de la conversación; filtramos client-side.
      },
      (payload) => {
        const call = payload.new || payload.old;
        if (!call) return;
        // Filtro client-side: solo me interesan las llamadas donde soy caller o callee
        if (call.caller_id !== userId && call.callee_id !== userId) return;
        onCall(call, payload.eventType);
      }
    );
  channel.subscribe(() => {});
  return channel;
}

/**
 * Obtener un AccessToken de LiveKit para una sala.
 * @param {string} room — room_name de la llamada
 * @returns {Promise<{token: string, url: string}>}
 */
export async function getLiveKitToken(room) {
  // getSession() devuelve { data: { session }, error } — el destructuring
  // correcto es `data: { session }` (auth-js 2.107).
  const { data } = await supabase.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (!accessToken) throw new Error('Not authenticated');

  const res = await fetch('/api/livekit-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ room }),
  });

  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Failed to get LiveKit token');
  }
  return { token: json.token, url: json.url };
}
