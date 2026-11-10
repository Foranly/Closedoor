import { supabase, dbPublic } from './supabaseclient';
import { getItem, setItem, removeItem } from './secureStorage';
import { getCdnUrl } from './cdnService';
import { sanitizeContent } from './helpers';

/**
 * Normaliza TODAS las URLs del CDN en un objeto profile para garantizar
 * que sean rutas relativas (/cdn/files/xxx) y nunca HTTP directo.
 * Se aplica en cada respuesta de Supabase para eliminar Mixed Content de raíz.
 *
 * ⚠️ Usa getCdnUrl() en vez de normalizeCdnUrl() para NO romper URLs externas
 *    (getCdnUrl solo modifica URLs que empiezan con /cdn/).
 */
function normalizeProfileUrls(profile) {
  if (!profile) return profile;
  const fields = ['avatar_url', 'banner_url', 'profile_background_url'];
  for (const field of fields) {
    if (profile[field]) {
      profile[field] = getCdnUrl(profile[field]);
    }
  }
  return profile;
}

// ── Columnas públicas de profiles (SIN email) ──
// La columna email está REVOCADA para anon/authenticated (migración 053);
// cualquier SELECT que la incluya (p. ej. select('*') sobre la tabla)
// fallaría con permission denied. Esta lista explícita cubre todo lo que
// la UI lee de un perfil. El email propio se obtiene de auth.users
// (user?.email), nunca de la tabla.
// Lista verificada contra las 53 columnas reales de la tabla (SELECT * real,
// agosto 2026): 51 públicas + email (revocada). show_trending se excluye
// deliberadamente (las tendencias se eliminaron del perfil). Si se añade una
// columna a la tabla y el frontend la necesita, hay que añadirla aquí también.
export const PROFILE_PUBLIC_COLUMNS = [
  'id',
  'username',
  'avatar_url',
  'bio',
  'created_at',
  'updated_at',
  'banner_url',
  'followers',
  'followings',
  'roles',
  'social_links',
  'accent_color',
  'is_private',
  'interests',
  'stats_private',
  'stats_visibility',
  'profile_views_count',
  'banner_position',
  'avatar_position',
  'accent_color_secondary',
  'accent_surface_color',
  'accent_surface_glass',
  'show_accent_profile',
  'accent_visibility',
  'show_accent_explore',
  'show_interests',
  'show_profile_stats',
  'profile_background_url',
  'profile_background_position',
  'profile_background_blur',
  'profile_background_dim',
  'show_likes',
  'show_saves',
  'allow_mention',
  'allow_encrypted_add',
  'pronouns',
  'banner_credits',
  'avatar_credits',
  'profile_text_color',
  'banner_dim',
  'filter_encrypted',
  'show_accent',
  'displayname',
  'time_format_24h',
  'theme',
  'locale',
  'show_badges',
  'badges_visibility',
  'user_status',
  'user_status_updated_at',
  'show_global_bg',
  'show_cards_glass',
  'chat_default_style',
  'sidebar_default_style',
  'sidebar_default_colors',
  'song',
  // Actividad local (migración 079): la escribe la app de escritorio y se muestra
  // debajo de "Mi canción" (Components/ActivityCard). Los dos ajustes de
  // privacidad vienen de la 080.
  'activity',
  'activity_updated_at',
  'activity_enabled',
  'activity_visibility',
  // Comunidades del perfil (migración 088): quién ve la tab.
  'communities_visibility',
  // Programa elegido a mano (migración 081): segunda actividad, convive con la
  // canción/juego detectado.
  'program_activity',
].join(', ');

// ── Límites coherentes de caracteres (una sola fuente de verdad) ──
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const DISPLAYNAME_MAX = 50;
export const PRONOUNS_MAX = 30;
export const BIO_MAX = 80;
export const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

// ── Validación de email (whitelist de proveedores) ──
// Re-export del módulo puro emailValidation.js: cero dependencias, así la
// lógica puede correr también en Node (test de seguridad/CI). La app usa
// estas funciones para restringir el registro y el login a proveedores
// conocidos (Gmail, Outlook, Yahoo, Proton, iCloud) porque la verificación
// de email está deshabilitada en Supabase.
export {
  ALLOWED_EMAIL_DOMAINS,
  ALLOWED_EMAIL_DOMAINS_LIST,
  getEmailDomain,
  isValidEmailFormat,
  isAllowedEmailDomain,
  validateEmail,
} from './emailValidation';

