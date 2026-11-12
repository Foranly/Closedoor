import { supabase, dbPublic } from './supabaseclient';
import { getItem, setItem, removeItem } from './secureStorage';
import { encryptForUsers, decryptForUser } from './alphabetEncryption';
import { sanitizeContent, detectMediaFromContent } from './helpers';

// ── Conversation ──

/**
 * Get or create a conversation between current user and another user
 */
export async function getOrCreateConversation(currentUserId, otherUserId) {
  if (!currentUserId || !otherUserId) throw new Error('Both user IDs required');

  // Check if a conversation already exists between these two users
  // A 2-person chat is uniquely identified by the pair of participants
  const { data: myConvs } = await supabase
    .from('chat_participants')
    .select('conversation_id')
    .eq('user_id', currentUserId);

  const myConvIds = (myConvs || []).map(p => p.conversation_id);

  if (myConvIds.length > 0) {
    const { data: match } = await supabase
      .from('chat_participants')
      .select('conversation_id')
      .in('conversation_id', myConvIds)
      .eq('user_id', otherUserId)
      .maybeSingle();

    if (match) {
      return match.conversation_id;
    }
  }

  // Create new conversation — generate UUID client-side to avoid RLS on SELECT after INSERT
  const convId = crypto.randomUUID();
  const { error: convError } = await supabase
    .from('conversations')
    .insert({ id: convId });

  if (convError) throw convError;

  // Add participants
  const participants = [
    { conversation_id: convId, user_id: currentUserId },
    { conversation_id: convId, user_id: otherUserId },
  ];

  const { error: partError } = await supabase
    .from('chat_participants')
    .insert(participants);

  if (partError) throw partError;

  return convId;
}

// ── Grupos ──

// Límite de miembros por grupo. Con el cifrado actual cada mensaje se cifra
// una vez por destinatario, así que grupos enormes multiplican el coste de
// envío; 50 es holgado para la app y mantiene el envío instantáneo.
export const GROUP_MAX_MEMBERS = 50;

/**
 * Crea un grupo y devuelve su id. El creador queda como 'owner'.
 * `memberIds` no debe incluir al creador.
 */
export async function createGroupConversation(creatorId, memberIds = [], title = '') {
  if (!creatorId) throw new Error('creator_required');

  const members = [...new Set(memberIds.filter((id) => id && id !== creatorId))];
  if (members.length === 0) throw new Error('group_needs_members');
  if (members.length + 1 > GROUP_MAX_MEMBERS) throw new Error('group_too_large');

  const cleanTitle = (title || '').trim().slice(0, 80);

  // UUID en cliente: tras el INSERT la fila no es legible por RLS hasta que
  // exista la participación del creador (mismo motivo que en los 1:1).
  const convId = crypto.randomUUID();

  const { error: convError } = await supabase.from('conversations').insert({
    id: convId,
    kind: 'group',
    title: cleanTitle || null,
    created_by: creatorId,
  });
  if (convError) throw convError;

  const { error: partError } = await supabase.from('chat_participants').insert([
    { conversation_id: convId, user_id: creatorId, role: 'owner' },
    ...members.map((id) => ({ conversation_id: convId, user_id: id, role: 'member' })),
  ]);
  if (partError) throw partError;

  return convId;
}

/** Miembros actuales de una conversación: [{ user_id, role, joined_at }]. */
export async function getConversationMembers(conversationId) {
  const { data, error } = await supabase
    .from('chat_participants')
    .select('user_id, role, joined_at')
    .eq('conversation_id', conversationId);
  if (error) throw error;
  return data || [];
}

/** Perfiles de los miembros, para pintar la lista del grupo. */
export async function getConversationMembersWithProfiles(conversationId) {
  const members = await getConversationMembers(conversationId);
  if (members.length === 0) return [];

  const { data: profiles } = await dbPublic
    .from('profiles')
    .select('id, username, displayname, avatar_url, avatar_position, accent_color, user_status, user_status_updated_at')
    .in('id', members.map((m) => m.user_id));

  const byId = {};
  for (const p of profiles || []) byId[p.id] = p;

  return members
    .map((m) => ({ ...m, profile: byId[m.user_id] || null }))
    .sort((a, b) => {
      const rank = { owner: 0, admin: 1, member: 2 };
      return (rank[a.role] ?? 3) - (rank[b.role] ?? 3);
    });
}

/**
 * Añade miembros a un grupo. Va por RPC: la política INSERT de
 * chat_participants está abierta para los 1:1, y la función comprueba que quien
 * llama es miembro y que la conversación es un grupo.
 */
export async function addGroupMembers(conversationId, userIds = []) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return 0;

  const { error } = await supabase.rpc('add_group_members', {
    conv_id: conversationId,
    member_ids: ids,
  });
  if (error) throw error;

  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);

  return ids.length;
}

/** Saca a alguien del grupo (solo owner/admin). */
export async function removeGroupMember(conversationId, userId) {
  const { error } = await supabase.rpc('remove_group_member', {
    conv_id: conversationId,
    target: userId,
  });
  if (error) throw error;
}

