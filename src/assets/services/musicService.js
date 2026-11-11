/**
 * musicService.js — Búsqueda de canciones para la card "Mi canción" del perfil
 * y para las canciones compartidas en el chat.
 *
 * Estrategia (verificada contra las APIs):
 *   1. YouTube Music vía innertube (`/api/music/ytsearch`, servido por el
 *      backend de música) — fuente PRIMARIA: solo catálogo musical (descarta
 *      subidas de YouTube/UGC, podcasts y colecciones) y encuentra la canción
 *      real casi siempre. Sus resultados no traen preview de 30 s, así que al
 *      fijar/enviar la canción se pide uno a iTunes con withPreviewFallback()
 *      (solo respaldo del player).
 *   2. iTunes Search API directo desde el navegador — devuelve
 *      `Access-Control-Allow-Origin: *` con peticiones de navegador y trae
 *      previewUrl (30s), artworkUrl100 (redimensionable) y trackName/artistName.
 *   3. Si falla (red/CORS/edge), fallback al proxy `/api/music-search`
 *      (función serverless de Vercel + ruta en server.js) que consulta Deezer
 *      server-side y, como último recurso, iTunes server-side.
 *
 * Stream de la canción completa: lo resuelve el backend con la API innertube
 * (YouTube) y se sirve proxyado desde el MISMO CÓDIGO en tres sitios (ver
 * api/_musicHttp.js): plugins/musicDevApiPlugin.js en `npm run dev`, el rewrite
 * de /api/music/* a un host propio en producción, y el servidor LOCAL de la app
 * de escritorio (127.0.0.1:5990, ver desktop/README.md).
 *
 * La base se decide en getMusicApiBase() (services/desktopApp.js): en la app de
 * escritorio apunta al loopback —YouTube ve la IP del usuario, no un datacenter—
 * y en el navegador al mismo origen. YouTube solo entrega el stream completo a
 * IPs con buena reputación, así que en la web lo normal es caer al preview de
 * 30 s: eso es justo lo que anuncia el aviso de descarga (DesktopAppPrompt).
 *
 * Todos los resultados se normalizan a un shape único:
 *   { provider, trackId, title, artist, album, artwork, previewUrl, externalUrl }
 */

import { getMusicApiBase } from './desktopApp';

// El navegador nunca ve la URL de googlevideo (está firmada para la IP que la
// resuelve): el audio siempre llega por el backend de música. La base cambia
// según dónde corra la app → getMusicApiBase() (loopback del escritorio o
// mismo origen).
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';

/** Escala la URL de arte de iTunes (ej. 100x100bb.jpg → 600x600bb.jpg). */
function upscaleArtwork(url, size = 600) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+(?:bb)?(?:-\d+)?\.(jpg|png)/i, `/${size}x${size}bb.$1`);
}

function normalizeItunesTrack(t) {
  if (!t?.trackName || !t?.previewUrl) return null;
  return {
    provider: 'itunes',
    trackId: String(t.trackId),
    title: t.trackName,
    artist: t.artistName || '',
    album: t.collectionName || '',
    artwork: upscaleArtwork(t.artworkUrl100),
    previewUrl: t.previewUrl,
    externalUrl: t.trackViewUrl || null,
    duration: Math.round((t.trackTimeMillis || 0) / 1000),
  };
}

/**
 * Busca en iTunes directamente desde el navegador (CORS OK).
 */
export async function searchMusicDirect(query, limit = 10, { signal } = {}) {
  const url =
    `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(query)}` +
    `&media=music&entity=song&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`iTunes search failed (${res.status})`);
  const data = await res.json();
  return (data.results || []).map(normalizeItunesTrack).filter(Boolean);
}

/**
 * Busca canciones en el catálogo de YouTube Music (innertube) vía backend.
 * Devuelve el shape normalizado del frontend
 * ({ provider: 'youtube', trackId: videoId, title, artist, artwork, duration, … })
 * con `previewUrl` vacío (YouTube no ofrece preview de 30 s).
 */
export async function searchMusicYouTube(query, limit = 10) {
  const url = `${getMusicApiBase()}/ytsearch?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`YouTube search failed (${res.status})`);
  const data = await res.json();
  if (!data?.success || !Array.isArray(data.results)) {
    throw new Error(data?.error || 'YouTube search returned no results');
  }
  return data.results;
}

/**
 * Busca a través del proxy /api/music-search (Deezer por defecto, iTunes como
 * respaldo server-side). Retorna el objeto crudo { success, provider, results }.
 */
