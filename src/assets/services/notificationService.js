import { supabase } from './supabaseclient';
import { getItem, setItem, removeItem } from './secureStorage';

const NOTIF_CACHE_PREFIX = 'fc_notif_';
const NOTIF_CACHE_TTL = 1000 * 60 * 5; // 5 min

export function setCachedNotifications(userId, notifications) {
  if (!userId) return;
  try {
    const payload = {
      ts: Date.now(),
      ttl: NOTIF_CACHE_TTL,
      data: { notifications },
    };
    setItem(NOTIF_CACHE_PREFIX + userId, payload);
  } catch (err) {
    console.warn('Could not cache notifications:', err);
  }
}

export function getCachedNotifications(userId) {
  if (!userId) return null;
  try {
    const payload = getItem(NOTIF_CACHE_PREFIX + userId);
    if (!payload?.ts) return null;
    if (Date.now() - payload.ts > (payload.ttl || NOTIF_CACHE_TTL)) {
      removeItem(NOTIF_CACHE_PREFIX + userId);
      return null;
    }
    const notifs = payload.data?.notifications || [];
    return {
      notifications: notifs,
      unreadCount: notifs.filter((n) => !n.is_read).length,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Get notifications for a user, with actor profile + post reference data
 */
export async function getNotifications(userId, limit = 50) {
  const { data, error } = await supabase
    .from('notifications')
    .select(`
      *,
      actor:actor_id (
        id,
        username,
        avatar_url,
        avatar_frame_url,
        avatar_frame_position
      ),
      post:reference_id (
        id,
        content
      )
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching notifications:', error);
    throw error;
  }

  return data || [];
}

/**
 * Id del comentario al que apunta una notificación de comentario.
 *
 * Normalmente viene en `comment_id` (migración 106). Las notificaciones
 * antiguas anteriores a esa migración no lo tienen, así que se resuelve por el
 * comentario más reciente del actor en ese post: es el que disparó el aviso.
 * Devuelve null si no aplica o no se encuentra.
 */
export async function resolveNotificationCommentId(notification) {
  if (!notification) return null;
  if (notification.comment_id) return notification.comment_id;
  if (!['comment', 'comment_like', 'comment_reply', 'comment_mention'].includes(notification.type)) return null;
  const postId = notification.reference_id;
  const actorId = notification.actor_id || notification.actor?.id;
  if (!postId || !actorId) return null;

  const { data, error } = await supabase
    .from('comments')
    .select('id')
    .eq('post_id', postId)
    .eq('user_id', actorId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('Could not resolve notification comment id:', error.message || error);
    return null;
  }
  return data?.id || null;
}

/**
 * Get unread notification count
 */
export async function getUnreadCount(userId) {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) {
    console.error('Error counting unread notifications:', error);
    throw error;
  }

  return count ?? 0;
}

/**
 * Mark a single notification as read
 */
export async function markAsRead(notificationId) {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId);

  if (error) {
    console.error('Error marking notification as read:', error);
    throw error;
  }
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllAsRead(userId) {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) {
    console.error('Error marking all notifications as read:', error);
    throw error;
  }
}

/**
 * Delete a single notification by ID
 */
export async function deleteNotification(notificationId) {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('id', notificationId);

  if (error) {
    console.error('Error deleting notification:', error);
    throw error;
  }
}

/**
 * Delete multiple notifications by IDs
 */
export async function deleteNotifications(notificationIds) {
  if (!notificationIds || notificationIds.length === 0) return;

  const { error } = await supabase
    .from('notifications')
    .delete()
    .in('id', notificationIds);

  if (error) {
    console.error('Error deleting notifications:', error);
    throw error;
  }
}