/** Asciende a admin o devuelve a miembro (solo el dueño del grupo). */
export async function setGroupMemberRole(conversationId, userId, role) {
  if (!conversationId || !userId) return;
  if (role !== 'admin' && role !== 'member') throw new Error('invalid_role');

  const { error } = await supabase.rpc('set_group_member_role', {
    conv_id: conversationId,
    target: userId,
    new_role: role,
  });
  if (error) throw error;
}

/** Abandona el grupo: se borra solo la propia participación. */
export async function leaveGroupConversation(conversationId, userId) {
  const { error } = await supabase
    .from('chat_participants')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', userId);
  if (error) throw error;
}

/** Renombra el grupo o le cambia el avatar. */
export async function updateGroupConversation(conversationId, { title, avatarUrl } = {}) {
  const patch = {};
  if (title !== undefined) patch.title = (title || '').trim().slice(0, 80) || null;
  if (avatarUrl !== undefined) patch.avatar_url = avatarUrl || null;
  if (Object.keys(patch).length === 0) return;

  const { error } = await supabase.from('conversations').update(patch).eq('id', conversationId);
  if (error) throw error;
}

/**
 * Get all conversations for the current user
 * Uses separate queries instead of embedded joins for reliability
 */
export async function getConversations(userId) {
  if (!userId) return [];

  // 1. Get all conversation IDs + pin status where user is a participant
  const { data: myParts, error: partError } = await supabase
    .from('chat_participants')
    .select('conversation_id, is_pinned, pinned_at, role')
    .eq('user_id', userId);

  if (partError) {
    console.warn('[Chat] Error fetching participants:', partError);
    throw partError;
  }
  if (!myParts || myParts.length === 0) return [];

  const convIds = myParts.map(p => p.conversation_id);

  // 2. Get conversation details — only show conversations that have at least one message
  const { data: convs, error: convError } = await supabase
    .from('conversations')
    .select('*')
    .in('id', convIds)
    .not('last_message_text', 'is', null)
    .order('updated_at', { ascending: false });

  if (convError) {
    console.warn('[Chat] Error fetching conversations:', convError);
    throw convError;
  }
  if (!convs || convs.length === 0) return [];

  // 3. Get ALL other participant user_ids in one batch query
  const { data: allParticipants } = await supabase
    .from('chat_participants')
    .select('conversation_id, user_id')
    .in('conversation_id', convIds);

  // Build a map: conversation_id → [otros user_ids] (en grupos, varios)
  const membersByConv = {};
  for (const p of allParticipants || []) {
    if (p.user_id !== userId) {
      (membersByConv[p.conversation_id] ||= []).push(p.user_id);
    }
  }

  // 4. Fetch ALL profiles in one batch query
  const uniqueUserIds = [...new Set(Object.values(membersByConv).flat().filter(Boolean))];
  let profilesMap = {};
  if (uniqueUserIds.length > 0) {
    const { data: profiles } = await dbPublic
      .from('profiles')
      .select('id, username, displayname, avatar_url, banner_url, bio, pronouns, roles, is_private, interests, accent_color, accent_color_secondary, banner_position, avatar_position, user_status, user_status_updated_at')
      .in('id', uniqueUserIds);
    for (const p of profiles || []) {
      profilesMap[p.id] = p;
    }
    cacheSenderProfiles(profiles);
  }

  // 5. Fetch follower counts for all other users in one batch
  let followerCounts = {};
  if (uniqueUserIds.length > 0) {
    const countPromises = uniqueUserIds.map(async (uid) => {
      const { count } = await supabase
        .from('follows')
        .select('follower_id', { count: 'exact', head: true })
        .eq('following_id', uid)
        .eq('status', 'accepted');
      return { id: uid, followers: count || 0 };
    });
    const countResults = await Promise.all(countPromises);
    for (const r of countResults) {
      followerCounts[r.id] = r.followers;
    }
  }

  // 6. Build pin map: conversation_id → { is_pinned, pinned_at }
  const pinMap = {};
  for (const p of myParts || []) {
    pinMap[p.conversation_id] = { is_pinned: p.is_pinned || false, pinned_at: p.pinned_at || null, role: p.role || 'member' };
  }

  // 7. Build results + apply sort: pinned first (oldest→newest), then unpinned
  const convResults = convs.map((conv) => {
    const memberIds = membersByConv[conv.id] || [];
    const isGroup = conv.kind === 'group';

    // En los 1:1 `otherUser` es la contraparte (lo que ya consumía la UI).
    // En grupos se expone `members`; `otherUser` queda null a propósito para
    // que nada lo use como "el otro" de un grupo.
    const otherUserId = isGroup ? null : memberIds[0];
    const otherProfile = otherUserId ? (profilesMap[otherUserId] || null) : null;
    const pin = pinMap[conv.id] || { is_pinned: false, pinned_at: null };
    const unread = getUnreadCount(conv.id, userId);

    return {
      ...conv,
      isGroup,
      memberIds,
      members: memberIds.map((id) => profilesMap[id]).filter(Boolean),
      is_pinned: pin.is_pinned,
      pinned_at: pin.pinned_at,
      // Rol del usuario actual en la conversación (en grupos decide quién
      // puede retirar mensajes ajenos).
      myRole: pin.role || 'member',
      otherUser: otherProfile ? {
        ...otherProfile,
        followerCount: followerCounts[otherUserId] || 0,
      } : null,
      unreadCount: unread,
    };
  });

  // Resolve unread counts (which are async)
  const resolved = await Promise.all(convResults.map(async (c) => ({
    ...c,
    unreadCount: await c.unreadCount,
  })));

  // Sort: pinned first (oldest pinned_at first), then unpinned (by updated_at desc)
  resolved.sort((a, b) => {
    if (a.is_pinned && !b.is_pinned) return -1;
    if (!a.is_pinned && b.is_pinned) return 1;
    if (a.is_pinned && b.is_pinned) {
      const dateA = new Date(a.pinned_at || 0).getTime();
      const dateB = new Date(b.pinned_at || 0).getTime();
      return dateA - dateB; // oldest first
    }
    return new Date(b.updated_at) - new Date(a.updated_at);
  });

  return resolved;
}

