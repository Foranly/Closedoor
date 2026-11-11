import { supabase, dbPublic } from './supabaseclient';
import { getCdnUrl } from './cdnService';
import { sanitizeContent } from './helpers';
import { createPost } from './postService';
import { getItem, setItem, removeItem } from './secureStorage';

// ── Constantes ──
export const MIN_FOLLOWERS_TO_CREATE = 100;
export const MAX_COMMUNITIES_PER_USER = 3;
export const COMMUNITY_NAME_MAX = 50;
export const COMMUNITY_DESC_MAX = 300;

// ── Cache localStorage (mismo patrón que perfiles/explore) ──
const COMM_LIST_PREFIX = 'fc_comm_list_';
const COMM_DETAIL_PREFIX = 'fc_comm_';
const COMM_CACHE_TTL = 1000 * 60 * 10; // 10 min

/** Cache del listado (por usuario + sort). Los contadores se refrescan con Realtime. */
export function getCachedCommunities(userId, sort) {
  try {
    const key = COMM_LIST_PREFIX + (userId || 'anon') + '_' + (sort || 'popular');
    const payload = getItem(key);
    if (!payload?.ts) return null;
    if (Date.now() - payload.ts > (payload.ttl || COMM_CACHE_TTL)) {
      removeItem(key);
      return null;
    }
    return payload.data || null;
  } catch {
    return null;
  }
}

export function setCachedCommunities(userId, sort, data) {
  if (!Array.isArray(data)) return;
  try {
    const key = COMM_LIST_PREFIX + (userId || 'anon') + '_' + (sort || 'popular');
    setItem(key, { ts: Date.now(), ttl: COMM_CACHE_TTL, data });
  } catch (err) {
    console.warn('Could not cache communities list:', err);
  }
}

/** Invalida el cache del listado del usuario (p. ej. tras crear una comunidad). */
export function clearCommunitiesListCache(userId) {
  try {
    ['popular', 'newest', 'active'].forEach((sort) => {
      removeItem(COMM_LIST_PREFIX + (userId || 'anon') + '_' + sort);
    });
  } catch {
    // Ignorar
  }
}

/** Cache del detalle de una comunidad (por slug). */
export function getCachedCommunity(slug) {
  if (!slug) return null;
  try {
    const payload = getItem(COMM_DETAIL_PREFIX + slug);
    if (!payload?.ts) return null;
    if (Date.now() - payload.ts > (payload.ttl || COMM_CACHE_TTL)) {
      removeItem(COMM_DETAIL_PREFIX + slug);
      return null;
    }
    return payload.data || null;
  } catch {
    return null;
  }
}

export function setCachedCommunity(slug, community) {
  if (!slug || !community) return;
  try {
    setItem(COMM_DETAIL_PREFIX + slug, { ts: Date.now(), ttl: COMM_CACHE_TTL, data: community });
  } catch (err) {
    console.warn('Could not cache community:', err);
  }
}

export function clearCommunityCache(slug) {
  if (!slug) return;
  try {
    removeItem(COMM_DETAIL_PREFIX + slug);
  } catch {
    // Ignorar
  }
}

// ── Cache de detalle extendido: miembros, roles y ranking (por communityId) ──
// Mismo patrón que el detalle: el detalle de la comunidad siembra la página al
// instante y estos 3 se refrescan en segundo plano con { refresh: true }.
const COMM_MEMBERS_PREFIX = 'fc_comm_members_';
const COMM_ROLES_PREFIX = 'fc_comm_roles_';
const COMM_RANKING_PREFIX = 'fc_comm_ranking_';

function readCachePayload(key) {
  const payload = getItem(key);
  if (!payload?.ts) return null;
  if (Date.now() - payload.ts > (payload.ttl || COMM_CACHE_TTL)) {
    removeItem(key);
    return null;
  }
  return payload.data || null;
}

export function getCachedCommunityMembers(communityId) {
  if (!communityId) return null;
  try { return readCachePayload(COMM_MEMBERS_PREFIX + communityId); } catch { return null; }
}

export function setCachedCommunityMembers(communityId, data) {
  if (!communityId || !Array.isArray(data)) return;
  try {
    setItem(COMM_MEMBERS_PREFIX + communityId, { ts: Date.now(), ttl: COMM_CACHE_TTL, data });
  } catch (err) {
    console.warn('Could not cache community members:', err);
  }
}

export function clearCommunityMembersCache(communityId) {
  if (!communityId) return;
  try { removeItem(COMM_MEMBERS_PREFIX + communityId); } catch { /* Ignorar */ }
}

