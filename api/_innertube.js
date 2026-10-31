/**
 * api/_innertube.js — Resolución de streams de audio con la API innertube
 * (la API interna que usa el propio cliente de YouTube). Reemplaza a yt-dlp:
 * no requiere binarios ni servidor propio, así que corre también en serverless.
 *
 * Cómo funciona:
 *   1. search  → PÁGINA /results (ytInitialData): encuentra el videoId de
 *                "artista - título". ⚠️ NO se usa youtubei/v1/search a
 *                propósito: verificado que un search de innertube ENVENENA el
 *                player siguiente desde la misma IP (el player pasa a
 *                LOGIN_REQUIRED "Sign in to confirm you're not a bot"),
 *                mientras que con la búsqueda por HTML el player responde OK.
 *   2. player  → youtubei/v1/player: devuelve `streamingData.adaptiveFormats`
 *                con la URL directa del audio.
 *   3. match   → se elige el mejor candidato por similitud de título/artista y
 *                por DURACIÓN (evita covers, remixes y versiones en vivo).
 *
 * ⚠️ Clientes: cadena ANDROID_VR → IOS → ANDROID (ver CLIENTS). Sobre el
 * sondeo real (2026-10-10): los tres devuelven playabilityStatus OK con URLs
 * directas (ANDROID_VR a veces LOGIN_REQUIRED según el momento), WEB y los
 * clientes de música quedan UNPLAYABLE / LOGIN_REQUIRED. ANDROID va último
 * porque es el único que expone los itags de baja calidad (599 = 32 kbps) con
 * los que una canción larga cabe entera en el tramo que entrega el CDN. Si
 * algún día todos dejan de funcionar, hay que re-sondear clientes (el fallback
 * natural es WEB + PO token, que necesita un servicio extra).
 *
 * ⚠️ Las URLs de googlevideo están atadas a la IP que las resolvió y expiran
 * (~6 h). Por eso el frontend nunca las recibe: se proxian desde el server
 * (ver api/music/_stream.js) y se cachean acá con TTL conservador.
 *
 * ⚠️ Legal/ToS: extraer streams completa de YouTube va contra sus términos de
 * servicio; queda bajo tu criterio en tu infraestructura.
 */

// Clientes innertube soportados, en orden de preferencia. Las claves son las
// públicas que llevan las apps en el APK/IPA (no son secretos).
//
// Sondeo contra la API real (2026-10-10, mismo vídeo y misma IP):
//   ANDROID_VR ......... OK o LOGIN_REQUIRED según el momento · sólo 139/140
//   IOS ................ OK · sólo 139/140
//   ANDROID ............ OK · expone además los itags de BAJA calidad
//                        (599 = 32 kbps m4a, 600 = opus), que son los únicos
//                        que permiten que una canción larga quepa ENTERA en el
//                        tramo servible (MAX_UPSTREAM_RANGE_BYTES)
//   ANDROID_MUSIC / IOS_MUSIC ... LOGIN_REQUIRED ("Please sign in")
//   WEB_REMIX / MWEB ... UNPLAYABLE · WEB ... UNPLAYABLE (PO token)
//   TVHTML5_SIMPLY_EMBEDDED_PLAYER ... "no longer supported"
// Orden VR → IOS → ANDROID: los dos primeros dan mejor audio y ANDROID se
// consulta sólo si ninguno ofrece un formato que quepa entero.
const CLIENTS = [
  {
    name: 'ANDROID_VR',
    key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip',
    client: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      androidSdkVersion: 32,
      deviceModel: 'Quest 3',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'IOS',
    key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5 like Mac OS X)',
    client: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceModel: 'iPhone16,2',
      hl: 'en',
      gl: 'US',
    },
  },
  // Último recurso: es el único cliente que expone los itags de baja calidad
  // (599/600) con los que una canción larga entra entera en el tramo servible.
  {
    name: 'ANDROID',
    key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    client: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 34,
      hl: 'en',
      gl: 'US',
    },
  },
];

const INNERTUBE_BASE = 'https://www.youtube.com/youtubei/v1';
const SEARCH_RESULTS_URL = 'https://www.youtube.com/results';
const MUSIC_SEARCH_URL = 'https://music.youtube.com/search';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 7_000;
const RESOLVE_BUDGET_MS = 25_000;
const RESOLVE_TIMEOUT_MESSAGE = 'no se pudo resolver el audio a tiempo (timeout)';
const MIN_CLIENT_BUDGET_MS = 2_500;