/**
 * Get unread message count for a conversation
 */
export async function getUnreadCount(conversationId, userId) {
  const { data: participant } = await supabase
    .from('chat_participants')
    .select('last_read_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!participant?.last_read_at) {
    // Count all messages if never read
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .neq('sender_id', userId);
    return count || 0;
  }

  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .neq('sender_id', userId)
    .gt('created_at', participant.last_read_at);

  return count || 0;
}

/**
 * Get total unread chat message count across all conversations for a user
 */
export async function getTotalUnreadChatCount(userId) {
  if (!userId) return 0;
  try {
    const { data: participantRows } = await supabase
      .from('chat_participants')
      .select('conversation_id, last_read_at')
      .eq('user_id', userId);

    if (!participantRows || participantRows.length === 0) return 0;

    // Batch: conversations without last_read_at → single query
    const noReadAt = participantRows.filter(p => !p.last_read_at).map(p => p.conversation_id);
    const hasReadAt = participantRows.filter(p => p.last_read_at);

    let total = 0;

    if (noReadAt.length > 0) {
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .in('conversation_id', noReadAt)
        .neq('sender_id', userId);
      total += count || 0;
    }

    // Conversations with last_read_at still need individual queries (different timestamps)
    for (const p of hasReadAt) {
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', p.conversation_id)
        .neq('sender_id', userId)
        .gt('created_at', p.last_read_at);
      total += count || 0;
    }

    return total;
  } catch (err) {
    console.warn('Error computing total unread chat count:', err);
    return 0;
  }
}

/**
 * Mark conversation as read
 */
export async function markAsRead(conversationId, userId) {
  const { error } = await supabase
    .from('chat_participants')
    .update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId);

  if (error) console.warn('Error marking as read:', error);
}

// ── Messages ──

/**
 * Normaliza la canción compartida al shape que consume la tarjeta del chat
 * (mismo que devuelve services/musicService.searchMusic).
 *
 * Solo se guardan campos conocidos y URLs http(s): `shared_song` es jsonb
 * escrito por el remitente, así que no se persiste un blob arbitrario.
 */
function normalizeSharedSong(song) {
  if (!song || typeof song !== 'object') return null;
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const httpUrl = (v) => {
    if (typeof v !== 'string' || !v.trim()) return '';
    try {
      const url = new URL(v);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch {
      return '';
    }
  };

  const title = text(song.title, 200);
  // El artista puede faltar (canales de YouTube sin nombre útil): el stream de
  // esas canciones se resuelve por videoId, así que la tarjeta sigue siendo válida.
  const artist = text(song.artist, 200);
  if (!title) return null;

  const duration = Number(song.duration);
  return {
    provider: text(song.provider, 20) || 'unknown',
    trackId: text(song.trackId, 100),
    title,
    artist,
    album: text(song.album, 200),
    artwork: httpUrl(song.artwork),
    previewUrl: httpUrl(song.previewUrl),
    externalUrl: httpUrl(song.externalUrl),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
  };
}

/**
 * Send an encrypted message
 */
export async function sendMessage(conversationId, senderId, content, participantIds, replyTo = null, sharedPostId = null, sharedCommunityId = null, sharedInviteToken = null, sharedSong = null) {
  // Un post de perfil privado no se reenvía a terceros (misma regla que
  // repostPost). La UI ya deshabilita la acción; esto cubre clientes viejos o
  // un post que pasó a privado con el menú abierto.
  if (sharedPostId) {
    const { data: sharedPost } = await supabase
      .from('posts')
      .select('user_id, profiles!posts_user_id_fkey (is_private)')
      .eq('id', sharedPostId)
      .maybeSingle();
    if (sharedPost && sharedPost.profiles?.is_private === true && sharedPost.user_id !== senderId) {
      throw new Error('share_private_forbidden');
    }
  }

  const allIds = [...new Set([senderId, ...participantIds])];

  // Sanitizar contenido antes de cifrarlo (anti-XSS: no guardar scripts)
  const cleanContent = sanitizeContent(content);
  // Encrypt content for all participants
  const { ciphertext, iv } = await encryptForUsers(cleanContent, senderId, allIds);

  // Build insert payload
  const insertPayload = {
    conversation_id: conversationId,
    sender_id: senderId,
    ciphertext,
    iv,
    encrypted_for: allIds,
  };
  if (replyTo) {
    insertPayload.reply_to = replyTo;
  }
  if (sharedPostId) {
    insertPayload.shared_post_id = sharedPostId;
  }
  if (sharedCommunityId) {
    insertPayload.shared_community_id = sharedCommunityId;
  }
  if (sharedInviteToken) {
    insertPayload.shared_invite_token = sharedInviteToken;
  }
  const cleanSharedSong = normalizeSharedSong(sharedSong);
  if (cleanSharedSong) {
    insertPayload.shared_song = cleanSharedSong;
  }

  // Insert message with sender_id, then fetch profile separately
  const { data: msg, error } = await supabase
    .from('messages')
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw error;

  // Fetch sender profile separately
  const { data: senderProfile } = await dbPublic
    .from('profiles')
    .select('id, username, displayname, avatar_url, avatar_position, accent_color, user_status, user_status_updated_at')
    .eq('id', senderId)
    .maybeSingle();

  const data = { ...msg, profiles: senderProfile };

  // Update conversation last_message_text with obfuscated preview
  const videoPreview = detectMediaFromContent(cleanContent).videoUrl;
  const obfuscatedPreview = sharedPostId
    ? '📌 Shared a post'
    : sharedCommunityId
    ? '🏘️ Community invite'
    : cleanSharedSong
    ? '🎵 Shared a song'
    : videoPreview
    ? '🎬 Video'
    : (cleanContent.length > 80 ? cleanContent.slice(0, 80) + '...' : cleanContent);
  await supabase
    .from('conversations')
    .update({ last_message_text: obfuscatedPreview })
    .eq('id', conversationId);

  return data;
}

/**
 * Get messages for a conversation
 */
export async function getMessages(conversationId, limit = 50, before = null) {
  let query = supabase
    .from('messages')
    .select()
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt('created_at', before);
  }

  const { data, error } = await query;
  if (error) throw error;

  let msgs = (data || []).reverse();
  if (msgs.length === 0) return [];

  const senderIds = [...new Set(msgs.map(m => m.sender_id))];
  const { data: profiles } = await dbPublic
    .from('profiles')
    .select('id, username, displayname, avatar_url, avatar_position, accent_color, user_status, user_status_updated_at')
    .in('id', senderIds);

  const profileMap = {};
  for (const p of profiles || []) {
    profileMap[p.id] = p;
  }
  cacheSenderProfiles(profiles);

  return msgs.map(m => ({
    ...m,
    profiles: profileMap[m.sender_id] || null,
  }));
}

