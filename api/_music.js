/**
 * Lógica compartida de búsqueda de música (Deezer / iTunes) y normalización de
 * los resultados de YouTube Music, usada por:
 *   - api/music-search.js   → función serverless de Vercel (Deezer / iTunes)
 *   - api/music/_ytsearch.js → búsqueda primaria (innertube / YouTube Music)
 *   - server.js             → rutas locales /api/music-search y /api/music/ytsearch
 *
 * Todas las llamadas son server-side (sin CORS) y devuelven un arreglo de
 * tracks NORMALIZADOS con el mismo shape que usa el frontend (musicService):
 *   { provider, trackId, title, artist, album, artwork, previewUrl, externalUrl }
 */

const UA = 'Mozilla/5.0 (compatible; FastChangeBot/1.0)';

// ── YouTube Music (innertube) ──
// El search de innertube devuelve títulos de VÍDEO ("Artista - Tema (Official
// Video)") y el canal, no metadatos de canción. Aquí se limpian para que el
// shape sea el mismo que iTunes/Deezer: el título se queda con el tema y el
// canal con el artista. Así la búsqueda puede ser la de YouTube (mucho más
// precisa) sin ensuciar las cards ni el matcheo del stream.

function compareKey(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/vevo$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const VIDEO_NOISE_RE = /[([][^)\]]*\b(?:official|oficial|video|videoclip|audio|lyric|lyrics|letra|visualizer|hd|hq|4k|remaster(?:ed)?|music video)\b[^)\]]*[)\]]/gi;

function normalizeYouTubeArtwork(url, videoId) {
  const value = String(url || '').trim();
  const videoThumb = videoId
    ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
    : '';

  if (value.includes('yt3.googleusercontent.com')) {
    // Avatar del canal: no es la portada de la canción.
    if (videoThumb) return videoThumb;
    return value.replace(/=w\d+-h\d+.*$/i, '=w400-h400-l90-rj');
  }

  if (value.includes('googleusercontent.com')) {
    return value.replace(/=w\d+-h\d+.*$/i, '=w400-h400-l90-rj');
  }

  return value || videoThumb;
}

/**
 * Convierte un candidato de innertube en el track normalizado del frontend.
 * Acepta tanto el search de YouTube Music ({ artist, artwork }) como el de
 * YouTube ({ channel }). YouTube no ofrece preview de 30 s → `previewUrl`
 * vacío (el frontend pide uno a iTunes solo como respaldo del reproductor).
 */
function normalizeYouTubeTrack(candidate) {
  if (!candidate?.videoId) return null;

  const channel = String(candidate.artist || candidate.channel || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .trim();
  let title = String(candidate.title || '').trim();
  let artist = channel;

  // "Artista - Tema": el primer bloque suele repetir el canal.
  const parts = title.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const head = parts[0].trim();
    const headKey = compareKey(head);
    const artistKey = compareKey(artist);
    if (!artistKey || headKey === artistKey || (headKey && artistKey.startsWith(headKey))) {
      if (!artist) artist = head;
      title = parts.slice(1).join(' - ');
    }
  }

  title = title.replace(VIDEO_NOISE_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!title) return null;

  return {
    provider: 'youtube',
    trackId: candidate.videoId,
    title,
    artist,
    album: '',
    artwork: normalizeYouTubeArtwork(candidate.artwork, candidate.videoId),
    previewUrl: '',
    externalUrl: `https://www.youtube.com/watch?v=${candidate.videoId}`,
    duration: Math.round(Number(candidate.durationSec) || 0),
  };
}

/** Normaliza la lista de candidatos del search de innertube. */
export function normalizeYouTubeTracks(candidates = []) {
  return candidates.map(normalizeYouTubeTrack).filter(Boolean);
}

/** Escala la URL de arte de iTunes (ej. 100x100bb.jpg → 600x600bb.jpg). */
function upscaleItunesArtwork(url, size = 600) {
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
    artwork: upscaleItunesArtwork(t.artworkUrl100),
    previewUrl: t.previewUrl,
    externalUrl: t.trackViewUrl || null,
    duration: Math.round((t.trackTimeMillis || 0) / 1000),
  };
}

/** Escala la URL de arte de Deezer (250px → 500px, nítido en el vinilo). */
function upscaleDeezerArtwork(url, size = 500) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+-/i, `/${size}x${size}-`);
}

function normalizeDeezerTrack(t) {
  if (!t?.title || !t?.preview) return null;
  return {
    provider: 'deezer',
    trackId: String(t.id),
    title: t.title,
    artist: t.artist?.name || '',
    album: t.album?.title || '',
    // cover_medium (250px) → upscale a 500px para el disco y las miniaturas
    artwork: upscaleDeezerArtwork(t.album?.cover_medium || t.album?.cover_small) || null,
    previewUrl: t.preview,
    externalUrl: t.link || null,
    duration: t.duration || 0,
  };
}

async function fetchItunes(query, limit) {
  const url =
    'https://itunes.apple.com/search' +
    `?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`iTunes search failed (${res.status})`);
  const data = await res.json();
  return (data.results || []).map(normalizeItunesTrack).filter(Boolean);
}

async function fetchDeezer(query, limit) {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Deezer search failed (${res.status})`);
  const data = await res.json();
  return (data.data || []).map(normalizeDeezerTrack).filter(Boolean);
}

/**
 * Busca canciones server-side y devuelve tracks normalizados.
 * @param {string} query - Término de búsqueda
 * @param {'deezer'|'itunes'} provider - Proveedor a consultar
 * @param {number|string} [limit] - Límite de resultados (máx 25)
 */
export async function searchMusicServer(query, provider = 'deezer', limit = 10) {
  const capped = Math.min(parseInt(limit, 10) || 10, 25);
  if (provider === 'itunes') return fetchItunes(query, capped);
  return fetchDeezer(query, capped);
}

/**
 * Resuelve el preview FRESCO de un track. Los previews de Deezer expiran
 * (param `hdnea=exp=` ≈ 15 min), así que al reproducir una canción guardada
 * se consulta de nuevo para obtener una URL válida.
 * @param {string} trackId - ID del track en el proveedor
 * @param {'deezer'|'itunes'} provider - Proveedor (solo Deezer necesita refresh)
 * @returns {Promise<string|null>} - URL de preview fresca o null
 */
export async function resolveTrackPreview(trackId, provider = 'deezer') {
  if (provider !== 'deezer' || !trackId) return null;
  const url = `https://api.deezer.com/track/${encodeURIComponent(trackId)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Deezer track failed (${res.status})`);
  const data = await res.json();
  return data?.preview || null;
}
