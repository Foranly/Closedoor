import { createClient } from '@supabase/supabase-js';

/**
 * Lógica compartida de emisión de token LiveKit.
 *
 * Usada por:
 *  - api/livekit-token.js        → Vercel serverless (producción)
 *  - server.js                   → Express (servidor local)
 *  - plugins/livekitTokenPlugin.js → Vite dev
 *
 * IMPORTANTE (bug corregido): el cliente Supabase que consulta `calls` y
 * `is_conversation_participant` DEBE llevar el Authorization del usuario
 * (Bearer access_token). Si se consulta con el cliente anónimo, RLS bloquea
 * las filas silenciosamente (devuelve [] sin error) y la llamada parece no
 * existir → "Call not found". Por eso creamos un cliente por request con el
 * header global Authorization = Bearer <accessToken>.
 *
 * @returns {Promise<{ok: boolean, status: number, error?: string, token?: string, url?: string}>}
 */
export async function issueLiveKitToken({
  supabaseUrl,
  supabaseKey,
  livekitUrl,
  livekitApiKey,
  livekitApiSecret,
  accessToken,
  room,
}) {
  const missingVars = [];
  if (!supabaseUrl) missingVars.push('VITE_SUPABASE_URL');
  if (!supabaseKey) missingVars.push('VITE_SUPABASE_ANON_KEY');
  if (!livekitUrl) missingVars.push('LIVEKIT_URL');
  if (!livekitApiKey) missingVars.push('LIVEKIT_API_KEY');
  if (!livekitApiSecret) missingVars.push('LIVEKIT_API_SECRET');
  if (missingVars.length > 0) {
    return { ok: false, status: 500, error: `LiveKit not configured: missing ${missingVars.join(', ')}` };
  }
  if (!accessToken) {
    return { ok: false, status: 401, error: 'Missing auth token' };
  }
  if (!room || typeof room !== 'string') {
    return { ok: false, status: 400, error: 'Missing room' };
  }

  // Cliente autenticado como el usuario → RLS se evalúa con su identidad.
  const userClient = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);
  if (authError || !user) {
    return { ok: false, status: 401, error: 'Invalid session' };
  }

  const { data: call, error: callError } = await userClient
    .from('calls')
    .select('conversation_id, status')
    .eq('room_name', room)
    .maybeSingle();

  if (callError || !call) {
    return { ok: false, status: 404, error: 'Call not found' };
  }

  // Solo permitir token en llamadas activas o en ringing
  if (!['ringing', 'active'].includes(call.status)) {
    return { ok: false, status: 409, error: 'Call is not active' };
  }

  const { data: isParticipant, error: partError } = await userClient
    .rpc('is_conversation_participant', { conv_id: call.conversation_id });

  if (partError || !isParticipant) {
    return { ok: false, status: 403, error: 'Not a participant' };
  }

  try {
    const { AccessToken } = await import('livekit-server-sdk');
    const at = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: user.id,
      ttl: '2h',
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    return { ok: true, status: 200, token, url: livekitUrl };
  } catch (err) {
    console.warn('[livekit-token] Token error:', err.message);
    return { ok: false, status: 500, error: 'Token generation failed' };
  }
}
