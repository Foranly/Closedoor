import { supabase } from './supabaseclient';
import { getItem, setItem, removeItem } from './secureStorage';
import { clearVisibleIdsCache } from './postService';

/**
 * Follow a user and create a notification for them
 */
export async function followUser(followerId, followingId) {
  if (followerId === followingId) {
    throw new Error('No puedes seguirte a ti mismo');
  }

  const { data, error } = await supabase
    .from('follows')
    .insert({
      follower_id: followerId,
      following_id: followingId,
      status: 'accepted',
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error('Ya sigues a este usuario');
    }
    console.error('Error following user:', error);
    throw error;
  }

  // Update cache
  setCachedFollowStatus(followerId, followingId, true);
  clearVisibleIdsCache(followerId);

  // Create a notification for the followed user
  const { error: notifError } = await supabase
    .from('notifications')
    .insert({
      user_id: followingId,
      actor_id: followerId,
      type: 'follow',
      is_read: false,
    });

  if (notifError) {
    console.error('Error creating follow notification:', notifError);
  }

  return data;
}

/**
 * Send a follow request to a private profile
 */
export async function requestFollow(followerId, followingId) {
  if (followerId === followingId) {
    throw new Error('No puedes seguirte a ti mismo');
  }

  const { data, error } = await supabase
    .from('follows')
    .insert({
      follower_id: followerId,
      following_id: followingId,
      status: 'pending',
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error('Ya enviaste una solicitud a este usuario');
    }
    console.error('Error sending follow request:', error);
    throw error;
  }

  // Create a follow_request notification for the profile owner
  const { error: notifError } = await supabase
    .from('notifications')
    .insert({
      user_id: followingId,
      actor_id: followerId,
      type: 'follow_request',
      is_read: false,
    });

  if (notifError) {
    console.error('Error creating follow request notification:', notifError);
  }

  return data;
}

/**
 * Accept a follow request (from private profile owner)
 * La RLS (107) solo permite aceptar con un UPDATE del dueño del perfil: así
 * no se puede fabricar un follow 'accepted' desde la cuenta del solicitante.
 */
export async function acceptFollowRequest(requesterId, targetId) {
  const { data, error: insError } = await supabase
    .from('follows')
    .update({ status: 'accepted' })
    .eq('follower_id', requesterId)
    .eq('following_id', targetId)
    .eq('status', 'pending')
    .select()
    .single();

  if (insError) {
    console.error('Error accepting follow request:', insError);
    throw insError;
  }

  setCachedFollowStatus(requesterId, targetId, true);
  clearVisibleIdsCache(requesterId);
  clearVisibleIdsCache(targetId);

  // Notify the requester that their request was accepted
  const { error: notifError } = await supabase
    .from('notifications')
    .insert({
      user_id: requesterId,
      actor_id: targetId,
      type: 'follow_request_accepted',
      is_read: false,
    });

  if (notifError) {
    console.error('Error creating accepted notification — posible problema de RLS:', notifError);
  }

  return data;
}

/**
 * Reject a follow request (from private profile owner)
 */
export async function rejectFollowRequest(requesterId, targetId) {
  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_id', requesterId)
    .eq('following_id', targetId)
    .eq('status', 'pending');

  if (error) {
    console.error('Error rejecting follow request:', error);
    throw error;
  }

  // Notify the requester that their request was rejected
  const { error: notifError } = await supabase
    .from('notifications')
    .insert({
      user_id: requesterId,
      actor_id: targetId,
      type: 'follow_request_rejected',
      is_read: false,
    });

  if (notifError) {
    console.error('Error creating rejected notification — posible problema de RLS:', notifError);
  }
}

/**
 * Check if there's a pending follow request
 */
export async function hasPendingRequest(followerId, followingId) {
  const { data, error } = await supabase
    .from('follows')
    .select('follower_id')
    .eq('follower_id', followerId)
    .eq('following_id', followingId)
    .eq('status', 'pending')
    .maybeSingle();

  if (error) {
    console.error('Error checking pending request:', error);
    throw error;
  }

  return !!data;
}

/**
 * Cancel a pending follow request
 */
export async function cancelFollowRequest(followerId, followingId) {
  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_id', followerId)
    .eq('following_id', followingId)
    .eq('status', 'pending');

  if (error) {
    console.error('Error cancelling follow request:', error);
    throw error;
  }
}

/**
 * Unfollow a user
 */
