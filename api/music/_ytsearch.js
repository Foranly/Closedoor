/**
 * Buscador de canciones con innertube, acotado al catálogo de YouTube Music
 *
 * Uso: GET /api/music/ytsearch?q=daft%20punk%20get%20lucky&limit=8
 */

import { searchYouTubeMusic } from '../_innertube.js';
import { normalizeYouTubeTracks } from '../_music.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS },
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
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return jsonResponse({ success: false, error: 'Missing ?q parameter' }, 400);

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 10, 1), 20);

  try {
    const candidates = await searchYouTubeMusic(q, { limit });
    return jsonResponse({
      success: true,
      provider: 'youtube',
      results: normalizeYouTubeTracks(candidates),
    });
  } catch (err) {
    console.warn('[music/ytsearch]', err?.message || err);
    return jsonResponse({ success: false, error: err?.message || 'YouTube search error' }, 502);
  }
}