/**
 * Valida campos de perfil contra los límites coherentes.
 * @param {object} fields - { username, displayname, pronouns, bio }
 * @param {object} [opts] - { minUsername } — false solo en rutas de creación
 *                          automática (OAuth/legacy) donde el username puede
 *                          derivarse del email.
 * @returns {string|null} - Mensaje de error o null si todo está bien.
 */
export function validateProfileFields(fields = {}, { minUsername = true } = {}) {
  if (typeof fields.username === 'string') {
    const u = fields.username.trim();
    if (!USERNAME_RE.test(u)) return 'Username can only contain letters, numbers and underscores';
    if (u.length > USERNAME_MAX) return `Username can't exceed ${USERNAME_MAX} characters`;
    if (minUsername && u.length < USERNAME_MIN) return `Username must be at least ${USERNAME_MIN} characters`;
  }
  if (typeof fields.displayname === 'string' && fields.displayname.trim().length > DISPLAYNAME_MAX) {
    return `Display name can't exceed ${DISPLAYNAME_MAX} characters`;
  }
  if (typeof fields.pronouns === 'string' && fields.pronouns.trim().length > PRONOUNS_MAX) {
    return `Pronouns can't exceed ${PRONOUNS_MAX} characters`;
  }
  if (typeof fields.bio === 'string' && fields.bio.trim().length > BIO_MAX) {
    return `Bio can't exceed ${BIO_MAX} characters`;
  }
  return null;
}

function isUnknownColumnError(error, column) {
  const message = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return (
    message.includes(column.toLowerCase()) ||
    message.includes('unknown column') ||
    message.includes('column') && message.includes('does not exist')
  );
}

/**
 * Resolve the email for a username ONLY when the password is correct.
 *
 * Usado por el login por username (migración 074). El RPC
 * `login_email_by_username` corre como SECURITY DEFINER, compara la
 * contraseña contra auth.users.encrypted_password y devuelve el email
 * únicamente si coincide; con credenciales inválidas devuelve NULL. Así no
 * se pueden enumerar emails/usernames (antes `get_email_by_username` los
 * filtraba con solo conocer el username).
 *
 * @param {string} username - Username de la cuenta
 * @param {string} password - Contraseña en claro (viaja por HTTPS al RPC)
 * @returns {Promise<string|null>} - Email de la cuenta o null si no coincide
 */
export async function loginEmailByUsername(username, password) {
  const normalized = username.trim().toLowerCase();
  if (!normalized || !password) return null;

  try {
    const { data, error } = await supabase.rpc('login_email_by_username', {
      uname: normalized,
      pwd: password,
    });

    if (error) {
      console.error('Error resolving email by username:', error);
      return null;
    }

    return data || null;
  } catch (err) {
    console.error('Get email error:', err);
    return null;
  }
}

/**
 * Verifica la contraseña ACTUAL de la cuenta autenticada.
 *
 * No se hace en el cliente: el RPC `verify_password` (migración 075) compara
 * con bcrypt contra auth.users del uid de la sesión y aplica throttle
 * (10 fallos / 15 min). Necesario antes de cambiar username/email/contraseña.
 *
 * @param {string} password - Contraseña en claro (viaja por HTTPS)
 * @returns {Promise<boolean>}
 */
export async function verifyCurrentPassword(password) {
  if (!password) return false;
  try {
    const { data, error } = await supabase.rpc('verify_password', { pwd: password });
    if (error) {
      console.error('Error verifying password:', error);
      return false;
    }
    return data === true;
  } catch (err) {
    console.error('Verify password error:', err);
    return false;
  }
}

/**
 * Cambia el username de la cuenta autenticada (requiere contraseña actual).
 *
 * @param {string} newUsername
 * @param {string} password - Contraseña actual
 * @returns {Promise<string>} código: 'ok' | 'invalid_username' |
 *   'invalid_password' | 'same' | 'taken' | 'not_authenticated' | 'error'
 */