/**
 * Control de tiempo para una operación con presupuesto.
 * @param {number} budgetMs Milisegundos disponibles.
 */
function deadlineGuard(budgetMs) {
  const deadline = Date.now() + Math.max(1_000, budgetMs);
  return {
    remaining: () => deadline - Date.now(),
    expired: () => Date.now() >= deadline,
    // Timeout para el siguiente paso: nunca más que lo que queda de presupuesto.
    timeoutFor: (max) => Math.max(1_000, Math.min(max, deadline - Date.now())),
  };
}

// TTL de la caché de resolución.
const STREAM_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;

// ── Cachés en memoria del proceso serverless ──
const streamCache = new Map();
const searchCache = new Map(); 
const musicSearchCache = new Map();

function cacheGet(cache, key, ttl) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(cache, key, value) {
  cache.set(key, { value, at: Date.now() });
  // Poda FIFO simple: el Map conserva el orden de inserción.
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

export const MAX_UPSTREAM_RANGE_BYTES = 1024 * 1024;
export const STREAM_URL_FRESH_MS = 5 * 60 * 1000;

/**
 *
 * @param {{resolvedAt?: number}} resolved Resolución (`resolvedAt` en ms).
 * @param {number} [nowMs] Instante actual (inyectable para tests).
 * @returns {boolean} true si puede estar caducada (o si no se sabe: conservador).
 */
export function urlMayBeExpired(resolved, nowMs = Date.now()) {
  const at = Number(resolved?.resolvedAt) || 0;
  if (!at) return true; // sin marca de tiempo no se puede descartar la caducidad
  return nowMs - at > STREAM_URL_FRESH_MS;
}

/**
 * Convierte el `Range` del cliente en el rango acotado que se le pide a
 * googlevideo.
 *
 * @param {string|null|undefined} clientRange Rango pedido por el navegador.
 * @param {number} [contentLength] Tamaño real del audio (para no pedir de más).
 * @returns {string|null} `bytes=a-b` acotado, o null si el rango cae fuera del
 *   archivo (el proxy debe responder 416).
 */
export function upstreamRangeHeader(clientRange, contentLength = 0) {
  const chunk = MAX_UPSTREAM_RANGE_BYTES;
  const firstChunk = `bytes=0-${chunk - 1}`;
  // Sin Range (o multipart/formatos raros): basta el primer bloque, el navegador
  // seguirá pidiendo el resto.
  if (!clientRange) return firstChunk;

  const match = /^bytes=(\d+)-(\d*)$/i.exec(String(clientRange).trim());
  if (!match) return firstChunk;

  const start = Number(match[1]);
  const askedEnd = match[2] === '' ? start + chunk - 1 : Number(match[2]);
  // Nunca más de un bloque, y nunca más allá del final del archivo.
  let end = Math.min(askedEnd, start + chunk - 1);
  if (contentLength > 0) end = Math.min(end, contentLength - 1);

  if (end < start) return null; // pide empezar más allá del archivo → 416
  return `bytes=${start}-${end}`;
}

// ── Helpers de texto para el matching ──
// Palabras que aparecen en títulos de YouTube y ensucian la comparación.
const NOISE_WORDS =
  /(official|oficial|video|videoclip|audio|lyric|lyrics|letra|hd|hq|4k|remaster(ed)?|mv|m\/v|visualizer|prod\.?|explicit|full|album|version)/gi;

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // quita "(Official Video)", "[HD]"
    .replace(NOISE_WORDS, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // quita puntuación (conserva acentos)
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalizeText(text).split(' ').filter(Boolean);
}

/** Similitud simple de conjuntos de palabras (0..1). */
function similarity(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

/** "3:32" / "1:02:03" → segundos. */
export function parseDuration(text) {
  if (!text) return 0;
  const parts = String(text)
    .replace(/[^\d:]/g, '')
    .split(':')
    .map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Puntúa un candidato contra la canción buscada. La duración manda: es el
 * filtro que descarta covers, remixes y directos.
 */
export function scoreCandidate(candidate, track) {
  const { artist = '', title = '', duration = 0 } = track || {};
  const candTitle = candidate.title || '';
  const candChannel = candidate.channel || '';

  let score = 0;
  score += similarity(title, candTitle) * 0.55;
  score += similarity(`${artist} ${title}`, candTitle) * 0.25;
  if (artist) score += similarity(artist, candChannel) * 0.1;

  if (duration > 0 && candidate.durationSec > 0) {
    const diff = Math.abs(candidate.durationSec - duration);
    // ±4 s se considera el mismo track; después cae rápido.
    if (diff <= 4) score += 0.35;
    else if (diff <= 10) score += 0.15;
    else if (diff > 30) score -= 0.45;
  }
  return score;
}

/** Elige el mejor candidato (o null si ninguno supera el mínimo). */
export function pickBestCandidate(candidates, track) {
  let best = null;
  let bestScore = 0;
  for (const cand of candidates) {
    const score = scoreCandidate(cand, track);
    if (score > bestScore) {
      best = cand;
      bestScore = score;
    }
  }
  // Umbral: evita devolver cualquier cosa cuando la búsqueda no encontró nada
  // parecido (mejor 404 en el stream que reproducir una canción equivocada).
  return bestScore >= 0.45 ? best : null;
}

/**
 *
 * @param {Array} adaptiveFormats Formatos del player (streamingData).
 * @param {{ maxBytes?: number }} [options] Con `maxBytes` sólo se eligen
 */
export function pickAudioFormat(adaptiveFormats = [], { maxBytes = 0 } = {}) {
  const audio = adaptiveFormats.filter(
    (f) => String(f.mimeType || '').startsWith('audio/') && typeof f.url === 'string'
  );
  if (audio.length === 0) return null;

  const byItag = (itag) => audio.find((f) => String(f.itag) === String(itag));
  const byBitrate = (list) =>
    [...list].sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
  // Sin tamaño declarado no se puede garantizar que quepa: se descarta.
  const fits = (f) => Number(f.contentLength) > 0 && Number(f.contentLength) <= maxBytes;
  const m4a = byBitrate(audio.filter((f) => f.mimeType.includes('mp4')));

  const preferred = byItag(140) || byItag(251);
  if (preferred && (maxBytes <= 0 || fits(preferred))) return preferred;

  if (maxBytes > 0) {
    const m4aFits = m4a.find(fits);
    if (m4aFits) return m4aFits;
    const anyFits = byBitrate(audio).find(fits);
    if (anyFits) return anyFits;
  }

  return preferred || m4a[0] || audio[0];
}

// ── Llamadas a innertube ──

let requestChain = Promise.resolve();

function serialize(fn) {
  const run = requestChain.then(fn, fn);
  // La cadena no debe romperse si una llamada falla.
  requestChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function innertubeRequest(endpoint, body, apiClient, timeoutMs = REQUEST_TIMEOUT_MS) {
  const url = `${INNERTUBE_BASE}/${endpoint}?key=${apiClient.key}&prettyPrint=false`;

  const res = await serialize(() =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': apiClient.userAgent,
        Origin: 'https://www.youtube.com',
        'X-Goog-Api-Format-Version': '2',
      },
      body: JSON.stringify({ context: { client: apiClient.client }, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  );
  if (!res.ok) throw new Error(`${apiClient.name} HTTP ${res.status}`);
  return res.json();
}

const VIDEO_RENDERER_KEYS = ['videoRenderer', 'compactVideoRenderer'];

function textOf(node) {
  if (!node) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
  return '';
}

function durationOf(renderer) {
  if (renderer.lengthSeconds) return Number(renderer.lengthSeconds) || 0;
  return parseDuration(textOf(renderer.lengthText));
}

/** Recorre el árbol de respuesta juntando los videos del search. */
function collectVideoRenderers(node, out, seen) {
  if (!node || typeof node !== 'object') return out;

  for (const key of VIDEO_RENDERER_KEYS) {
    const v = node[key];
    if (v?.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      out.push({
        videoId: v.videoId,
        title: textOf(v.title),
        channel: textOf(v.ownerText) || textOf(v.longBylineText) || textOf(v.shortBylineText),
        durationSec: durationOf(v),
      });
    }
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') collectVideoRenderers(value, out, seen);
  }
  return out;
}

/**
 * Búsqueda por la página de resultados (ytInitialData).
 * Devuelve candidatos normalizados { videoId, title, channel, durationSec }.
 */
async function searchViaResultsPage(query, limit, timeoutMs = REQUEST_TIMEOUT_MS) {
  const url =
    `${SEARCH_RESULTS_URL}?search_query=${encodeURIComponent(query)}&hl=en&gl=US`;
  const res = await serialize(() =>
    fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  );
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);

  const html = await res.text();
  const match = html.match(/var ytInitialData = (\{.+?\});<\/script>/s);
  if (!match) throw new Error('no se pudo leer la búsqueda de YouTube');

  const data = JSON.parse(match[1]);
  return collectVideoRenderers(data, [], new Set()).slice(0, limit);
}

/*
 * Busca videos en YouTube.
 */
export async function searchTracks(query, { limit = 10, fresh = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const cacheKey = `${q.toLowerCase()}|${limit}`;
  if (!fresh) {
    const cached = cacheGet(searchCache, cacheKey, SEARCH_CACHE_TTL_MS);
    if (cached) return cached;
  }

  const results = await searchViaResultsPage(q, limit, timeoutMs);
  if (results.length > 0) cacheSet(searchCache, cacheKey, results);
  return results;
}

// ── Búsqueda en el catálogo de YouTube Music ──

/** Decodifica escapes JS (\x7b, \u2022, …) de un string embebido en el HTML. */
function decodeJsString(value) {
  return value.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (match, escape) => {
    if (escape[0] === 'x' || escape[0] === 'u') return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (escape === 'n') return '\n';
    if (escape === 'r') return '\r';
    if (escape === 't') return '\t';
    return escape;
  });
}

/** Extrae el initialData de la búsqueda de YouTube Music del HTML. */
function musicSearchDataFromHtml(html) {
  const re = /initialData\.push\(\{path:\s*'([^']+)',[\s\S]*?data:\s*'((?:[^'\\]|\\.)*)'\}\)/g;
  for (const match of html.matchAll(re)) {
    if (!match[1].includes('search')) continue;
    try {
      return JSON.parse(decodeJsString(match[2]));
    } catch {
      return null;
    }
  }
  return null;
}

/** Recorre el árbol del initialData juntando los items de la lista. */
function collectMusicItems(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectMusicItems(child, out);
    return out;
  }
  if (node.musicResponsiveListItemRenderer) out.push(node.musicResponsiveListItemRenderer);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectMusicItems(value, out);
  }
  return out;
}

const MUSIC_ARTIST_PAGE = 'MUSIC_PAGE_TYPE_ARTIST';
const MUSIC_SONG_TYPES = new Set(['MUSIC_VIDEO_TYPE_ATV', 'MUSIC_VIDEO_TYPE_OMV']);

/** Convierte un musicResponsiveListItemRenderer en un track de canción. */
function musicItemToTrack(renderer) {
  const raw = JSON.stringify(renderer);
  const types = [...raw.matchAll(/"musicVideoType":"([^"]+)"/g)].map((m) => m[1]);
  if (!types.some((type) => MUSIC_SONG_TYPES.has(type))) return null;

  const columns = (renderer.flexColumns || [])
    .map((column) => column.musicResponsiveListItemFlexColumnRenderer?.text)
    .filter(Boolean);

  const title = textOf(columns[0]).trim();
  if (!title) return null;

  const subtitleRuns = columns[1]?.runs || [];
  // El artista es el run con página de artista; si no hubiera, el segundo
  // bloque del subtítulo ("Song • Artista • …").
  const artist = subtitleRuns
    .filter((run) => run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === MUSIC_ARTIST_PAGE)
    .map((run) => run.text)
    .filter(Boolean)
    .join(', ')
    || textOf(columns[1]).split('•')[1]?.trim()
    || '';

  const videoId =
    renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
    || renderer.playlistItemData?.videoId
    || columns[0]?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;

  const getThumbs = (node) => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node.thumbnails)) return node.thumbnails;
    if (node.musicThumbnailRenderer?.thumbnail) {
      const t = node.musicThumbnailRenderer.thumbnail;
      if (Array.isArray(t.thumbnails)) return t.thumbnails;
      if (Array.isArray(t)) return t;
    }
    if (node.thumbnail) return getThumbs(node.thumbnail);
    if (node.musicThumbnailRenderer) return getThumbs(node.musicThumbnailRenderer);
    return [];
  };

  const thumbnails = getThumbs(renderer.thumbnail) || getThumbs(renderer);
  const artwork = (thumbnails[thumbnails.length - 1]?.url) || (thumbnails[0]?.url) || '';

  const durationText = subtitleRuns
    .map((run) => run.text)
    .find((text) => /^\d{1,3}(?::\d{2}){1,2}$/.test(text || ''));
  const durationSec = durationText
    ? durationText.split(':').map(Number).reduce((acc, part) => acc * 60 + part, 0)
    : 0;

  return { videoId, title, artist, artwork, durationSec };
}