/**
 * Decrypt a message for the current user
 */
export async function decryptMessage(message, currentUserId) {
  if (message.removed_by) return null;
  if (!message.encrypted_for?.includes(currentUserId)) return null;
  return decryptForUser(
    message.ciphertext,
    message.iv,
    message.sender_id,
    message.encrypted_for,
    currentUserId
  );
}

/**
 * Mensajes FIJADOS de una conversación, descifrados para el usuario actual.
 *
 * Se consultan directamente por `is_pinned` en la BD en vez de derivarlos del
 * array `messages` de la UI: así el panel de fijados se rellena al instante
 * aunque la conversación aún no haya terminado de cargar (y aunque los
 * fijados estén fuera de la página de mensajes cargada).
 */
export async function getPinnedMessages(conversationId, currentUserId) {
  if (!conversationId || !currentUserId) return [];

  const { data, error } = await supabase
    .from('messages')
    .select()
    .eq('conversation_id', conversationId)
    .eq('is_pinned', true)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const rows = (data || []).filter(m => !m.deleted_for?.includes(currentUserId));
  return Promise.all(rows.map(async (m) => ({
    ...m,
    decryptedContent: await decryptMessage(m, currentUserId),
  })));
}

/**
 * Últimos mensajes de una conversación descifrados (para la galería de media).
 *
 * El contenido va cifrado en la BD, así que no se puede filtrar por imagen en
 * SQL: se traen los últimos `limit` y se descifran en cliente. Esto permite
 * mostrar las imágenes al instante sin esperar a que Chat cargue sus páginas.
 */
export async function getDecryptedMessages(conversationId, currentUserId, limit = 300) {
  if (!conversationId || !currentUserId) return [];

  const { data, error } = await supabase
    .from('messages')
    .select()
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const rows = (data || []).filter(m => !m.deleted_for?.includes(currentUserId));
  return Promise.all(rows.map(async (m) => ({
    ...m,
    decryptedContent: await decryptMessage(m, currentUserId),
  })));
}

// ── Canales realtime de mensajes: UNO por conversación, compartido ──
//
// `supabase.channel(topic)` devuelve el MISMO canal si el topic ya existe. Al
// haber ahora dos consumidores (la ventana flotante y Chat.jsx), el segundo
// hacía `.on(...)` sobre un canal que ya estaba `subscribe()`-ado y Supabase
// lanzaba: "cannot add `postgres_changes` callbacks after `subscribe()`".
//
// Aquí se registra un canal por conversación con una lista de suscriptores:
// cada evento se reparte a todos, y el canal se cierra (unsubscribe +
// removeChannel) cuando se va el último.
const messageChannels = new Map();