export async function unfollowUser(followerId, followingId) {
  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_id', followerId)
    .eq('following_id', followingId);

  if (error) {
    console.error('Error unfollowing user:', error);
    throw error;
  }

  // Update cache
  setCachedFollowStatus(followerId, followingId, false);
  clearVisibleIdsCache(followerId);
}

/**
 * Check if followerId follows followingId (usa cache)
 */
export async function isFollowing(followerId, followingId) {
  const { data, error } = await supabase
    .from('follows')
    .select('follower_id')
    .eq('follower_id', followerId)
    .eq('following_id', followingId)
    .eq('status', 'accepted')
    .maybeSingle();

  if (error) {
    console.error('Error checking follow status:', error);
    throw error;
  }

  const status = !!data;
  // Actualizar cache con resultado fresco
  setCachedFollowStatus(followerId, followingId, status);
  return status;
}

/**
 * Get followers of a user (profiles that follow them)
 */
export async function getFollowers(userId) {
  const { data, error } = await supabase
    .from('follows')
    .select(`
      follower_id,
      created_at,
      profiles!follows_follower_id_fkey (
        id,
        username,
        avatar_url,
        avatar_frame_url,
        avatar_frame_position,
        roles
      )
    `)
    .eq('following_id', userId)
    .eq('status', 'accepted')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching followers:', error);
    throw error;
  }

  return data.map((item) => ({
    ...item.profiles,
    followed_since: item.created_at,
  }));
}

/**
 * Get users that a user is following
 */
export async function getFollowing(userId) {
  const { data, error } = await supabase
    .from('follows')
    .select(`
      following_id,
      created_at,
      profiles!follows_following_id_fkey (
        id,
        username,
        avatar_url,
        avatar_frame_url,
        avatar_frame_position,
        roles
      )
    `)
    .eq('follower_id', userId)
    .eq('status', 'accepted')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching following:', error);
    throw error;
  }

  return data.map((item) => ({
    ...item.profiles,
    followed_since: item.created_at,
  }));
}

/**
 * Get follower counts for many users in one batch.
 * Returns a map: { [userId]: followerCount }
 */
export async function getFollowersCounts(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0) return {};

  const countPromises = ids.map(async (uid) => {
    const { count } = await supabase
      .from('follows')
      .select('follower_id', { count: 'exact', head: true })
      .eq('following_id', uid)
      .eq('status', 'accepted');
    return { id: uid, followers: count || 0 };
  });
  const countResults = await Promise.all(countPromises);

  const map = {};
  for (const r of countResults) {
    map[r.id] = r.followers;
  }
  return map;
}

/**
 * Get follow counts for a user
 */
export async function getFollowCounts(userId) {
  const [followersResult, followingResult] = await Promise.all([
    supabase
      .from('follows')
      .select('follower_id', { count: 'exact', head: true })
      .eq('following_id', userId)
      .eq('status', 'accepted'),
    supabase
      .from('follows')
      .select('follower_id', { count: 'exact', head: true })
      .eq('follower_id', userId)
      .eq('status', 'accepted'),
  ]);

  const counts = {
    followers: followersResult.count ?? 0,
    following: followingResult.count ?? 0,
  };

  return counts;
}

// ── localStorage cache for explore data (profiles + counts) ──
const EXPLORE_CACHE_PREFIX = 'fc_explore_';
const EXPLORE_CACHE_TTL = 1000 * 60 * 10; // 10 min

export function setCachedExploreData(userId, data) {
  if (!data) return;
  try {
    const key = EXPLORE_CACHE_PREFIX + (userId || 'anon');
    const payload = { ts: Date.now(), ttl: EXPLORE_CACHE_TTL, data };
    setItem(key, payload);
  } catch (err) {
    console.warn('Could not cache explore data:', err);
  }
}

export function getCachedExploreData(userId) {
  try {
    const key = EXPLORE_CACHE_PREFIX + (userId || 'anon');
    const payload = getItem(key);
    if (!payload || !payload.ts) return null;
    if (Date.now() - payload.ts > (payload.ttl || EXPLORE_CACHE_TTL)) {
      removeItem(key);
      return null;
    }
    return payload.data || null;
  } catch (err) {
    console.warn('Could not read explore cache:', err);
    return null;
  }
}

// ── localStorage cache for follow status (isFollowing) ──
const FOLLOW_STATUS_PREFIX = 'fc_fs_';
const FOLLOW_STATUS_TTL = 1000 * 60 * 60; // 1 hour (misma duración que cache de perfil)