export async function searchYouTubeMusic(query, { limit = 10, fresh = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  const cacheKey = `${q.toLowerCase()}|${limit}`;
  if (!fresh) {
    const cached = cacheGet(musicSearchCache, cacheKey, SEARCH_CACHE_TTL_MS);
    if (cached) return cached;
  }

  const url = `${MUSIC_SEARCH_URL}?q=${encodeURIComponent(q)}&hl=en&gl=US`;
  const res = await serialize(() =>
    fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  );
  if (!res.ok) throw new Error(`music search HTTP ${res.status}`);

  const html = await res.text();
  const data = musicSearchDataFromHtml(html);
  if (!data) throw new Error('no se pudo leer la búsqueda de YouTube Music');

  const tracks = [];
  const seen = new Set();
  for (const renderer of collectMusicItems(data, [])) {
    const track = musicItemToTrack(renderer);
    if (!track || seen.has(track.videoId)) continue;
    seen.add(track.videoId);
    tracks.push(track);
    if (tracks.length >= limit) break;
  }

  if (tracks.length > 0) cacheSet(musicSearchCache, cacheKey, tracks);
  return tracks;
}

export async function resolveVideoAudio(videoId, { budgetMs = 0 } = {}) {
  if (!videoId) throw new Error('resolveVideoAudio: falta videoId');

  const guard = budgetMs > 0 ? deadlineGuard(budgetMs) : null;
  const failures = [];
  let budgetCut = false;
  let tooBig = null;
  let bestEffort = null;

  for (const apiClient of CLIENTS) {
    if (guard && (guard.expired() || guard.remaining() < MIN_CLIENT_BUDGET_MS)) {
      budgetCut = true;
      break;
    }

    let json;
    try {
      json = await innertubeRequest(
        'player',
        { videoId, contentCheckOk: true, racyCheckOk: true },
        apiClient,
        guard ? guard.timeoutFor(REQUEST_TIMEOUT_MS) : REQUEST_TIMEOUT_MS
      );
    } catch (err) {
      failures.push(`${apiClient.name}: ${err.message}`);
      continue;
    }

    const status = json?.playabilityStatus?.status;
    if (status && status !== 'OK') {
      const reason = json?.playabilityStatus?.reason || `no reproducible (${status})`;
      failures.push(`${apiClient.name}: ${reason}`);
      continue;
    }

    const formats = json?.streamingData?.adaptiveFormats;
    const best = pickAudioFormat(formats);
    const muxed = pickMuxedFormat(json?.streamingData?.formats);
    const audioOnly = pickAudioFormat(formats, { maxBytes: MAX_UPSTREAM_RANGE_BYTES });
    const audioOnlyLength = Number(audioOnly?.contentLength) || 0;
    const audioOnlyFits = audioOnlyLength > 0 && audioOnlyLength <= MAX_UPSTREAM_RANGE_BYTES;
    const format = audioOnlyFits || !muxed ? audioOnly : muxed;
    if (!format) {
      failures.push(`${apiClient.name}: sin formatos de audio con URL directa`);
      continue;
    }
    const isMuxed = format === muxed;

    const contentLength = Number(format.contentLength) || 0;
    const entry = {
      url: format.url,
      mimeType: String(format.mimeType || 'audio/mp4').split(';')[0],
      codecs: /codecs="([^"]+)"/.exec(format.mimeType || '')?.[1] || null,
      itag: format.itag,
      contentLength,
      videoId,
      title: json?.videoDetails?.title || '',
      client: apiClient.name,
      playable: isMuxed || (contentLength > 0 && contentLength <= MAX_UPSTREAM_RANGE_BYTES),
      degraded: !!best && String(best.itag) !== String(format.itag),
      fallbackUrl: isMuxed ? null : muxed?.url || null,
      fallbackLength: isMuxed ? 0 : Number(muxed?.contentLength) || 0,
    };

    if (entry.playable && (isMuxed || entry.fallbackUrl)) return entry;
    if (entry.playable) {
      if (!bestEffort) bestEffort = entry;
      continue;
    }
    if (!tooBig) tooBig = entry;
  }

  if (bestEffort) return bestEffort;
  if (tooBig) return tooBig;
  if (guard?.expired() || budgetCut) throw new Error(RESOLVE_TIMEOUT_MESSAGE);
  throw new Error(`no se pudo resolver el audio (${failures.join(' | ')})`);
}