// Perfiles de emisores ya vistos. Sin esto, cada mensaje entrante espera una
// consulta a `profiles` antes de avisar a la UI: la burbuja aparecía al
// instante pero sin nombre ni avatar (y en grupos el nombre llegaba «unos ms
// después»). Con la caché el mensaje se pinta completo desde el primer render.
// `getMessages`/`getConversations` la siembran con perfiles frescos.
const senderProfileCache = new Map();
const SENDER_PROFILE_COLUMNS = 'id, username, displayname, avatar_url, avatar_position, accent_color, user_status, user_status_updated_at';

function cacheSenderProfiles(profiles) {
  for (const p of profiles || []) {
    if (p?.id) senderProfileCache.set(p.id, p);
  }
}

/** Trae el mensaje ya con el perfil del emisor (mismo shape que antes). */
async function fetchMessageWithProfile(messageId) {
  const { data: msg } = await supabase
    .from('messages')
    .select()
    .eq('id', messageId)
    .single();
  if (!msg) return null;

  const cached = senderProfileCache.get(msg.sender_id) || null;
  if (cached) return { ...msg, profiles: cached };

  const { data: profile } = await dbPublic
    .from('profiles')
    .select(SENDER_PROFILE_COLUMNS)
    .eq('id', msg.sender_id)
    .maybeSingle();

  if (profile) senderProfileCache.set(profile.id, profile);
  return { ...msg, profiles: profile };
}

/**
 * Subscribe to new messages in a conversation (realtime).
 * Devuelve `{ unsubscribe }`; se puede llamar varias veces por conversación.
 */
export function subscribeToMessages(conversationId, onMessage, onDelete) {
  if (!conversationId) return { unsubscribe() {} };

  let entry = messageChannels.get(conversationId);
  if (!entry) {
    const listeners = new Set();

    const channel = supabase
      .channel(`chat-${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          const msg = await fetchMessageWithProfile(payload.new.id);
          if (!msg) return;
          listeners.forEach((listener) => listener.onMessage?.(msg, 'INSERT'));
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          const msg = await fetchMessageWithProfile(payload.new.id);
          if (!msg) return;
          listeners.forEach((listener) => listener.onMessage?.(msg, 'UPDATE'));
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const deletedId = payload.old?.id;
          if (!deletedId) return;
          listeners.forEach((listener) => listener.onDelete?.(deletedId));
        }
      )
      .subscribe();

    entry = { channel, listeners };
    messageChannels.set(conversationId, entry);
  }

  const listener = { onMessage, onDelete };
  entry.listeners.add(listener);

  return {
    unsubscribe() {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0) return;

      messageChannels.delete(conversationId);
      try { entry.channel.unsubscribe(); } catch { /* ya cerrado */ }
      try { supabase.removeChannel(entry.channel); } catch { /* ya quitado */ }
    },
  };
}

/**
 * Subscribe to conversation updates (for unread count sidebar)
 */
// ── Message Actions ──

/**
 * Permanently delete a message (own messages only)
 */
export async function deleteMessage(messageId) {
  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('id', messageId);
  if (error) throw error;
}

/**
 * Retira un mensaje ajeno (solo dueño/admin del grupo, se limita en la UI).
 *
 * No se borra la fila: se vacía el cifrado y se guarda quién lo retiró, así el
 * hilo muestra «Ana eliminó este mensaje» en el mismo sitio (migración 097).
 */
export async function removeMessageForEveryone(messageId, removedBy) {
  if (!messageId || !removedBy) return;

  const { error } = await supabase
    .from('messages')
    .update({
      ciphertext: '',
      iv: '',
      removed_by: removedBy,
      removed_at: new Date().toISOString(),
      is_pinned: false,
      reactions: {},
    })
    .eq('id', messageId);
  if (error) throw error;
}

/**
 * Delete a message "for me" (adds user to deleted_for array)
 */
export async function deleteMessageForMe(messageId, userId) {
  // Fetch current deleted_for
  const { data: msg } = await supabase
    .from('messages')
    .select('deleted_for')
    .eq('id', messageId)
    .single();
  if (!msg) return;

  const current = msg.deleted_for || [];
  if (current.includes(userId)) return;

  const { error } = await supabase
    .from('messages')
    .update({ deleted_for: [...current, userId] })
    .eq('id', messageId);
  if (error) throw error;
}

/**
 * Edit a message (re-encrypt with new content)
 */
export async function editMessage(messageId, senderId, newContent, participantIds) {
  const allIds = [...new Set([senderId, ...(participantIds || [])])];
  const { ciphertext, iv } = await encryptForUsers(newContent, senderId, allIds);

  const { error } = await supabase
    .from('messages')
    .update({
      ciphertext,
      iv,
      encrypted_for: allIds,
      edited_at: new Date().toISOString(),
    })
    .eq('id', messageId);
  if (error) throw error;
}

/**
 * Toggle pin on a message
 */
export async function pinMessage(messageId, pinned) {
  const { error } = await supabase
    .from('messages')
    .update({ is_pinned: pinned })
    .eq('id', messageId);
  if (error) throw error;
}

/**
 * Toggle emoji reaction on a message
 * reactions is a JSONB { [user_id]: "emoji" }
 * If same emoji, remove it; if different emoji, set it
 */
export async function addReaction(messageId, userId, emoji) {
  // Fetch current reactions
  const { data: msg } = await supabase
    .from('messages')
    .select('reactions')
    .eq('id', messageId)
    .single();
  if (!msg) return;

  const reactions = msg.reactions || {};
  if (reactions[userId] === emoji) {
    // Remove reaction
    delete reactions[userId];
  } else {
    // Set/change reaction
    reactions[userId] = emoji;
  }

  const { error } = await supabase
    .from('messages')
    .update({ reactions })
    .eq('id', messageId);
  if (error) throw error;
}

/**
 * Delete a conversation for the current user only.
 * Removes the participant row so the conversation disappears from the user's list,
 * but the conversation and messages remain in the DB for the other participant.
 */
export async function deleteConversation(conversationId, userId) {
  if (!userId) {
    throw new Error('User ID required to delete conversation');
  }
  const { error } = await supabase
    .from('chat_participants')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', userId);

  if (error) {
    console.error('Error deleting conversation:', error);
    throw error;
  }
}

/**
 * Toggle pin status on a conversation (per-user).
 * Max 3 pinned conversations.
 * Returns the new pin state, or throws if limit reached.
 */
export async function togglePinConversation(conversationId, userId, currentlyPinned) {
  if (!userId) throw new Error('User ID required');

  if (!currentlyPinned) {
    // Check current pin count
    const { count, error: countError } = await supabase
      .from('chat_participants')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_pinned', true);

    if (countError) throw countError;
    if (count >= 3) throw new Error('Maximum 3 pinned conversations');
  }

  const { error } = await supabase
    .from('chat_participants')
    .update({
      is_pinned: !currentlyPinned,
      pinned_at: !currentlyPinned ? new Date().toISOString() : null,
    })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId);

  if (error) throw error;
}

/**
 * Subscribe to conversation list updates.
 * Watches both chat_participants (for new conversations) and messages INSERT
 * (for new messages in existing conversations) to keep the conversation list
 * updated in real-time.
 *
 * The messages INSERT handler uses encrypted_for to filter only conversations
 * the user participates in, avoiding unnecessary loadConvs() calls.
 */
export function subscribeToConversations(userId, onUpdate) {
  return supabase
    .channel(`chat-convs-${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'chat_participants',
        filter: `user_id=eq.${userId}`,
      },
      () => onUpdate()
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      },
      async (payload) => {
        // Only trigger if this message is from a conversation the user participates in
        if (payload.new.encrypted_for?.includes(userId)) {
          onUpdate();
        }
      }
    )
    .subscribe();
}