export function setCachedFollowStatus(followerId, targetId, status) {
  if (!followerId || !targetId) return;
  try {
    const key = `${FOLLOW_STATUS_PREFIX}${followerId}_${targetId}`;
    const payload = { ts: Date.now(), ttl: FOLLOW_STATUS_TTL, status };
    setItem(key, payload);
  } catch (err) {
    console.warn('Could not cache follow status:', err);
  }
}

export function getCachedFollowStatus(followerId, targetId) {
  if (!followerId || !targetId) return null;
  try {
    const key = `${FOLLOW_STATUS_PREFIX}${followerId}_${targetId}`;
    const payload = getItem(key);
    if (!payload || !payload.ts) return null;
    if (Date.now() - payload.ts > (payload.ttl || FOLLOW_STATUS_TTL)) {
      removeItem(key);
      return null;
    }
    return payload.status;
  } catch (err) {
    console.warn('Could not read cached follow status:', err);
    return null;
  }
}

// ── localStorage cache for follow counts ──
const COUNTS_CACHE_PREFIX = 'fc_counts_';
const COUNTS_CACHE_TTL = 1000 * 60 * 5; // 5 minutes

export function setCachedFollowCounts(userId, counts) {
  if (!userId || !counts) return;
  try {
    const payload = { ts: Date.now(), ttl: COUNTS_CACHE_TTL, counts };
    setItem(COUNTS_CACHE_PREFIX + userId, payload);
  } catch (err) {
    console.warn('Could not cache follow counts:', err);
  }
}

export function clearCachedFollowCounts(userId) {
  if (!userId) return;
  try {
    removeItem(COUNTS_CACHE_PREFIX + userId);
  } catch (err) {
    console.warn('Could not clear cached follow counts:', err);
  }
}

export function getCachedFollowCounts(userId) {
  if (!userId) return null;
  try {
    const payload = getItem(COUNTS_CACHE_PREFIX + userId);
    if (!payload || !payload.ts) return null;
    if (Date.now() - payload.ts > (payload.ttl || COUNTS_CACHE_TTL)) {
      removeItem(COUNTS_CACHE_PREFIX + userId);
      return null;
    }
    return payload.counts || null;
  } catch (err) {
    console.warn('Could not read cached follow counts:', err);
    return null;
  }
}

// ── localStorage cache for followers/following lists ──
const FOLLOWERS_LIST_PREFIX = 'fc_followers_list_';
const FOLLOWING_LIST_PREFIX = 'fc_following_list_';
const FOLLOW_LIST_TTL = 1000 * 60 * 5; // 5 minutes

export function setCachedFollowers(userId, data) {
  if (!userId) return;
  try {
    const payload = { ts: Date.now(), ttl: FOLLOW_LIST_TTL, data };
    setItem(FOLLOWERS_LIST_PREFIX + userId, payload);
  } catch (err) {
    console.warn('Could not cache followers list:', err);
  }
}

export function getCachedFollowers(userId) {
  if (!userId) return null;
  try {
    const payload = getItem(FOLLOWERS_LIST_PREFIX + userId);
    if (!payload || !payload.ts) return null;
    if (Date.now() - payload.ts > (payload.ttl || FOLLOW_LIST_TTL)) {
      removeItem(FOLLOWERS_LIST_PREFIX + userId);
      return null;
    }
    return payload.data || null;
  } catch (err) {
    console.warn('Could not read cached followers list:', err);
    return null;
  }
}

export function setCachedFollowing(userId, data) {
  if (!userId) return;
  try {
    const payload = { ts: Date.now(), ttl: FOLLOW_LIST_TTL, data };
    setItem(FOLLOWING_LIST_PREFIX + userId, payload);
  } catch (err) {
    console.warn('Could not cache following list:', err);
  }
}

export function getCachedFollowing(userId) {
  if (!userId) return null;
  try {
    const payload = getItem(FOLLOWING_LIST_PREFIX + userId);
    if (!payload || !payload.ts) return null;
    if (Date.now() - payload.ts > (payload.ttl || FOLLOW_LIST_TTL)) {
      removeItem(FOLLOWING_LIST_PREFIX + userId);
      return null;
    }
    return payload.data || null;
  } catch (err) {
    console.warn('Could not read cached following list:', err);
    return null;
  }
}
