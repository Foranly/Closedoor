/**
 * Vercel serverless function — stream de audio de una canción.
 *
 * Uso:
 *   GET /api/music/stream?artist=Daft%20Punk&title=Get%20Lucky&duration=248
 *   GET /api/music/stream?videoId=dQw4w9WgXcQ          (atajo si ya se conoce)
 *   GET /api/music/stream?artist=…&title=…&prewarm=1   (resuelve SIN audio)
 */

import {
  resolveTrackAudio,
  upstreamRangeHeader,
  urlMayBeExpired,
  markStreamFallback,
  isResolveTimeout,
  activeStreamSource as activeSource,
} from '../_innertube.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

const AUDIO_TIMEOUT_MS = 10_000;
const RESOLVE_BUDGET_FIRST_MS = 20_000;
const RESOLVE_BUDGET_RETRY_MS = 12_000;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Trae el audio del CDN de YouTube con un rango ACOTADO.
 */
async function fetchAudio(streamUrl, rangeHeader, userAgent) {
  const headers = { Range: rangeHeader };
  if (userAgent) headers['User-Agent'] = userAgent;

  return fetch(streamUrl, {
    headers,
    signal: AbortSignal.timeout(AUDIO_TIMEOUT_MS),
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  const url = new URL(req.url, 'https://app.foranly.space');
  const artist = url.searchParams.get('artist') || '';
  const title = (url.searchParams.get('title') || '').trim();
  const videoId = url.searchParams.get('videoId') || '';
  const duration = Number(url.searchParams.get('duration')) || 0;
  const prewarm = url.searchParams.get('prewarm') === '1';

  if (!title && !videoId) {
    return jsonResponse({ success: false, error: 'Falta ?title o ?videoId' }, 400);
  }

  // ── Resolver (con caché en memoria del proceso) ──
  let resolved;
  try {
    resolved = await resolveTrackAudio(
      { artist, title, duration, videoId },
      { budgetMs: RESOLVE_BUDGET_FIRST_MS }
    );
  } catch (err) {
    const notFound = /coincidencia razonable/.test(err.message || '');
    const status = notFound ? 404 : isResolveTimeout(err) ? 504 : 502;
    return jsonResponse(
      { success: false, error: err.message || 'No se pudo resolver el stream' },
      status
    );
  }

  // ── Pre-warm: resolver y cachear en ESTA instancia, sin tocar el CDN ──
  if (prewarm) {
    return jsonResponse({
      success: true,
      prewarm: true,
      videoId: resolved.videoId,
      itag: resolved.itag,
      mimeType: resolved.mimeType,
      contentLength: resolved.contentLength,
      playable: resolved.playable !== false,
      degraded: !!resolved.degraded,
      cached: !!resolved.cached,
    });
  }

  // ── Traer el audio ──
  const source = { ...activeSource(resolved) };
  let upstreamRange = upstreamRangeHeader(req.headers.get('range'), source.contentLength);
  if (upstreamRange === null) {
    return jsonResponse({ success: false, error: 'Rango fuera del archivo' }, 416);
  }
  const isFirstChunk = upstreamRange.startsWith('bytes=0-');
  const userAgent = req.headers.get('user-agent');

  let upstream;
  try {
    upstream = await fetchAudio(source.url, upstreamRange, userAgent);

    // Reintento 1: la URL pudo caducar (tiene horas) → resolver de nuevo y
    // repetir. Un 403 en el primer bloque de una URL recién resuelta NO es
    // caducidad (es el allowance del CDN por URL: ver _innertube.js).
    if ((upstream.status === 403 || upstream.status === 410) && isFirstChunk && urlMayBeExpired(resolved)) {
      resolved = await resolveTrackAudio(
        { artist, title, duration, videoId },
        { fresh: true, budgetMs: RESOLVE_BUDGET_RETRY_MS }
      );
      const retrySource = activeSource(resolved);
      upstreamRange = upstreamRangeHeader(req.headers.get('range'), retrySource.contentLength) ?? upstreamRange;
      upstream = await fetchAudio(retrySource.url, upstreamRange, userAgent);
    }

    // Reintento 2: el CDN no da más de esa URL y hay MUXED disponible → se sirve
    // desde el muxed, que no está limitado por rango. Queda marcado en la caché
    // para que los siguientes bloques y los seek lean el mismo archivo.
    if (
      (upstream.status === 403 || upstream.status === 410) &&
      isFirstChunk &&
      resolved.fallbackUrl &&
      !resolved.useFallback &&
      markStreamFallback({ artist, title, duration })
    ) {
      resolved = { ...resolved, useFallback: true };
      const fallbackSource = activeSource(resolved);
      upstreamRange = upstreamRangeHeader(req.headers.get('range'), fallbackSource.contentLength) ?? upstreamRange;
      upstream = await fetchAudio(fallbackSource.url, upstreamRange, userAgent);
    }
  } catch (err) {
    return jsonResponse(
      { success: false, error: `Audio no disponible: ${err.message}` },
      isResolveTimeout(err) ? 504 : 502
    );
  }

  if (!upstream.ok && upstream.status !== 206) {
    const blocked = upstream.status === 403 || upstream.status === 410;
    return jsonResponse(
      {
        success: false,
        error: blocked
          ? 'YouTube no entrega más audio de esta canción desde esta IP'
          : `El CDN de YouTube respondió ${upstream.status}`,
      },
      blocked ? 502 : upstream.status
    );
  }

  // ── Pasar la respuesta tal cual (206 con Range, 200 sin él) ──
  const headers = {
    'Content-Type': upstream.headers.get('content-type') || resolved.mimeType || 'audio/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  };
  for (const header of ['content-length', 'content-range']) {
    const value = upstream.headers.get(header);
    if (value) headers[header === 'content-length' ? 'Content-Length' : 'Content-Range'] = value;
  }

  if (req.method === 'HEAD') {
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