export function getCachedCommunityRoles(communityId) {
  if (!communityId) return null;
  try { return readCachePayload(COMM_ROLES_PREFIX + communityId); } catch { return null; }
}

export function setCachedCommunityRoles(communityId, data) {
  if (!communityId || !Array.isArray(data)) return;
  try {
    setItem(COMM_ROLES_PREFIX + communityId, { ts: Date.now(), ttl: COMM_CACHE_TTL, data });
  } catch (err) {
    console.warn('Could not cache community roles:', err);
  }
}

export function clearCommunityRolesCache(communityId) {
  if (!communityId) return;
  try { removeItem(COMM_ROLES_PREFIX + communityId); } catch { /* Ignorar */ }
}

export function getCachedCommunityRanking(communityId) {
  if (!communityId) return null;
  try { return readCachePayload(COMM_RANKING_PREFIX + communityId); } catch { return null; }
}

export function setCachedCommunityRanking(communityId, data) {
  if (!communityId || !Array.isArray(data)) return;
  try {
    setItem(COMM_RANKING_PREFIX + communityId, { ts: Date.now(), ttl: COMM_CACHE_TTL, data });
  } catch (err) {
    console.warn('Could not cache community ranking:', err);
  }
}

export function clearCommunityRankingCache(communityId) {
  if (!communityId) return;
  try { removeItem(COMM_RANKING_PREFIX + communityId); } catch { /* Ignorar */ }
}

// ¿El usuario tiene rol admin? (bypass de followers y de límite)
export function isAdminRole(roles) {
  return Array.isArray(roles) && roles.includes('admin');
}

// ── Privacidad de las comunidades del perfil (migración 088) ──
const COMMUNITIES_VISIBILITY = ['nobody', 'following', 'everyone'];

/** Ajuste de visibilidad con el valor por defecto aplicado a filas antiguas. */
export function getCommunitiesVisibility(profile) {
  const value = profile?.communities_visibility;
  return COMMUNITIES_VISIBILITY.includes(value) ? value : 'following';
}

/**
 * ¿Puede este visitante ver la pestaña de comunidades del perfil?
 * @param {object} params
 * @param {object} params.profile - Fila del dueño (communities_visibility).
 * @param {boolean} params.isOwnProfile
 * @param {boolean|null} params.ownerFollowsViewer - null = todavía no se sabe.
 */
export function canViewProfileCommunities({ profile, isOwnProfile, ownerFollowsViewer }) {
  if (isOwnProfile) return true;
  const visibility = getCommunitiesVisibility(profile);
  if (visibility === 'everyone') return true;
  if (visibility === 'nobody') return false;
  return ownerFollowsViewer === true;
}

const COMMUNITY_SELECT = [
  'id', 'slug', 'name', 'description', 'rules', 'interests',
  'avatar_url', 'banner_url', 'accent_color', 'accent_color_secondary',
  'is_private', 'is_mature', 'owner_id', 'member_count', 'post_count', 'created_at', 'updated_at',
  'profiles!communities_owner_id_fkey (id, username, displayname, avatar_url, roles)',
].join(',');

const MEMBER_SELECT = [
  'id', 'community_id', 'user_id', 'role', 'status', 'joined_at',
  'profiles!community_members_user_id_fkey (id, username, displayname, avatar_url, banner_url, bio, roles, is_private, accent_color, user_status, user_status_updated_at)',
].join(',');

function normalizeCommunityUrls(c) {
  if (!c) return c;
  if (c.avatar_url) c.avatar_url = getCdnUrl(c.avatar_url);
  if (c.banner_url) c.banner_url = getCdnUrl(c.banner_url);
  if (c.profiles?.avatar_url) c.profiles.avatar_url = getCdnUrl(c.profiles.avatar_url);
  return c;
}

function normalizeMemberUrls(m) {
  if (!m) return m;
  if (m.profiles?.avatar_url) m.profiles.avatar_url = getCdnUrl(m.profiles.avatar_url);
  if (m.profiles?.banner_url) m.profiles.banner_url = getCdnUrl(m.profiles.banner_url);
  return m;
}

// ── Slug ──
/**
 * Genera el slug (sintaxis c/slug) a partir del nombre.
 * Lowercase, sin acentos, espacios → '-', elimina caracteres no alfanuméricos.
 */
export function slugifyName(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quitar acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  // Alfabetos no latinos (ja/ru): slug vacío → fallback determinista
  if (!base) {
    let h = 0;
    for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
    return `c-${h.toString(36)}`;
  }
  return base;
}

