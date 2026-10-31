/**
 * Vercel serverless function — estado del stream de música.
 *
 * Antes informaba el estado del music server externo (yt-dlp/ffmpeg/túnel).
 * Ahora el stream Y la búsqueda salen de innertube dentro de esta misma app, así
 * que el health reporta el cliente en uso y el estado de las cachés.
 *
 * Uso: GET /api/music/health
 */

import { getInnertubeInfo } from '../_innertube.js';
const BUILD = 'music-5';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      build: BUILD,
      stream: 'innertube',
      search: 'innertube',
      ...getInnertubeInfo(),
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS },
    }
  );
}
