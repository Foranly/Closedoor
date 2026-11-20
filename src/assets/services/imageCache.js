/**
 * Caché en memoria de imágenes ya cargadas.
 *
 * Las imágenes que ya se descargaron y decodificaron se recuerdan por URL, de
 * modo que al volver a montar un componente o navegar a otra vista se pintan al
 * instante (desde el caché del navegador) sin recargar ni hacer pop-in.
 *
 * Uso:
 *   preloadImage(url)  → calienta el caché (no bloquea la UI)
 *   isImageCached(url) → true si ya está lista para pintarse sin espera
 */

import { getCdnUrl } from './cdnService';

const loaded = new Set();
const inFlight = new Map();

/** True si esta URL ya se cargó y decodificó en esta sesión. */
export function isImageCached(url) {
  return Boolean(url) && loaded.has(url);
}

/**
 * Precarga los marcos de uno o varios perfiles en cuanto llegan los datos, sin
 * esperar a que se monte el <Avatar>. Así, cuando la fila se pinta, el marco ya
 * está en caché y sale en el primer frame (sin pop-in al hacer scroll ni al
 * navegar entre vistas). Acepta un perfil, un array o un objeto con `profiles`
 * (la relación que devuelve Supabase en posts, comentarios, etc.).
 */
export function preloadProfileFrames(data) {
  if (!data) return;
  if (Array.isArray(data)) {
    data.forEach(preloadProfileFrames);
    return;
  }
  if (typeof data !== 'object') return;

  if (data.avatar_frame_url) preloadImage(getCdnUrl(data.avatar_frame_url));
  if (data.profiles) preloadProfileFrames(data.profiles);
}

/**
 * Precarga las portadas de las colecciones de bookmarks. Igual que los marcos
 * de avatar: se llama en cuanto llegan las colecciones, así al abrir el grid
 * las covers se pintan en el primer frame (sin pop-in) y sin volver a pedirlas
 * durante la sesión.
 */
export function preloadBookmarkCovers(collections) {
  if (!Array.isArray(collections)) return;
  for (const c of collections) {
    if (c?.cover_url) preloadImage(getCdnUrl(c.cover_url));
  }
}

/**
 * Precarga y decodifica una imagen. Resuelve siempre (true), aunque falle, para
 * no dejar promesas colgadas ni romper a quien la llame.
 */
export function preloadImage(url) {
  if (!url) return Promise.resolve(false);
  if (loaded.has(url)) return Promise.resolve(true);
  if (inFlight.has(url)) return inFlight.get(url);

  const promise = new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      loaded.add(url);
      inFlight.delete(url);
      resolve(true);
    };
    img.onload = finish;
    img.onerror = finish;
    img.decoding = 'async';
    img.src = url;
    // decode() evita el parpadeo al pintar la imagen por primera vez.
    if (typeof img.decode === 'function') {
      img.decode().then(finish).catch(() => {});
    }
  });

  inFlight.set(url, promise);
  return promise;
}