export async function changeUsername(newUsername, password) {
  const normalized = String(newUsername || '').trim().toLowerCase();
  try {
    const { data, error } = await supabase.rpc('change_username', {
      new_username: normalized,
      pwd: password,
    });
    if (error) {
      console.error('Error changing username:', error);
      return 'error';
    }
    return data || 'error';
  } catch (err) {
    console.error('Change username error:', err);
    return 'error';
  }
}

/**
 * Check if a username already exists
 * @param {string} username - Username to check
 * @returns {Promise<boolean>} - True if username exists
 */
export async function checkUsernameExists(username) {
  try {
    const { data, error } = await dbPublic
      .from('profiles')
      .select('id')
      .eq('username', username.toLowerCase())
      .maybeSingle();

    if (error) {
      console.error('Error checking username:', error);
      throw error;
    }

    return !!data;
  } catch (err) {
    console.error('Username check error:', err);
    throw err;
  }
}

export async function isUsernameAvailable(username, currentUserId) {
  const normalized = username.toLowerCase();
  try {
    const { data, error } = await dbPublic
      .from('profiles')
      .select('id')
      .eq('username', normalized)
      .maybeSingle();

    if (error) {
      console.error('Error checking username availability:', error);
      throw error;
    }

    if (!data) return true;
    return data.id === currentUserId;
  } catch (err) {
    console.error('Username availability error:', err);
    throw err;
  }
}

/**
 * Check if an email already exists
 * @param {string} email - Email to check
 * @returns {Promise<boolean>} - True if email exists
 */
export async function checkEmailExists(email) {
  try {
    // Igual que getEmailByUsername: la columna email está revocada; el check
    // se resuelve vía RPC SECURITY DEFINER que devuelve solo un boolean.
    const { data, error } = await supabase.rpc('email_exists', {
      addr: email.toLowerCase(),
    });

    if (error) {
      console.error('Error checking email:', error);
      throw error;
    }

    return !!data;
  } catch (err) {
    console.error('Email check error:', err);
    throw err;
  }
}

/**
 * Create a user profile after successful registration
 * @param {string} userId - User ID from auth
 * @param {string} email - User email
 * @param {string} username - Username
 * @returns {Promise<object>} - Created profile data
 */
export async function createUserProfile(userId, email, username, displayname) {
  // Validación de límites (sin mínimo: rutas automáticas derivan el username)
  const err = validateProfileFields({ username, displayname }, { minUsername: false });
  if (err) throw new Error(err);

  const profile = {
    id: userId,
    email: email.toLowerCase(),
    username: username.trim().toLowerCase(),
    displayname: displayname || username,
    created_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await supabase
      .from('profiles')
      .insert([profile])
      .select(PROFILE_PUBLIC_COLUMNS)
      .single();

    if (error) {
      console.error('Error creating profile:', error);
      throw error;
    }

    // cache created profile
    try {
      setCachedProfile(data);
    } catch (e) {
      /* ignore */
    }

    return data;
  } catch (err) {
    console.error('Profile creation error:', err);
    throw err;
  }
}

/**
 * Get user profile by ID
 * @param {string} userId - User ID
 * @returns {Promise<object>} - User profile
 */
export async function getUserProfile(userId) {
  try {
    // Leer cache para el render inicial (el useState en profile.jsx lo usa)
    const cached = getCachedProfile(userId);

    // Siempre fetch fresh data — aunque haya cache, resolvemos con datos frescos.
    // Usamos columnas explícitas SIN email (columna revocada en migración 053).
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_PUBLIC_COLUMNS)
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching profile:', error);
      if (cached) {
        console.warn('Falling back to cached profile after fetch error');
        return cached;
      }
      throw error;
    }

    if (data) {
      normalizeProfileUrls(data);
      setCachedProfile(data);
    }
    return data;
  } catch (err) {
    console.error('Fetch profile error:', err);
    throw err;
  }
}

export async function getUserProfileByUsername(username) {
  try {
    // Leer cache para el render inicial (el useState en profile.jsx lo usa)
    const cached = getCachedProfileByUsername(username);

    // Siempre fetch fresh data — aunque haya cache, resolvemos con datos frescos
    const { data, error } = await dbPublic
      .from('profiles')
      .select('*')
      .eq('username', username.toLowerCase())
      .maybeSingle();

    if (error) {
      console.error('Error fetching profile by username:', error);
      if (cached) {
        console.warn('Falling back to cached profile after fetch error');
        return cached;
      }
      throw error;
    }

    if (data) {
      normalizeProfileUrls(data);
      setCachedProfile(data);
      setCachedProfileByUsername(username, data);
    }
    return data;
  } catch (err) {
    console.error('Fetch profile by username error:', err);
    throw err;
  }
}

