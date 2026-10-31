/**
 * api/_musicHttp.js — la superficie HTTP de música, para servidores Node.
 *
 * Existe para que las MISMAS rutas de música se puedan servir desde tres sitios
 * sin duplicar lógica ni adaptadores:
 *
 *   1. `plugins/musicDevApiPlugin.js`      → `npm run dev` (vite, :5173)
 *   2. `scripts/music-api-server.mjs`      → host propio (rewrite de Vercel)
 *   3. el rewrite de Vercel (`/api/music/(.*)` → host propio) en produccion
 *
 * Rutas: /api/music/health, /api/music/resolve, /api/music/stream,
 *         /api/music/ytsearch (búsqueda innertube) y /api/music/search
 *         (alias de metadatos Deezer/iTunes).
 *
 * Los handlers de `api/music/*.js` son Web-standard ((Request) => Response), así
 * que aquí se convierten a los `(req, res)` de Node http / Connect. El audio se
 * pipea (no se bufferiza) para que el <audio> pueda hacer streaming y seek.
 *
 * No es una función serverless (empieza por `_`, convención que Vercel ya usa
 * en este proyecto para `_innertube.js`, `_music.js`, `_livekit.js`, `_sitemap.js`).
 */

import { Readable } from 'node:stream';
import healthHandler from './music/_health.js';
import resolveHandler from './music/_resolve.js';
import streamHandler from './music/_stream.js';
import ytSearchHandler from './music/_ytsearch.js';
import { searchMusicServer, resolveTrackPreview } from './_music.js';

/** Rutas con handler Web-standard ((req) => Response). */
const WEB_HANDLERS = new Map([
  ['/api/music/health', healthHandler],
  ['/api/music/resolve', resolveHandler],
  ['/api/music/stream', streamHandler],
  ['/api/music/ytsearch', ytSearchHandler],
]);

/** Alias de búsqueda de metadatos (server.js expone las dos). */
const SEARCH_PATHS = new Set(['/api/music-search', '/api/music/search']);

/** Cabeceras que no deben reenviarse tal cual al cliente. */
const HOP_BY_HOP = new Set(['content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

function absoluteUrl(req, fallbackHost = 'localhost') {
  const host = req.headers.host || fallbackHost;
  return new URL(req.url || '/', `http://${host}`).toString();
}

/** IncomingMessage → Request (solo GET/HEAD/OPTIONS: no hay body que copiar). */
export function toWebRequest(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(absoluteUrl(req), { method: req.method, headers });
}

/** Response → ServerResponse, pipeando el cuerpo (importante para el audio). */
export function sendWebResponse(req, res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
  });

  // Chromium pide esta cabecera cuando una página pública (app.foranly.space)
  // llama a la red local: es el caso de la app de escritorio, cuyo servidor de
  // música escucha en 127.0.0.1:5990 (desktop/README.md). En el resto de usos es
  // inofensiva: solo la mira el preflight de Private Network Access.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'HEAD' || !response.body) {
    res.end();
    return;
  }

  const body = Readable.fromWeb(response.body);
  // Si el cliente corta (p. ej. el <audio> cambia de src), liberar el upstream.
  res.on('close', () => body.destroy());
  body.on('error', () => res.destroy());
  body.pipe(res);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Misma respuesta que api/music-search.js y la ruta de server.js. */
export async function handleMusicSearch(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { success: false, error: 'Method not allowed' });
    return;
  }

  const url = new URL(absoluteUrl(req));
  const provider = url.searchParams.get('provider') === 'itunes' ? 'itunes' : 'deezer';

  // Modo track: preview FRESCO de Deezer (los previews expiran ≈ 15 min).
  const trackId = url.searchParams.get('track');
  if (trackId) {
    try {
      const previewUrl = await resolveTrackPreview(trackId, provider);
      sendJson(res, 200, { success: true, provider, previewUrl });
    } catch (err) {
      console.warn('[music-http] preview resolve:', err?.message || err);
      sendJson(res, 502, { success: false, error: err?.message || 'Deezer error' });
    }
    return;
  }

  const q = (url.searchParams.get('q') || '').trim();
  if (!q) {
    sendJson(res, 400, { success: false, error: 'Missing ?q parameter' });
    return;
  }

  try {
    const results = await searchMusicServer(q, provider, url.searchParams.get('limit'));
    sendJson(res, 200, { success: true, provider, results });
  } catch (err) {
    console.warn('[music-http] search:', err?.message || err);
    sendJson(res, 502, { success: false, error: err?.message || 'Music search error' });
  }
}

/**
 * Crea el listener de la superficie de música.
 *
 * @param {{ onRequest?: (info: {path: string, status: number, ms: number}) => void }} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}
 *          `true` si la ruta era de música (y ya se respondió); `false` si no.
 */
export function createMusicRequestListener({ onRequest } = {}) {
  return async function handleMusicRequest(req, res) {
    const path = (req.url || '').split('?')[0];
    const handler = WEB_HANDLERS.get(path);
    const isSearch = SEARCH_PATHS.has(path);
    if (!handler && !isSearch) return false;

    const started = Date.now();
    const done = (status) => {
      if (onRequest) onRequest({ path, status, ms: Date.now() - started });
    };

    // Para saber el estado real en el log sin envolver el res.
    res.on('finish', () => done(res.statusCode));

    try {
      if (isSearch) {
        await handleMusicSearch(req, res);
        return true;
      }
      sendWebResponse(req, res, await handler(toWebRequest(req)));
      return true;
    } catch (err) {
      console.warn('[music-http]', path, err?.message || err);
      if (!res.headersSent) {
        sendJson(res, 502, { success: false, error: err?.message || 'Music API error' });
      } else {
        res.destroy();
      }
      return true;
    }
  };
}
