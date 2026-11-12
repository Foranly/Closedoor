/**
 * CSP Plugin — Content-Security-Policy estricta (solo build de producción)
 *
 * Inyecta un <meta http-equiv="Content-Security-Policy"> en el HTML del build
 * para que la política viaje en TODOS los hosts donde se sirva el bundle
 * (Vercel, server.js self-hosted, túneles) sin depender de headers HTTP.
 *
 * - apply: 'build' → en `vite dev` NO aplica (HMR necesita scripts inline
 *   y WebSocket de Vite; una CSP ahí rompería el dev server).
 * - Sin 'unsafe-eval' ni 'unsafe-inline' en script-src: el código de la app
 *   no usa eval/new Function, así que la protección contra XSS es real.
 * - style-src 'unsafe-inline' es OBLIGATORIO: inlineCssPlugin mete el CSS
 *   inline en el HTML y React usa style={{}} (no hay nonce viable aquí).
 * - La canción del perfil se sirve same-origin (/api/music/stream), así que 'self'
 *   ya la cubre: no hace falta ningún host de música ni túnel en connect-src.
 *   LiveKit Cloud → *.livekit.cloud.
 * - APP DE ESCRITORIO: carga esta misma web pero sirve /api/music/* desde
 *   127.0.0.1:5990 (desktop/, ver desktop/README.md). Chromium considera a
 *   127.0.0.1 un origen "potentially trustworthy" (no hay bloqueo de mixed
 *   content https→http loopback), pero la CSP SÍ hay que autorizarla — por eso
 *   el puerto es fijo: el cliente solo pide el puerto que aquí está permitido.
 *
 * ⚠️ MANTENER CONSISTENTE con la cabecera HTTP de vercel.json (la versión
 * HTTP añade frame-ancestors 'none', que la meta tag no soporta).
 */

// ── Construir la política desde el entorno real ──
function buildCSP() {
  const supabaseUrl =
    process.env.VITE_SUPABASE_URL ||
    process.env.VITE_SUPABASE_DATA_API_URL ||
    '';
  const cdnUrl = process.env.VITE_CDN_URL || '';

  let supabaseOrigin = '';
  try { supabaseOrigin = new URL(supabaseUrl).origin; } catch {}
  const supabaseWss = supabaseOrigin ? `wss://${new URL(supabaseOrigin).host}` : '';

  let cdnOrigin = '';
  try { cdnOrigin = new URL(cdnUrl).origin; } catch {}
  // El CDN también se consume same-origin vía rewrite /cdn/* (Vercel) y
  // proxy (vite dev), así que 'self' ya lo cubre; el origin explícito
  // cubre el caso en que VITE_CDN_URL apunte directo al servidor.

  // Loopback de la app de escritorio (servidor de música local). Duplicado a
  // propósito como literal: lo comparten connect-src y media-src.
  const desktopLoopback = ['http://127.0.0.1:5990', 'http://localhost:5990'];

  const connect = [
    "'self'",
    supabaseOrigin, supabaseWss,
    cdnOrigin,
    ...desktopLoopback,
    // Búsqueda de música: iTunes directo desde el navegador (los previews de
    // Deezer van por el proxy same-origin /api/music-search).
    'https://itunes.apple.com',
    // Extracción de colores (services/colorExtractor): último recurso cuando la
    // imagen no se puede leer directamente por CORS. Sin esto, la CSP bloquea
    // la petición y el acento del fondo del chat (y los colores de banners
    // externos) cae siempre a la paleta por defecto.
    'https://wsrv.nl',
    'https://api.klipy.com',
    // Endpoint interno de Google Translate (services/postTranslation): el
    // respaldo que traduce los posts en navegadores sin `Translator`
    // (Brave/Firefox/Safari). El endpoint responde con CORS abierto.
    'https://clients5.google.com',
    'https://challenges.cloudflare.com',
    // LiveKit Cloud (el server devuelve la URL real en /api/livekit-token)
    'https://*.livekit.cloud', 'wss://*.livekit.cloud',
  ].filter(Boolean);

  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    // `https:` cubre los previews (Deezer/iTunes); el loopback, el audio
    // completo que sirve la app de escritorio.
    `media-src 'self' blob: https: ${desktopLoopback.join(' ')}`,
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "frame-src 'self' https://challenges.cloudflare.com https://www.youtube.com https://player.vimeo.com",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function cspPlugin() {
  return {
    name: 'inject-csp',
    apply: 'build', // SOLO build de producción; dev sin CSP (HMR)
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: buildCSP(),
          },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

// Reutilizable si algún día se genera la política dinámicamente en server.js
export { buildCSP };