// ── Validación de seguidores (mínimo para crear) ──
export async function getFollowerCountFor(userId) {
  if (!userId) return 0;
  const { count, error } = await supabase
    .from('follows')
    .select('follower_id', { count: 'exact', head: true })
    .eq('following_id', userId)
    .eq('status', 'accepted');
  if (error) {
    console.warn('[Communities] Error counting followers:', error);
    return 0;
  }
  return count || 0;
}

const COMMUNITY_CARD_SELECT = [
  'id', 'slug', 'name', 'description', 'interests',
  'avatar_url', 'banner_url', 'accent_color', 'accent_color_secondary',
  'is_private', 'is_mature', 'member_count', 'post_count',
].join(',');

/**
 * Comunidades activas a las que pertenece un usuario, de la más reciente a la
 * más antigua. RLS (058) filtra: un visitante solo recibe membresías de
 * comunidades públicas; el propio usuario recibe también las privadas.
 */
export async function getUserCommunities(userId, { limit = 60 } = {}) {
  if (!userId) return [];
  const { data, error } = await dbPublic
    .from('community_members')
    .select(`community_id, role, joined_at, communities (${COMMUNITY_CARD_SELECT})`)
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('joined_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[Communities] Error fetching user communities:', error);
    return [];
  }
  return (data || [])
    .map((row) => normalizeCommunityUrls(row.communities))
    .filter(Boolean);
}

// ¿Cuántas comunidades ha creado el usuario (como owner)?
export async function countUserCommunities(userId) {
  if (!userId) return 0;
  const { count, error } = await dbPublic
    .from('communities')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId);
  if (error) {
    console.warn('[Communities] Error counting owned communities:', error);
    return 0;
  }
  return count || 0;
}

/**
 * ¿Puede el usuario crear una comunidad?
 * - Admin (roles incluye 'admin'): SIEMPRE puede (sin followers ni límite).
 * - Usuarios normales: 100+ followers Y menos de MAX_COMMUNITIES_PER_USER
 *   comunidades propias.
 */
export async function canCreateCommunity(userId, { roles = [] } = {}) {
  const isAdmin = isAdminRole(roles);
  const followers = isAdmin ? null : await getFollowerCountFor(userId);
  const ownedCount = isAdmin ? null : await countUserCommunities(userId);
  const limitReached = !isAdmin && ownedCount >= MAX_COMMUNITIES_PER_USER;
  const allowed = isAdmin || (followers >= MIN_FOLLOWERS_TO_CREATE && !limitReached);
  return { allowed, followers, isAdmin, ownedCount, limitReached, limit: MAX_COMMUNITIES_PER_USER };
}

// ── Crear comunidad ──
export async function createCommunity({ userId, name, description, rules, interests, avatarUrl, bannerUrl, accentColor, accentColorSecondary, isPrivate, isMature }) {
  if (!userId) throw new Error('auth_required');
  const cleanName = String(name || '').trim();
  if (cleanName.length < 3 || cleanName.length > COMMUNITY_NAME_MAX) {
    throw new Error(`El nombre debe tener entre 3 y ${COMMUNITY_NAME_MAX} caracteres`);
  }

  // Los roles se leen de la DB (no se confía en el cliente): un admin puede
  // crear sin followers ni límite; los usuarios normales necesitan 100+
  // followers Y < MAX_COMMUNITIES_PER_USER. La migración 059 exige lo mismo
  // a nivel de policy INSERT — defensa en profundidad.
  const { data: profile } = await dbPublic
    .from('profiles')
    .select('roles')
    .eq('id', userId)
    .maybeSingle();
  const isAdmin = isAdminRole(profile?.roles);
  if (!isAdmin) {
    const followers = await getFollowerCountFor(userId);
    if (followers < MIN_FOLLOWERS_TO_CREATE) {
      throw new Error(`Necesitas al menos ${MIN_FOLLOWERS_TO_CREATE} seguidores para crear una comunidad (tienes ${followers})`);
    }
    const ownedCount = await countUserCommunities(userId);
    if (ownedCount >= MAX_COMMUNITIES_PER_USER) {
      throw new Error(`Has alcanzado el límite de ${MAX_COMMUNITIES_PER_USER} comunidades`);
    }
  }

  const slug = slugifyName(cleanName);
  if (!slug) throw new Error('Nombre inválido');

  // Validar slug único (re-intento con sufijo -2, -3… si está tomado)
  let finalSlug = slug;
  let attempt = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: existing } = await dbPublic
      .from('communities')
      .select('id')
      .eq('slug', finalSlug)
      .maybeSingle();
    if (!existing) break;
    finalSlug = `${slug}-${attempt}`;
    attempt += 1;
    if (attempt > 20) throw new Error('No se pudo generar un slug único');
  }

  // Generar id antes para insertar el owner como miembro (evitar RLS de SELECT)
  const communityId = crypto.randomUUID();

  const { data: community, error } = await supabase
    .from('communities')
    .insert({
      id: communityId,
      slug: finalSlug,
      name: cleanName,
      description: description ? sanitizeContent(description).slice(0, COMMUNITY_DESC_MAX) : null,
      rules: Array.isArray(rules) ? rules.filter(Boolean).slice(0, 20) : [],
      interests: Array.isArray(interests) ? interests.slice(0, 20) : [],
      avatar_url: avatarUrl || null,
      banner_url: bannerUrl || null,
      accent_color: accentColor || null,
      accent_color_secondary: accentColorSecondary || null,
      is_private: !!isPrivate,
      is_mature: !!isMature,
      owner_id: userId,
    })
    .select(COMMUNITY_SELECT)
    .single();

  if (error) {
    console.error('[Communities] Error creating community:', error);
    throw error;
  }

  // El creador es proclamado dueño y líder principal
  const { error: memberError } = await supabase
    .from('community_members')
    .insert({
      community_id: communityId,
      user_id: userId,
      role: 'owner',
      status: 'active',
    });
  if (memberError) {
    console.error('[Communities] Error adding owner as member:', memberError);
    // No romper la creación: el owner se re-sincroniza al consultar
  }

  // Invalidar el cache del listado para que la nueva comunidad aparezca
  clearCommunitiesListCache(userId);
  return normalizeCommunityUrls(community);
}