export function pickMuxedFormat(streamingFormats = []) {
  const muxed = streamingFormats.filter(
    (f) => typeof f.url === 'string' && String(f.mimeType || '').startsWith('video/')
  );
  if (muxed.length === 0) return null;

  const byItag = (itag) => muxed.find((f) => String(f.itag) === String(itag));
  return (
    byItag(18) ||
    byItag(22) ||
    [...muxed].sort((a, b) => Number(a.bitrate || 0) - Number(b.bitrate || 0))[0]
  );
}

/**
 * Marca la resolución cacheada de una pista para que el stream use el muxed
 * (`fallbackUrl`) en vez del audio-only. Queda *sticky* en la caché del proceso:
 * el CDN ya dijo que no da más de esa URL, así que los siguientes bloques y los
 * seek deben leer el MISMO archivo (y el mismo espacio de offsets).
 *
 * @param {{artist?: string, title: string, duration?: number}} track
 * @returns {boolean} true si la pista tenía fallback y quedó marcada.
 */
/**
 * Fuente activa de una resolución: el MUXED (`fallbackUrl`) si ya se cayó a él,
 * si no el formato elegido. El muxed es OTRO archivo (más grande), así que
 * devuelve también su tamaño: los offsets que pida el cliente pasan a ser los
 * suyos y el `Content-Range` que se le reenvía es el del archivo servido.
 *
 * @param {{url: string, contentLength?: number, fallbackUrl?: string|null, fallbackLength?: number, useFallback?: boolean}} resolved
 */