async function searchMusicProxy(query, provider, limit, { signal } = {}) {
  const url =
    `/api/music-search?q=${encodeURIComponent(query)}` +
    `&provider=${provider}&limit=${limit}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Music proxy failed (${res.status})`);
  const data = await res.json();
  if (!data?.success || !Array.isArray(data.results)) {
    throw new Error(data?.error || 'Music proxy returned no results');
  }
  return data;
}

/**
 * Clave estable de una canción (provider:trackId). Se usa para saber si la
 * canción que suena es la misma que pinta una card / ventana flotante.
 */
export function songKey(song) {
  return song?.trackId ? `${song.provider || ''}:${song.trackId}` : '';
}

/**
 * Normaliza una canción para GUARDARLA en una columna jsonb (posts.song).
 *
 * Solo se persisten campos conocidos y URLs http(s): el jsonb lo escribe el
 * cliente, así que no se guarda un blob arbitrario. Devuelve null si no hay
 * título (sin título no hay nada que reproducir).
 */
export function normalizeSongPayload(song) {
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
  if (!title) return null;

  const duration = Number(song.duration);
  return {
    provider: text(song.provider, 20) || 'unknown',
    trackId: text(song.trackId, 100),
    title,
    artist: text(song.artist, 200),
    album: text(song.album, 200),
    artwork: httpUrl(song.artwork),
    previewUrl: httpUrl(song.previewUrl),
    externalUrl: httpUrl(song.externalUrl),
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
  };
}

/**
 * URL de la miniatura de una canción, lista para pintar.
 *
 * `artwork` es un campo que se GUARDA (jsonb `messages.shared_song`, canción
 * del perfil), así que los registros antiguos o escritos por el cliente pueden
 * venir sin él. Para una canción de YouTube el videoId siempre existe, así que
 * se deriva la miniatura de ahí en vez de dejar el hueco vacío para siempre.
 * Devuelve '' si no hay forma de conocerla (el que pinta muestra el icono).
 */
export function songArtworkUrl(song) {
  const art = typeof song?.artwork === 'string' ? song.artwork.trim() : '';
  if (art) return art;
  if (song?.provider === 'youtube' && song.trackId) {
    return `https://i.ytimg.com/vi/${encodeURIComponent(song.trackId)}/mqdefault.jpg`;
  }
  return '';
}

/**
 * La misma miniatura servida same-origin: el backend la descarga y la devuelve
 * con CORS. Es el respaldo cuando el navegador no puede pedir el CDN original
 * (red/DNS que bloquea el host, hotlink o una CSP antigua que no autoriza
 * `https:` en img-src). Misma ruta que usa colorExtractor para lo mismo.
 */