/**
 * List all profiles except the current user, ordered by most recent
 * @param {string} [excludeUserId] - Optional user ID to exclude
 * @param {number} [limit=50] - Max results
 * @returns {Promise<Array>} - List of profiles
 */
/**
 * Search profiles by username (for user selector in encrypted posts)
 * @param {string} query - Search query
 * @param {string} [excludeUserId] - Optional user ID to exclude
 * @param {number} [limit=10] - Max results
 * @returns {Promise<Array>} - Matching profiles
 */
export async function searchProfiles(query, excludeUserId, limit = 10) {
  try {
    let dbQuery = dbPublic
      .from('profiles')
      .select('id, username, displayname, avatar_url')
      .ilike('username', `%${query.toLowerCase()}%`)
      .order('username', { ascending: true })
      .limit(limit);

    if (excludeUserId) {
      dbQuery = dbQuery.neq('id', excludeUserId);
    }

    const { data, error } = await dbQuery;
    if (error) {
      console.error('Error searching profiles:', error);
      return [];
    }
    // Normalizar URLs del CDN en resultados de búsqueda
    if (data) data.forEach(normalizeProfileUrls);
    return data || [];
  } catch (err) {
    console.error('Search profiles error:', err);
    return [];
  }
}

export async function listProfiles(excludeUserId, limit = 50) {
  try {
    let query = dbPublic
      .from('profiles')
      .select('id, username, displayname, avatar_url, banner_url, bio, pronouns, roles, created_at, is_private, interests, accent_color, accent_color_secondary, accent_surface_color, accent_surface_glass, accent_visibility, show_accent_profile, show_accent_explore, banner_position, avatar_position')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (excludeUserId) {
      query = query.neq('id', excludeUserId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error listing profiles:', error);
      throw error;
    }

    // Normalizar URLs del CDN en todos los perfiles listados
    if (data) data.forEach(normalizeProfileUrls);
    return data || [];
  } catch (err) {
    console.error('List profiles error:', err);
    throw err;
  }
}

// --- Simple localStorage cache for profiles ---
const PROFILE_CACHE_PREFIX = 'fc_profile_';
const PROFILE_CACHE_TTL = 1000 * 60 * 60; // 1 hour

export function clearCachedProfile(userId) {
  if (!userId) return;
  try {
    removeItem(PROFILE_CACHE_PREFIX + userId);
  } catch (err) {
    console.warn('Could not clear cached profile:', err);
  }
}

export function clearCachedProfileByUsername(username) {
  if (!username) return;
  try {
    removeItem(PROFILE_USERNAME_PREFIX + username.toLowerCase());
  } catch (err) {
    console.warn('Could not clear cached profile by username:', err);
  }
}

export function setCachedProfile(profile, ttlMs = PROFILE_CACHE_TTL) {
  if (!profile || !profile.id) return;
  try {
    // Strip sensitive fields (email) before caching in localStorage
    const { email, ...safeProfile } = profile;
    const payload = {
      ts: Date.now(),
      ttl: ttlMs,
      profile: safeProfile,
    };
    setItem(PROFILE_CACHE_PREFIX + profile.id, payload);
  } catch (err) {
    console.warn('Could not set profile cache:', err);
  }
}

export function getCachedProfile(userId) {
  try {
    const payload = getItem(PROFILE_CACHE_PREFIX + userId);
    if (!payload || !payload.ts) return null;
    if (Date.now() - payload.ts > (payload.ttl || PROFILE_CACHE_TTL)) {
      removeItem(PROFILE_CACHE_PREFIX + userId);
      return null;
    }
    return payload.profile || null;
  } catch (err) {
    console.warn('Could not read profile cache:', err);
    return null;
  }
}

// --- Cache por username (para perfiles ajenos) ---
const PROFILE_USERNAME_PREFIX = 'fc_profile_un_';

export function setCachedProfileByUsername(username, profile) {
  if (!username || !profile?.id) return;
  try {
    // Cache por ID (reutiliza la función existente)
    setCachedProfile(profile);
    // Cache por username (mapea username → ID)
    const index = { id: profile.id, ts: Date.now(), ttl: PROFILE_CACHE_TTL };
    setItem(PROFILE_USERNAME_PREFIX + username.toLowerCase(), index);
  } catch (err) {
    console.warn('Could not cache profile by username:', err);
  }
}

export function getCachedProfileByUsername(username) {
  if (!username) return null;
  try {
    const index = getItem(PROFILE_USERNAME_PREFIX + username.toLowerCase());
    if (!index?.id || !index.ts) return null;
    if (Date.now() - index.ts > (index.ttl || PROFILE_CACHE_TTL)) {
      removeItem(PROFILE_USERNAME_PREFIX + username.toLowerCase());
      return null;
    }
    // Recuperar el perfil completo por ID (usando el cache existente)
    return getCachedProfile(index.id);
  } catch (err) {
    console.warn('Could not read cached profile by username:', err);
    return null;
  }
}

export async function ensureUserProfile(user) {
  if (!user?.id) {
    return null;
  }

  try {
    const existingProfile = await getUserProfile(user.id);
    if (existingProfile) {
      return existingProfile;
    }

    // Derivar un username válido: solo [a-z0-9_], minúsculas, máx 20.
    // Sanitizamos porque el origen puede ser el prefijo del email (con puntos)
    // o el display name de OAuth (con espacios/emojis), y createUserProfile
    // ya valida estrictamente el formato.
    const raw =
      user.user_metadata?.username ||
      user.user_metadata?.name ||
      user.email?.split('@')[0] ||
      '';
    const username = String(raw)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, USERNAME_MAX);

    if (!username) {
      console.warn('No username available to create profile for user', user.id);
      return null;
    }

    return await createUserProfile(user.id, user.email, username);
  } catch (err) {
    console.error('Ensure profile error:', err);
    throw err;
  }
}