/**
 * Cambios en los participantes de UNA conversación: altas, bajas y cambios de
 * rol. `subscribeToConversations` filtra por `user_id`, así que no se entera
 * cuando cambia otro miembro; esto sí. Devuelve el canal (o null).
 */
export function subscribeToConversationParticipants(conversationId, onChange) {
  if (!conversationId || typeof onChange !== 'function') return () => {};
  const channel = supabase
    .channel(`chat-participants-${conversationId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'chat_participants',
        filter: `conversation_id=eq.${conversationId}`,
      },
      () => onChange()
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

// Secuencia para no repetir nombre de canal entre suscripciones simultáneas.
let profileWatchSeq = 0;

/**
 * Ediciones de perfil (displayname, username, avatar…) de los usuarios dados:
 * el rail de miembros se refresca sin recargar la página. Requiere que
 * `profiles` esté en la publicación de Supabase Realtime (migración 098).
 */
export function subscribeToProfilesUpdates(userIds = [], onChange) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0 || typeof onChange !== 'function') return () => {};
  profileWatchSeq += 1;
  const channel = supabase
    .channel(`profiles-watch-${profileWatchSeq}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: `id=in.(${ids.join(',')})`,
      },
      () => onChange()
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

// ── Typing indicator (Realtime Broadcast, no DB table needed) ──

const typingChannels = {};
const typingTimeouts = {};
let typingBroadcastId = 0;

/**
 * Broadcast that the current user is typing in a conversation.
 * Sends a broadcast message via Supabase Realtime Broadcast.
 * Call this on every keystroke — it will throttle to 1 broadcast per 2 seconds.
 */
export function broadcastTyping(conversationId, userId) {
  if (!conversationId || !userId) return;

  // Get or create the broadcast channel
  const channelKey = `chat-typing-${conversationId}`;
  if (!typingChannels[channelKey]) {
    const channel = supabase.channel(channelKey, {
      broadcast: { self: true }, // Don't echo our own broadcasts
    });
    channel.subscribe();
    typingChannels[channelKey] = channel;
  }

  // Throttle: only broadcast every 2 seconds
  const now = Date.now();
  if (typingTimeouts[channelKey] && now - typingTimeouts[channelKey] < 1700) return;
  typingTimeouts[channelKey] = now;

  typingChannels[channelKey].send({
    type: 'broadcast',
    event: 'typing',
    payload: { userId, conversationId, timestamp: now },
  });
}

/**
 * Subscribe to typing events from other users in a conversation.
 * Returns an unsubscribe function.
 *
 * @param {string} conversationId
 * @param {string} currentUserId — to filter out our own typing events
 * @param {function} onTyping — called with { userId, conversationId } when someone starts typing
 * @param {function} onStopTyping — called with { userId } when someone stops typing (2s timeout)
 */
export function subscribeToTyping(conversationId, currentUserId, onTyping, onStopTyping) {
  if (!conversationId) return () => {};

  const channelKey = `chat-typing-${conversationId}`;
  const stopTimers = {};

  const channel = supabase.channel(channelKey, {
    broadcast: { self: true },
  });

  channel.on('broadcast', { event: 'typing' }, (payload) => {
    const { userId } = payload;
    if (userId === currentUserId) return; // Ignore our own typing

    onTyping({ userId });

    // Clear any existing stop timer for this user
    if (stopTimers[userId]) {
      clearTimeout(stopTimers[userId]);
    }

    // After 3 seconds of no broadcast, consider typing stopped
    stopTimers[userId] = setTimeout(() => {
      onStopTyping({ userId });
      delete stopTimers[userId];
    }, 3000);
  });

  channel.subscribe();

  // Return unsubscribe function that cleans up timers and the channel
  return () => {
    Object.values(stopTimers).forEach(clearTimeout);
    supabase.removeChannel(channel);
    delete typingChannels[channelKey];
  };
}

// ── Nicknames ──

/**
 * Get all nicknames set by the current user.
 * Returns a map: { [target_user_id]: "nickname" }
 */
export async function getNicknames(userId) {
  if (!userId) return {};
  const { data, error } = await supabase
    .from('chat_nicknames')
    .select('target_user_id, nickname')
    .eq('user_id', userId);
  if (error) {
    console.warn('[Nicknames] Error fetching:', error);
    return {};
  }
  const map = {};
  for (const row of data || []) {
    map[row.target_user_id] = row.nickname;
  }
  return map;
}

/**
 * Set or update a nickname for a target user.
 */
export async function setNickname(userId, targetUserId, nickname) {
  if (!userId || !targetUserId) throw new Error('Both user IDs required');
  const trimmed = (nickname || '').trim();
  if (trimmed.length > 50) throw new Error('Nickname too long (max 50 chars)');

  if (!trimmed) {
    // Empty → remove nickname
    await removeNickname(userId, targetUserId);
    return;
  }

  const { error } = await supabase
    .from('chat_nicknames')
    .upsert({
      user_id: userId,
      target_user_id: targetUserId,
      nickname: trimmed,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,target_user_id' });
  if (error) throw error;
}

/**
 * Remove a nickname for a target user.
 */
export async function removeNickname(userId, targetUserId) {
  if (!userId || !targetUserId) return;
  const { error } = await supabase
    .from('chat_nicknames')
    .delete()
    .eq('user_id', userId)
    .eq('target_user_id', targetUserId);
  if (error) throw error;
}

// ── localStorage cache ──

const NICKNAMES_CACHE_PREFIX = 'fc_nicks_';
const NICKNAMES_CACHE_TTL = 1000 * 60 * 30; // 30 minutes

/**
 * Cache the nicknames map for a user in localStorage.
 * Allows instant restore on next visit without waiting for DB.
 */
export function cacheNicknames(userId, nicknamesMap) {
  if (!userId) return;
  try {
    const payload = { ts: Date.now(), ttl: NICKNAMES_CACHE_TTL, data: nicknamesMap };
    setItem(NICKNAMES_CACHE_PREFIX + userId, payload);
  } catch {}
}

/**
 * Read cached nicknames from localStorage.
 * Returns the map { target_user_id: nickname } or null if expired/missing.
 */
export function getCachedNicknames(userId) {
  if (!userId) return null;
  try {
    const p = getItem(NICKNAMES_CACHE_PREFIX + userId);
    if (!p || !p.ts) return null;
    if (Date.now() - p.ts > (p.ttl || NICKNAMES_CACHE_TTL)) {
      removeItem(NICKNAMES_CACHE_PREFIX + userId);
      return null;
    }
    return p.data || null;
  } catch { return null; }
}

/**
 * Clear cached nicknames for a user.
 */
export function clearCachedNicknames(userId) {
  if (!userId) return;
  try {
    removeItem(NICKNAMES_CACHE_PREFIX + userId);
  } catch {}
}

// ── Bubble colors (per-conversation, per-user) ──

const BUBBLE_CACHE_PREFIX = 'fc_bubble_cfg_';
const BUBBLE_CACHE_TTL = 1000 * 60 * 60 * 24; // 24h

/**
 * Get all bubble color settings for the current user.
 * Returns { [conversation_id]: { own: '#hex'|null, other: '#hex'|null } }
 */
export async function getBubbleColors(userId) {
  if (!userId) return {};
  const { data, error } = await supabase
    .from('chat_bubble_settings')
    .select('conversation_id, own_color, other_color')
    .eq('user_id', userId);
  if (error) {
    console.warn('[Chat] Error fetching bubble colors:', error);
    return {};
  }
  const map = {};
  (data || []).forEach((r) => {
    map[r.conversation_id] = { own: r.own_color || null, other: r.other_color || null };
  });
  return map;
}

/**
 * Set bubble colors for a conversation (upsert).
 * colors: { own: '#hex'|null, other: '#hex'|null } — null restores the default.
 */
export async function setBubbleColors(userId, conversationId, colors = {}) {
  if (!userId || !conversationId) return;
  const { error } = await supabase
    .from('chat_bubble_settings')
    .upsert(
      {
        user_id: userId,
        conversation_id: conversationId,
        own_color: colors.own || null,
        other_color: colors.other || null,
      },
      { onConflict: 'user_id,conversation_id' }
    );
  if (error) throw error;
}

/**
 * Cache the bubble colors map for a user in localStorage.
 */
export function cacheBubbleColors(userId, map) {
  if (!userId) return;
  try {
    setItem(BUBBLE_CACHE_PREFIX + userId, { ts: Date.now(), ttl: BUBBLE_CACHE_TTL, data: map });
  } catch {}
}

/**
 * Read cached bubble colors from localStorage.
 * Returns { [conversation_id]: { own, other } } or null if expired/missing.
 */
export function getCachedBubbleColors(userId) {
  if (!userId) return null;
  try {
    const p = getItem(BUBBLE_CACHE_PREFIX + userId);
    if (!p || !p.ts) return null;
    if (Date.now() - p.ts > (p.ttl || BUBBLE_CACHE_TTL)) {
      removeItem(BUBBLE_CACHE_PREFIX + userId);
      return null;
    }
    return p.data || null;
  } catch { return null; }
}

// ── Fondo del chat (per-conversation, per-user) ──
// Tabla chat_background_settings (migración 078). Es PRIVADO: las políticas RLS
// solo dejan leer/escribir las filas de auth.uid(), así que el otro
// participante nunca ve ni recibe el fondo del chat.

/**
 * Normaliza la URL de fondo. Acepta:
 *  - http(s) absoluta (imagen externa pegada por el usuario)
 *  - ruta del CDN propio (`/cdn/files/xxx`), que es lo que devuelve
 *    cdnService.uploadImage: mismo origen, sin esquema. ⚠️ Sin esta rama,
 *    `new URL('/cdn/files/x')` lanza y el fondo recién subido se BORRARÍA en
 *    vez de guardarse.
 * Rechaza `//host` (protocol-relative, se saltaría el https del sitio) y
 * cualquier otro esquema (javascript:, data:…). Devuelve null si no vale.
 */
export function normalizeBackgroundUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().slice(0, 2048);
  if (!raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Fondos de chat del usuario, listos para pintar.
 * @returns {Promise<Record<string, string>>} `{ [conversation_id]: url }`
 */
export async function getChatBackgrounds(userId) {
  if (!userId) return {};
  const { data, error } = await supabase
    .from('chat_background_settings')
    .select('conversation_id, image_url')
    .eq('user_id', userId);
  if (error) {
    console.warn('[Chat] Error fetching chat backgrounds:', error);
    return {};
  }
  const map = {};
  (data || []).forEach((row) => {
    if (row?.conversation_id && row?.image_url) map[row.conversation_id] = row.image_url;
  });
  return map;
}

/**
 * Guarda el fondo de una conversación (upsert).
 *
 * `imageUrl` vacío / null QUITA el fondo: se borra la fila en lugar de guardar
 * NULL, así no queda una fila muerta por cada conversación y la preferencia se
 * puede revertir al estado por defecto.
 *
 * @param {string} imageUrl - URL http(s) de la imagen, o '' / null para quitarlo
 * @returns {Promise<string|null>} la URL YA normalizada que quedó guardada (la
 *   que se usa luego como clave de caché del acento), o null si se quitó.
 */
export async function setChatBackground(userId, conversationId, imageUrl) {
  if (!userId || !conversationId) return null;

  const url = normalizeBackgroundUrl(imageUrl);
  if (!url) {
    const { error } = await supabase
      .from('chat_background_settings')
      .delete()
      .eq('user_id', userId)
      .eq('conversation_id', conversationId);
    if (error) throw error;
    return null;
  }

  const { error } = await supabase
    .from('chat_background_settings')
    .upsert(
      {
        user_id: userId,
        conversation_id: conversationId,
        image_url: url,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,conversation_id' }
    );
  if (error) throw error;
  return url;
}

/**
 * Fondo de un GRUPO: se guarda en la conversación, no en el usuario, así que lo
 * ven todos los miembros (migración 096). Cualquier miembro puede cambiarlo,
 * igual que el nombre o la imagen del grupo.
 *
 * @returns {Promise<string|null>} URL normalizada que quedó guardada (null si
 *   se quitó).
 */
export async function setGroupChatBackground(conversationId, userId, imageUrl) {
  if (!conversationId || !userId) return null;

  const url = normalizeBackgroundUrl(imageUrl);
  const { error } = await supabase
    .from('conversations')
    .update({
      chat_background_url: url,
      chat_background_by: url ? userId : null,
      chat_background_updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
  if (error) throw error;
  return url;
}

/**
 * Deja en el hilo un aviso de sistema («Ana cambió el fondo del grupo»).
 * El texto que viaja es solo un CÓDIGO (se traduce en el cliente con el nombre
 * del emisor); se cifra como cualquier mensaje para que `encrypted_for` siga
 * siendo la única puerta de lectura.
 */
export async function sendGroupBackgroundNotice(conversationId, senderId, participantIds = []) {
  if (!conversationId || !senderId) return;

  const allIds = [...new Set([senderId, ...participantIds.filter(Boolean)])];
  const { ciphertext, iv } = await encryptForUsers('background_changed', senderId, allIds);

  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_id: senderId,
    ciphertext,
    iv,
    encrypted_for: allIds,
    is_system: true,
  });
  if (error) throw error;
}