export function activeStreamSource(resolved) {
  if (resolved?.useFallback && resolved?.fallbackUrl) {
    return { url: resolved.fallbackUrl, contentLength: resolved.fallbackLength || 0 };
  }
  return { url: resolved?.url, contentLength: resolved?.contentLength || 0 };
}

export function isResolveTimeout(err) {
  return /a tiempo \(timeout\)/.test(err?.message || '');
}

export function markStreamFallback(track) {
  const hit = streamCache.get(trackKey(track));
  if (!hit?.value?.fallbackUrl) return false;
  hit.value.useFallback = true;
  return true;
}

function trackKey({ artist = '', title = '', duration = 0 }) {
  return `${normalizeText(artist)}|${normalizeText(title)}|${Math.round(duration) || 0}`;
}

/**
 * Flujo completo para una canción: buscar el videoId y resolver el audio.
 * Cachea el resultado (la resolución es lo caro y las URLs duran horas).
 *
 * @param {{ artist?: string, title: string, duration?: number, videoId?: string }} track
 * @param {{ fresh?: boolean, budgetMs?: number }} [options]
 */
export async function resolveTrackAudio(track, { fresh = false, budgetMs = RESOLVE_BUDGET_MS } = {}) {
  const title = String(track?.title || '').trim();
  if (!title) throw new Error('resolveTrackAudio: falta title');

  const key = trackKey(track);
  if (!fresh) {
    const cached = cacheGet(streamCache, key, STREAM_CACHE_TTL_MS);
    if (cached) return { ...cached, cached: true };
  }

  const guard = deadlineGuard(budgetMs);

  let videoId = track?.videoId || null;
  if (!videoId) {
    const query = [track.artist, title].filter(Boolean).join(' ');
    let candidates;
    try {
      candidates = await searchTracks(query, {
        limit: 10,
        fresh,
        timeoutMs: guard.timeoutFor(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if (aborted || guard.expired()) throw new Error(RESOLVE_TIMEOUT_MESSAGE, { cause: err });
      throw err;
    }
    if (guard.expired()) throw new Error(RESOLVE_TIMEOUT_MESSAGE);
    const best = pickBestCandidate(candidates, track);
    if (!best) throw new Error('no se encontró una coincidencia razonable en YouTube');
    videoId = best.videoId;
  }

  const resolved = await resolveVideoAudio(videoId, { budgetMs: guard.remaining() });
  const value = {
    ...resolved,
    resolvedAt: Date.now(),
    track: { artist: track.artist || '', title, duration: track.duration || 0 },
  };
  cacheSet(streamCache, key, value);
  return value;
}

/** Estado del resolver (para /api/music/health). */
export function getInnertubeInfo() {
  return {
    provider: 'innertube',
    clients: CLIENTS.map((c) => `${c.name} ${c.client.clientVersion}`),
    cachedSearches: searchCache.size,
    cachedMusicSearches: musicSearchCache.size,
    cachedStreams: streamCache.size,
  };
}

/** Solo para tests/diagnóstico: limpia las cachés. */
export function clearInnertubeCaches() {
  streamCache.clear();
  searchCache.clear();
  musicSearchCache.clear();
}
