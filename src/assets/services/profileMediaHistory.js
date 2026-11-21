import { supabase } from './supabaseclient';
import { getItem, setItem } from './secureStorage';

/**
 * Historial de imágenes del perfil (avatar, banner y marco).
 *
 * Se guarda en `profile_media_history` (migración 110) para que viaje entre
 * dispositivos, con una copia cifrada en el navegador para:
 *   - pintar el historial al instante al abrir el modal,
 *   - seguir teniendo historial si la migración aún no está aplicada.
 *
 * Nunca se guardan previews locales (`data:` / `blob:`): esas URLs solo existen
 * mientras el modal está abierto y no sirven de un día para otro.
 */

export const MEDIA_HISTORY_KINDS = ['avatar', 'banner', 'frame'];
export const MEDIA_HISTORY_LIMIT = 12;

const TABLE = 'profile_media_history';

const cacheKey = (userId, kind) => `pmh_${userId}_${kind}`;

function isStorableUrl(url) {
  const clean = String(url || '').trim();
  if (!clean) return false;
  if (clean.startsWith('data:') || clean.startsWith('blob:')) return false;
  return clean.length <= 2048;
}

export function getCachedMediaHistory(userId, kind) {
  if (!userId || !MEDIA_HISTORY_KINDS.includes(kind)) return [];
  const cached = getItem(cacheKey(userId, kind));
  if (!Array.isArray(cached)) return [];
  return cached.filter((u) => typeof u === 'string' && isStorableUrl(u));
}

function setCachedMediaHistory(userId, kind, urls) {
  setItem(cacheKey(userId, kind), urls.slice(0, MEDIA_HISTORY_LIMIT));
}

/** Historial más reciente primero. Cae a la caché local si la tabla no existe. */
export async function listMediaHistory(userId, kind) {
  if (!userId || !MEDIA_HISTORY_KINDS.includes(kind)) return [];
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('url, created_at')
      .eq('user_id', userId)
      .eq('kind', kind)
      .order('created_at', { ascending: false })
      .limit(MEDIA_HISTORY_LIMIT);
    if (error) throw error;
    const urls = (data || []).map((row) => row.url).filter(isStorableUrl);
    setCachedMediaHistory(userId, kind, urls);
    return urls;
  } catch {
    return getCachedMediaHistory(userId, kind);
  }
}

/**
 * Añade (o sube al principio, si ya existía) una imagen al historial.
 * No lanza: el historial es accesorio y nunca debe romper el guardado.
 */
export async function recordMediaHistory(userId, kind, url) {
  if (!userId || !MEDIA_HISTORY_KINDS.includes(kind) || !isStorableUrl(url)) return;
  const clean = String(url).trim();

  setCachedMediaHistory(userId, kind, [
    clean,
    ...getCachedMediaHistory(userId, kind).filter((u) => u !== clean),
  ]);

  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert(
        { user_id: userId, kind, url: clean, created_at: new Date().toISOString() },
        { onConflict: 'user_id,kind,url' }
      );
    if (error) throw error;

    // Recorta lo que sobra: solo se conservan las MEDIA_HISTORY_LIMIT últimas.
    const { data } = await supabase
      .from(TABLE)
      .select('id')
      .eq('user_id', userId)
      .eq('kind', kind)
      .order('created_at', { ascending: false })
      .range(MEDIA_HISTORY_LIMIT, MEDIA_HISTORY_LIMIT + 49);
    if (data?.length) {
      await supabase.from(TABLE).delete().in('id', data.map((row) => row.id));
    }
  } catch {
    // Sin tabla (migración pendiente) o sin red: queda en la caché local.
  }
}

/** Registra de golpe las tres imágenes del perfil que no estén vacías. */
export function recordProfileMediaHistory(userId, { avatar, banner, frame } = {}) {
  if (!userId) return Promise.resolve();
  return Promise.all(
    Object.entries({ avatar, banner, frame })
      .filter(([, url]) => isStorableUrl(url))
      .map(([kind, url]) => recordMediaHistory(userId, kind, url))
  );
}