// ── Consultar comunidad (cache-first: devuelve la cache si es válida y
//    refresca en segundo plano si se pide con { refresh: true }) ──
export async function getCommunity(slug, { refresh = false } = {}) {
  if (!refresh) {
    const cached = getCachedCommunity(slug);
    if (cached) return cached;
  }
  const { data, error } = await dbPublic
    .from('communities')
    .select(COMMUNITY_SELECT)
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    console.error('[Communities] Error fetching community:', error);
    throw error;
  }
  const normalized = normalizeCommunityUrls(data);
  if (normalized) setCachedCommunity(slug, normalized);
  return normalized;
}

export async function getCommunityById(id) {
  const { data, error } = await dbPublic
    .from('communities')
    .select(COMMUNITY_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('[Communities] Error fetching community by id:', error);
    throw error;
  }
  const normalized = normalizeCommunityUrls(data);
  if (normalized) setCachedCommunity(normalized.slug, normalized);
  return normalized;
}

export async function isCommunitySlugAvailable(slug) {
  const s = slugifyName(slug);
  if (!s) return { available: false, slug: s };
  const { data } = await dbPublic
    .from('communities')
    .select('id')
    .eq('slug', s)
    .maybeSingle();
  return { available: !data, slug: s };
}

// ── Listado / búsqueda ──
// sort: 'popular' (member_count) | 'newest' (created_at) | 'active' (post_count)
export async function getCommunities({ search = '', sort = 'popular', limit = 30, offset = 0, userId = null, refresh = false } = {}) {
  // Cache-first: solo para el listado por defecto sin búsqueda ni paginación
  // (igual que el detalle). El componente siembra el estado con la misma cache,
  // así que refresh:true fuerza el fetch aquí y re-cachea después.
  if (!refresh && !search.trim() && offset === 0) {
    const cached = getCachedCommunities(userId, sort);
    if (cached) return cached;
  }
  const orderMap = {
    popular: ['member_count', false],
    newest: ['created_at', false],
    active: ['post_count', false],
  };
  const [orderCol, orderAsc] = orderMap[sort] || orderMap.popular;

  let query = dbPublic
    .from('communities')
    .select(COMMUNITY_SELECT)
    .order(orderCol, { ascending: orderAsc })
    .range(offset, offset + limit - 1);

  if (search.trim()) {
    query = query.ilike('name', `%${search.trim()}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[Communities] Error listing communities:', error);
    throw error;
  }
  const normalized = (data || []).map(normalizeCommunityUrls);
  // Cachear listados SIN búsqueda (los buscados son volátiles); así el
  // listado vuelve al instante y Realtime refresca los contadores.
  if (!search.trim()) setCachedCommunities(userId, sort, normalized);
  return normalized;
}

// ── Membresía ──
/**
 * Estado del usuario actual en la comunidad.
 * Devuelve null si no tiene fila, o { role, status, joined_at }.
 */
export async function getMyMembership(communityId, userId) {
  if (!communityId || !userId) return null;
  const { data, error } = await supabase
    .from('community_members')
    .select('role, status, joined_at')
    .eq('community_id', communityId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[Communities] Error fetching membership:', error);
    return null;
  }
  return data || null;
}

/**
 * Unirse a una comunidad.
 * - Públicas: membresía active directa.
 * - Privadas: crea solicitud pending (se acepta/deniega desde moderación).
 */
export async function joinCommunity(communityId, userId) {
  if (!communityId || !userId) throw new Error('auth_required');

  const community = await getCommunityById(communityId);
  if (!community) throw new Error('community_not_found');

  // Si es privada y el owner es el solicitante, unirse directo (caso raro)
  const isOwner = community.owner_id === userId;

  const status = community.is_private && !isOwner ? 'pending' : 'active';
  const role = isOwner ? 'owner' : 'member';

  // delete + insert en vez de upsert: la política UPDATE de community_members
  // solo permite a moderadores, así que un upsert sobre una fila existente
  // (ej. solicitud pending previa) fallaría por RLS.
  const { error: delError } = await supabase
    .from('community_members')
    .delete()
    .eq('community_id', communityId)
    .eq('user_id', userId);
  if (delError) {
    console.error('[Communities] Error clearing previous membership:', delError);
  }

  const { data, error } = await supabase
    .from('community_members')
    .insert({
      community_id: communityId,
      user_id: userId,
      role,
      status,
      joined_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error('[Communities] Error joining community:', error);
    throw error;
  }
  clearCommunityMembersCache(communityId);
  return { ...data, isPending: status === 'pending' };
}

export async function leaveCommunity(communityId, userId) {
  if (!communityId || !userId) return;
  const { error } = await supabase
    .from('community_members')
    .delete()
    .eq('community_id', communityId)
    .eq('user_id', userId);
  if (error) {
    console.error('[Communities] Error leaving community:', error);
    throw error;
  }
  clearCommunityMembersCache(communityId);
}

// ── Solicitudes de unión (comunidades privadas) ──
export async function getJoinRequests(communityId) {
  const { data, error } = await supabase
    .from('community_members')
    .select(MEMBER_SELECT)
    .eq('community_id', communityId)
    .eq('status', 'pending')
    .order('joined_at', { ascending: false });

  if (error) {
    console.error('[Communities] Error fetching join requests:', error);
    throw error;
  }
  return (data || []).map(normalizeMemberUrls);
}

/**
 * Aceptar (→ active, rol member) o denegar (→ delete) una solicitud.
 * Solo moderadores con permiso manage_requests (por RLS).
 */
export async function respondJoinRequest(communityId, userId, { approve }) {
  if (approve) {
    const { error } = await supabase
      .from('community_members')
      .update({ status: 'active', role: 'member', joined_at: new Date().toISOString() })
      .eq('community_id', communityId)
      .eq('user_id', userId)
      .eq('status', 'pending');
    if (error) {
      console.error('[Communities] Error approving request:', error);
      throw error;
    }
    clearCommunityMembersCache(communityId);
  } else {
    const { error } = await supabase
      .from('community_members')
      .delete()
      .eq('community_id', communityId)
      .eq('user_id', userId)
      .eq('status', 'pending');
    if (error) {
      console.error('[Communities] Error rejecting request:', error);
      throw error;
    }
  }
}

// ── Miembros ──
export async function getCommunityMembers(communityId, { limit = 100, status = 'active', refresh = false } = {}) {
  // Cache-first solo para la vista activa por defecto (la lista del detalle).
  // Las solicitudes pending son de moderación y no se cachean.
  if (!refresh && status === 'active' && limit >= 100) {
    const cached = getCachedCommunityMembers(communityId);
    if (cached) return cached;
  }
  const { data, error } = await supabase
    .from('community_members')
    .select(MEMBER_SELECT)
    .eq('community_id', communityId)
    .eq('status', status)
    .order('joined_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[Communities] Error fetching members:', error);
    throw error;
  }
  const normalized = (data || []).map(normalizeMemberUrls);
  if (status === 'active') setCachedCommunityMembers(communityId, normalized);
  return normalized;
}

/**
 * Cambiar el rol de un miembro (owner/admin con manage_members).
 * Para roles custom: el nombre debe existir en community_roles.
 */
export async function setMemberRole(communityId, targetUserId, role) {
  const { error } = await supabase
    .from('community_members')
    .update({ role })
    .eq('community_id', communityId)
    .eq('user_id', targetUserId);
  if (error) {
    console.error('[Communities] Error setting member role:', error);
    throw error;
  }
  clearCommunityMembersCache(communityId);
}

export async function removeMember(communityId, targetUserId) {
  const { error } = await supabase
    .from('community_members')
    .delete()
    .eq('community_id', communityId)
    .eq('user_id', targetUserId);
  if (error) {
    console.error('[Communities] Error removing member:', error);
    throw error;
  }
  clearCommunityMembersCache(communityId);
}

// ── Roles custom ──
export async function getCommunityRoles(communityId, { refresh = false } = {}) {
  if (!refresh) {
    const cached = getCachedCommunityRoles(communityId);
    if (cached) return cached;
  }
  const { data, error } = await supabase
    .from('community_roles')
    .select('id, community_id, name, color, permissions, created_at')
    .eq('community_id', communityId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[Communities] Error fetching roles:', error);
    throw error;
  }
  const roles = data || [];
  setCachedCommunityRoles(communityId, roles);
  return roles;
}

export async function createCommunityRole(communityId, { name, color, permissions }) {
  const { data, error } = await supabase
    .from('community_roles')
    .insert({
      community_id: communityId,
      name: String(name || '').trim().slice(0, 30),
      color: color || null,
      permissions: Array.isArray(permissions) ? permissions : [],
    })
    .select()
    .single();
  if (error) {
    console.error('[Communities] Error creating role:', error);
    throw error;
  }
  clearCommunityRolesCache(communityId);
  return data;
}

export async function deleteCommunityRole(communityId, roleId, roleName) {
  const { error } = await supabase
    .from('community_roles')
    .delete()
    .eq('id', roleId)
    .eq('community_id', communityId);
  if (error) {
    console.error('[Communities] Error deleting role:', error);
    throw error;
  }
  clearCommunityRolesCache(communityId);
  clearCommunityMembersCache(communityId);
  // Los miembros con ese rol vuelven a 'member'
  if (roleName) {
    const { error: resetError } = await supabase
      .from('community_members')
      .update({ role: 'member' })
      .eq('community_id', communityId)
      .eq('role', roleName);
    if (resetError) console.warn('[Communities] Error resetting members role:', resetError);
  }
}

// ── Invitaciones ──
/**
 * Crear (u obtener) la invitación personal del usuario en una comunidad.
 * Regla: 1 invitación activa por usuario y comunidad, sin importar el rol
 * (índice único idx_community_invites_one_per_user). Si ya tiene una se
 * devuelve la existente; borrarla permite regenerarla.
 */
export async function createInvite(communityId, userId, { expiresAt = null, maxUses = null } = {}) {
  const INVITE_COLS = 'id, community_id, token, created_by, created_at, expires_at, max_uses, uses';

  // ¿Ya tiene invitación? → devolverla en lugar de fallar por unique violation
  const { data: existing } = await supabase
    .from('community_invites')
    .select(INVITE_COLS)
    .eq('community_id', communityId)
    .eq('created_by', userId)
    .maybeSingle();
  if (existing) return existing;

  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const { data, error } = await supabase
    .from('community_invites')
    .insert({
      community_id: communityId,
      token,
      created_by: userId,
      expires_at: expiresAt,
      max_uses: maxUses,
    })
    .select()
    .single();

  if (error) {
    // Carrera entre pestañas/dispositivos: otra petición la creó primero
    const { data: race } = await supabase
      .from('community_invites')
      .select(INVITE_COLS)
      .eq('community_id', communityId)
      .eq('created_by', userId)
      .maybeSingle();
    if (race) return race;
    console.error('[Communities] Error creating invite:', error);
    throw error;
  }
  return data;
}

export async function getCommunityInvites(communityId) {
  const { data, error } = await supabase
    .from('community_invites')
    .select('id, community_id, token, created_by, created_at, expires_at, max_uses, uses')
    .eq('community_id', communityId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[Communities] Error fetching invites:', error);
    throw error;
  }
  return data || [];
}

export async function deleteInvite(inviteId) {
  const { error } = await supabase
    .from('community_invites')
    .delete()
    .eq('id', inviteId);
  if (error) throw error;
}

/**
 * Canjear un token de invitación: une al usuario a la comunidad
 * (privada o pública) sin pasar por solicitud.
 */
export async function redeemInvite(token, userId) {
  if (!token || !userId) throw new Error('auth_required');

  // Consultar el invite vía RPC SECURITY DEFINER (valida el token sin
  // exponer la tabla; la política RLS no permite SELECT directo por token)
  const { data: invite, error } = await supabase.rpc('get_community_invite_by_token', {
    invite_token: token,
  });

  if (error || !invite) throw new Error('invite_invalid');
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) throw new Error('invite_expired');
  if (invite.max_uses && invite.uses >= invite.max_uses) throw new Error('invite_used');

  // Unir como miembro activo (el token ya autoriza).
  // delete + insert: la política UPDATE de community_members solo permite a
  // moderadores, así que upsert fallaría por RLS si la fila ya existe.
  await supabase
    .from('community_members')
    .delete()
    .eq('community_id', invite.community_id)
    .eq('user_id', userId);
  const { data: membership } = await supabase
    .from('community_members')
    .insert({
      community_id: invite.community_id,
      user_id: userId,
      role: 'member',
      status: 'active',
      joined_at: new Date().toISOString(),
    })
    .select('role, status')
    .single();

  // Incrementar uso
  await supabase
    .from('community_invites')
    .update({ uses: invite.uses + 1 })
    .eq('id', invite.id);

  // El alta directa no pasa por joinCommunity → invalidar el cache de miembros
  clearCommunityMembersCache(invite.community_id);
  return { community_id: invite.community_id, role: membership?.role || 'member', status: membership?.status || 'active' };
}

// ── Actualizar comunidad (solo owner) ──
export async function updateCommunity(communityId, updates) {
  const safe = { ...updates };
  if (safe.description !== undefined) {
    safe.description = sanitizeContent(safe.description || '').slice(0, COMMUNITY_DESC_MAX);
  }
  if (Array.isArray(safe.rules)) safe.rules = safe.rules.filter(Boolean).slice(0, 20);
  if (Array.isArray(safe.interests)) safe.interests = safe.interests.slice(0, 20);

  const { data, error } = await supabase
    .from('communities')
    .update({ ...safe, updated_at: new Date().toISOString() })
    .eq('id', communityId)
    .select(COMMUNITY_SELECT)
    .single();

  if (error) {
    console.error('[Communities] Error updating community:', error);
    throw error;
  }
  const normalized = normalizeCommunityUrls(data);
  if (normalized) setCachedCommunity(normalized.slug, normalized);
  return normalized;
}

// ── Feed de la comunidad ──
/**
 * Sort options:
 *   'recent'    → created_at desc
 *   'relevance' → score de engagement compuesto (likes + comments*2 + reposts*3 + dislikes)
 *   'likes' | 'comments' | 'dislikes' | 'reposts' → contador desc
 * timeRange: 'all' | 'today' | 'week' | 'month'
 */
export async function getCommunityPosts(communityId, { sort = 'recent', timeRange = 'all', limit = 30, offset = 0 } = {}) {
  const feedSelect = [
    'id', 'user_id', 'content', 'image_url', 'image_urls', 'video_url',
    'is_pinned', 'pinned_at', 'is_encrypted', 'is_sensitive',
    'likes_count', 'dislikes_count', 'comments_count', 'reposts_count', 'views_count',
    'created_at', 'updated_at', 'mentions', 'obfuscated_display', 'comments_allowed', 'poll_data', 'song',
    'profiles!posts_user_id_fkey (id, username, displayname, avatar_url, roles, is_private, avatar_position)',
  ].join(',');

  let query = dbPublic
    .from('posts')
    .select(feedSelect)
    .eq('community_id', communityId)
    .or('scheduled_at.is.null,scheduled_at.lte.now');

  // Filtro por rango de fechas
  if (timeRange && timeRange !== 'all') {
    const now = new Date();
    const since = new Date(now);
    if (timeRange === 'today') since.setHours(0, 0, 0, 0);
    else if (timeRange === 'week') since.setDate(now.getDate() - 7);
    else if (timeRange === 'month') since.setMonth(now.getMonth() - 1);
    query = query.gte('created_at', since.toISOString());
  }

  // Orden
  switch (sort) {
    case 'likes':
      query = query.order('likes_count', { ascending: false });
      break;
    case 'comments':
      query = query.order('comments_count', { ascending: false });
      break;
    case 'dislikes':
      query = query.order('dislikes_count', { ascending: false });
      break;
    case 'reposts':
      query = query.order('reposts_count', { ascending: false });
      break;
    case 'relevance':
      // Compuesto: likes + comments*2 + reposts*3 + dislikes*0.5
      query = query.order('likes_count', { ascending: false })
        .order('comments_count', { ascending: false })
        .order('reposts_count', { ascending: false })
        .order('dislikes_count', { ascending: false })
        .order('created_at', { ascending: false });
      break;
    case 'recent':
    default:
      query = query.order('created_at', { ascending: false });
      break;
  }

  query = query.range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) {
    console.error('[Communities] Error fetching community posts:', error);
    throw error;
  }

  const posts = (data || []).map((p) => {
    if (p.image_url) p.image_url = getCdnUrl(p.image_url);
    if (Array.isArray(p.image_urls)) p.image_urls = p.image_urls.map((u) => getCdnUrl(u));
    if (p.video_url) p.video_url = getCdnUrl(p.video_url);
    if (p.profiles?.avatar_url) p.profiles.avatar_url = getCdnUrl(p.profiles.avatar_url);
    return p;
  });

  // En 'relevance', ordenar por score compuesto en cliente
  if (sort === 'relevance') {
    const score = (p) =>
      (p.likes_count || 0) +
      (p.comments_count || 0) * 2 +
      (p.reposts_count || 0) * 3 +
      (p.dislikes_count || 0) * 0.5;
    posts.sort((a, b) => score(b) - score(a) || new Date(b.created_at) - new Date(a.created_at));
  }

  return posts.filter((p) => !p.is_encrypted);
}

/**
 * Crear un post dentro de la comunidad.
 * Reusa createPost() y añade community_id.
 */
export async function createCommunityPost({ userId, communityId, content, imageUrl, imageUrls, imageMeta, videoUrl, pollData, isSensitive }) {
  if (!communityId || !userId) throw new Error('auth_required');
  return createPost({
    userId,
    content,
    imageUrl,
    imageUrls,
    imageMeta,
    videoUrl,
    pollData,
    isSensitive,
    communityId,
  });
}

// ── Borrado de posts (owner/moderadores por RLS) ──
export async function deleteCommunityPost(postId) {
  // RLS permite borrar si auth.uid() es autor o moderador de la comunidad
  const { data, error } = await supabase
    .from('posts')
    .delete()
    .eq('id', postId)
    .select('id');
  if (error) {
    console.error('[Communities] Error deleting community post:', error);
    throw error;
  }
  if (!data || data.length === 0) {
    const err = new Error('No tienes permisos para borrar este post');
    throw err;
  }
}

// ── Ranking de miembros más activos (sidebar) ──
/**
 * Cuenta posts, likes recibidos, comentarios recibidos y reposts recibidos
 * por miembro dentro de la comunidad, y devuelve un ranking.
 * Se calcula sobre los posts de la comunidad (denormalizado en posts).
 */
export async function getActiveMembersRanking(communityId, { limit = 10, refresh = false } = {}) {
  if (!refresh && limit >= 10) {
    const cached = getCachedCommunityRanking(communityId);
    if (cached) return cached;
  }
  // Agrupar posts por autor dentro de la comunidad
  const { data: posts, error } = await dbPublic
    .from('posts')
    .select('user_id, likes_count, comments_count, reposts_count, views_count')
    .eq('community_id', communityId)
    .not('is_encrypted', 'is', true)
    .limit(200);

  if (error) {
    console.error('[Communities] Error fetching ranking data:', error);
    throw error;
  }

  const byUser = new Map();
  for (const p of posts || []) {
    if (!p.user_id) continue;
    const cur = byUser.get(p.user_id) || { posts: 0, likes: 0, comments: 0, reposts: 0, views: 0 };
    cur.posts += 1;
    cur.likes += p.likes_count || 0;
    cur.comments += p.comments_count || 0;
    cur.reposts += p.reposts_count || 0;
    cur.views += p.views_count || 0;
    byUser.set(p.user_id, cur);
  }

  const rows = [...byUser.entries()]
    .map(([userId, stats]) => ({
      user_id: userId,
      ...stats,
      // Score de actividad: cada post pesa, likes*2, comments*3, reposts*4
      score: stats.posts * 5 + stats.likes * 2 + stats.comments * 3 + stats.reposts * 4,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (rows.length === 0) {
    setCachedCommunityRanking(communityId, []);
    return [];
  }

  // Fetch perfiles en batch
  const userIds = rows.map((r) => r.user_id);
  const { data: profiles } = await dbPublic
    .from('profiles')
    .select('id, username, displayname, avatar_url, roles, accent_color, user_status')
    .in('id', userIds);

  const profileMap = {};
  for (const p of profiles || []) {
    if (p.avatar_url) p.avatar_url = getCdnUrl(p.avatar_url);
    profileMap[p.id] = p;
  }

  const result = rows.map((r) => ({ ...r, profile: profileMap[r.user_id] || null }));
  setCachedCommunityRanking(communityId, result);
  return result;
}