export function proxiedArtworkUrl(url) {
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

/**
 * URL de stream completo de una canción. Same-origin, servida por el backend
 * con innertube. La URL de googlevideo no se expone al navegador.
 * Retorna null si la canción no tiene título. Para resultados de YouTube se
 * manda `videoId`, que fija el vídeo exacto y evita re-buscarlo en el backend.
 */
export function getStreamUrl(song) {
  if (!song?.title) return null;
  const params = new URLSearchParams({ title: song.title });
  if (song.artist) params.set('artist', song.artist);
  if (song.duration) params.set('duration', String(song.duration));
  // Resultados de innertube: el videoId evita re-buscar y fija la versión exacta.
  if (song.provider === 'youtube' && song.trackId) params.set('videoId', song.trackId);
  return `${getMusicApiBase()}/stream?${params.toString()}`;
}

/**
 * Pre-warm: anticipa la resolución con innertube (busca el videoId y trae el
 * formato de audio) para que al pulsar play el stream arranque al instante.
 * Al montar la card se llama a /resolve, que resuelve y cachea en el server
 * SIN descargar audio.
 *
 * NO se pre-descarga el audio: descargas simultáneas desde la misma IP
 * disparan el rate-limit de googlevideo (throttling) y rompen los streams.
 *
 * Devuelve el payload de /resolve (`{ contentLength, playable, degraded, … }`) o
 * null si no se pudo resolver. `playable: false` = la pista no cabe entera en el
 * tramo que entrega el CDN → la card reproduce directo el preview de 30 s. Nunca
 * rechaza: el pre-warm no debe romper nada.
 *
 * Se pide a `/stream?...&prewarm=1` y NO a `/api/music/resolve`: en Vercel cada
 * archivo de `api/` es una función distinta (memoria propia), así que precalentar
 * desde otra función no compartía la caché y el stream pagaba igualmente la
 * resolución completa dentro de su reloj (de ahí los 504 de producción).
 *
 * NO se puerta detrás de /health: la primera llamada a una función serverless
 * puede tardar (instancia fría) y con el gate el pre-warm se saltaba justo cuando
 * más falta hace (la primera reproducción).
 */
export function prewarmStream(song) {
  if (!song?.title) return Promise.resolve(null);
  const params = new URLSearchParams({ title: song.title, prewarm: '1' });
  if (song.artist) params.set('artist', song.artist);
  if (song.duration) params.set('duration', String(song.duration));
  if (song.provider === 'youtube' && song.trackId) params.set('videoId', song.trackId);

  return fetch(`${getMusicApiBase()}/stream?${params.toString()}`, { signal: AbortSignal.timeout(20000) })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}

/** Clave de comparación para títulos/artistas (sin acentos ni puntuación). */
function previewKey(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Elige el candidato de iTunes cuyo preview corresponde a la canción de YouTube.
 * Exige título compatible y, si ambos artistas se conocen, que coincidan: un
 * preview de otra versión/cover sería peor que no tener respaldo.
 */
function pickPreviewCandidate(song, candidates) {
  const title = previewKey(song.title);
  const artist = previewKey(song.artist);
  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (!candidate?.previewUrl) continue;
    const candidateTitle = previewKey(candidate.title);
    const candidateArtist = previewKey(candidate.artist);
    if (!candidateTitle || !title) continue;

    const titleScore = candidateTitle === title
      ? 2
      : (candidateTitle.includes(title) || title.includes(candidateTitle) ? 1 : 0);
    if (!titleScore) continue;

    if (artist && candidateArtist && !(candidateArtist.includes(artist) || artist.includes(candidateArtist))) {
      continue;
    }

    const score = titleScore + (artist ? 1 : 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

/**
 * Añade un preview de 30 s a una canción de YouTube (solo si no tiene uno).
 *
 * Los resultados de innertube no traen preview y el reproductor lo necesita
 * como respaldo cuando YouTube bloquea el stream completo (lo normal en el
 * navegador). Se consulta iTunes (URLs estables, no caducan) y el preview se
 * guarda JUNTO a la canción de YouTube (provider/trackId no cambian, así el
 * stream sigue yendo al vídeo exacto). Best-effort: si no hay coincidencia
 * razonable, devuelve la canción sin preview.
 */
export async function withPreviewFallback(song) {
  if (!song?.title || song.previewUrl) return song;
  const q = [song.artist, song.title].filter(Boolean).join(' ').trim();
  if (!q) return song;

  // Presupuesto corto: es un respaldo, no debe retrasar el guardado/envío.
  let candidates = [];
  try {
    candidates = await searchMusicDirect(q, 8, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn('[music] preview fallback (iTunes direct) failed:', err?.message || err);
  }

  if (!candidates.length) {
    try {
      candidates = (await searchMusicProxy(q, 'itunes', 8, { signal: AbortSignal.timeout(5000) })).results || [];
    } catch (err) {
      console.warn('[music] preview fallback (iTunes proxy) failed:', err?.message || err);
    }
  }

  const best = pickPreviewCandidate(song, candidates);
  return best ? { ...song, previewUrl: best.previewUrl } : song;
}

/**
 * Busca canciones con fallback en cascada (solo metadatos; el stream lo
 * resuelve innertube aparte):
 *   1) YouTube (innertube) vía backend → iTunes directo → Deezer vía proxy →
 *      iTunes vía proxy.
 * Devuelve { results, provider }.
 *
 * Si un proveedor respondió OK pero sin resultados, se devuelve la lista
 * vacía (para que la UI muestre "sin resultados"); solo se lanza error
 * cuando TODOS los proveedores fallaron.
 */
export async function searchMusic(query, { limit = 10 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { results: [], provider: null };

  let anySucceeded = false;

  // 0) YouTube Music (innertube) — fuente primaria: catálogo musical, sin UGC.
  try {
    const results = await searchMusicYouTube(q, limit);
    anySucceeded = true;
    if (results.length) return { results, provider: 'youtube' };
  } catch (err) {
    console.warn('[music] YouTube search failed:', err?.message || err);
  }

  // 1) iTunes directo (ruta rápida, sin servidor)
  try {
    const results = await searchMusicDirect(q, limit);
    anySucceeded = true;
    if (results.length) return { results, provider: 'itunes' };
  } catch (err) {
    console.warn('[music] iTunes direct failed:', err?.message || err);
  }

  // 2) Deezer vía proxy
  try {
    const proxied = await searchMusicProxy(q, 'deezer', limit);
    anySucceeded = true;
    if (proxied.results.length) return { results: proxied.results, provider: 'deezer' };
  } catch (err) {
    console.warn('[music] Deezer proxy failed:', err?.message || err);
  }

  // 3) iTunes vía proxy (último recurso, p. ej. en entornos sin CORS)
  try {
    const proxied = await searchMusicProxy(q, 'itunes', limit);
    anySucceeded = true;
    if (proxied.results.length) return { results: proxied.results, provider: 'itunes' };
  } catch (err) {
    console.warn('[music] iTunes proxy failed:', err?.message || err);
  }

  if (anySucceeded) return { results: [], provider: null };
  throw new Error('Music search failed');
}

// ── Portada de la actividad detectada en el sistema ──
//
// El reproductor del sistema solo da título y artista (desktop/activity.js), así
// que la portada se resuelve con la MISMA búsqueda que la card "Mi canción"
// (searchMusic: YouTube Music → iTunes → Deezer). Se usa solo la imagen: el
// audio de la actividad no se reproduce.
//
// Caché en memoria por consulta (6 h) y dedupe de peticiones simultáneas: la card
// se pinta en cada visita al perfil, y sin caché cada visita dispararía una
// búsqueda. Se cachea la PROMESA, así dos cards montándose a la vez comparten la
// misma petición.
const activityArtworkCache = new Map(); // key → { at, promise }
const ACTIVITY_ARTWORK_TTL = 6 * 60 * 60 * 1000;

/** Normaliza título/artista para comparar resultados con lo que dio el sistema. */
function normalizeTrackText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\((?:feat|ft|with)[^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Portada de lo que está sonando en el equipo, a partir del título y el artista
 * que publica el detector.
 *
 * @param {{title?: string, artist?: string}} params
 * @returns {Promise<string>} URL de la miniatura, o '' si no hay forma de saberla.
 */
export function resolveActivityArtwork({ title, artist } = {}) {
  const query = [title, artist].filter(Boolean).join(' ').trim();
  if (!query) return Promise.resolve('');

  const key = query.toLowerCase();
  const cached = activityArtworkCache.get(key);
  if (cached && Date.now() - cached.at < ACTIVITY_ARTWORK_TTL) return cached.promise;

  const promise = searchMusic(query, { limit: 5 })
    .then(({ results }) => {
      if (!Array.isArray(results) || results.length === 0) return '';
      // Preferir el resultado que coincide con el título detectado: el primer hit
      // de una búsqueda por "título artista" suele serlo, pero si el sistema
      // añadió coletillas ("(Remastered 2011)") conviene comprobarlo.
      const wanted = normalizeTrackText(title);
      const best = wanted
        ? results.find((r) => {
            const candidate = normalizeTrackText(r?.title);
            return candidate && (candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate));
          })
        : null;
      return songArtworkUrl(best || results[0]) || '';
    })
    .catch((err) => {
      console.warn('[music] Activity artwork lookup failed:', err?.message || err);
      return '';
    });

  activityArtworkCache.set(key, { at: Date.now(), promise });
  return promise;
}

// ── Preview fresco (los de Deezer expiran ≈ 15 min) ──
// Caché con TTL ~10 min (menor que la expiración real): una URL cacheada
// nunca se sirve ya muerta en la misma sesión.
const resolvedPreviewCache = new Map(); // key → { url, at }
const RESOLVED_PREVIEW_TTL = 10 * 60 * 1000;

/**
 * Resuelve la URL de preview VÁLIDA para un song guardado.
 * - iTunes: los previews son estables → se devuelve el guardado.
 * - Deezer: expiran → se re-consulta vía proxy (?track=) y se cachea en memoria.
 * Si la resolución falla, se devuelve la URL guardada como último recurso.
 */
export async function resolvePreviewUrl(song) {
  if (!song?.previewUrl) return null;
  if (song.provider !== 'deezer' || !song.trackId) return song.previewUrl;

  const key = `deezer:${song.trackId}`;
  const hit = resolvedPreviewCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVED_PREVIEW_TTL) return hit.url;
  resolvedPreviewCache.delete(key); // entrada expirada → liberar

  // Proxy same-origin `/api/music-search` (función serverless de Vercel, o ruta
  // de server.js en dev): los previews de Deezer expiran cada ~15 min.
  const trackParam = encodeURIComponent(song.trackId);
  const candidates = [`/api/music-search?track=${trackParam}&provider=deezer`];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.success && data.previewUrl) {
        resolvedPreviewCache.set(key, { url: data.previewUrl, at: Date.now() });
        return data.previewUrl;
      }
    } catch (err) {
      console.warn('[music] preview resolve failed:', err?.message || err);
    }
  }

  return song.previewUrl;
}