/**
 * Update user profile
 * @param {string} userId - User ID
 * @param {object} updates - Profile updates
 * @returns {Promise<object>} - Updated profile
 */
export async function updateUserProfile(userId, updates) {
  try {
    const safeUpdates = { ...updates };
    // Validar límites coherentes antes de escribir en la DB
    const err = validateProfileFields(safeUpdates);
    if (err) throw new Error(err);
    if (typeof safeUpdates.bio === 'string') {
      safeUpdates.bio = sanitizeContent(safeUpdates.bio);
    }
    const { data, error } = await supabase
      .from('profiles')
      .update({
        ...safeUpdates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select(PROFILE_PUBLIC_COLUMNS)
      .single();

    if (error) {
      console.error('Error updating profile:', error);
      throw error;
    }

    // update cache
    try {
      setCachedProfile(data);
    } catch (e) {
      /* ignore */
    }

    return data;
  } catch (err) {
    console.error('Update profile error:', err);
    throw err;
  }
}

// ── Profile views ──

const VIEWED_PROFILE_KEY = 'fc_viewed_profile_';

/**
 * Track a profile view (once per user per profile, dedup via localStorage)
 */
export async function trackProfileView(profileId, userId) {
  if (!profileId) return false;
  const key = VIEWED_PROFILE_KEY + (userId || 'anon');
  try {
    const viewed = getItem(key) || [];
    if (viewed.includes(profileId)) return false;

    // Increment profile_views_count (resiliente a columna faltante)
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('profile_views_count')
        .eq('id', profileId)
        .single();

      if (profile) {
        await supabase
          .from('profiles')
          .update({ profile_views_count: (profile.profile_views_count || 0) + 1 })
          .eq('id', profileId);
      }
    } catch (e) {
      console.warn('profile_views_count not available for tracking:', e?.message || e);
    }

    viewed.push(profileId);
    setItem(key, viewed);
    return true;
  } catch (err) {
    console.warn('Error tracking profile view:', err);
    return false;
  }
}

export async function updateAuthUserMetadata(updates) {
  try {
    const { data, error } = await supabase.auth.updateUser({
      data: updates,
    });

    if (error) {
      console.error('Error updating auth user metadata:', error);
      throw error;
    }

    return data;
  } catch (err) {
    console.error('Auth user metadata update error:', err);
    throw err;
  }
}
