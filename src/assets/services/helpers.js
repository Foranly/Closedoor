// ── Constants ──
export const DEFAULT_AVATAR =
  'https://i.pinimg.com/736x/ac/13/74/ac137456b996efec340292a585eb6dc7.jpg';

export const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|svg)(\?.*)?$|\/cdn\/files\//i;
export const VID_RE = /\.(mp4|webm|ogg)(\?.*)?$/i;
export const VID_RE_EXTENDED = /\.(mp4|webm|ogg|mov|avi|mkv)(\?.*)?$/i;

export const URL_PATTERN = /(https?:\/\/[^\s<]+)/gi;
export const YOUTUBE_PATTERN = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/;
export const VIMEO_PATTERN = /vimeo\.com\/(\d+)/;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── UUID detection ──
export function isUUID(str) {
  return UUID_RE.test(str);
}

// ── Relative time formatting ──
export function getTimeAgo(t, locale, dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return t('post.just_now');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('post.minutes_ago', { n: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('post.hours_ago', { n: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return t('post.days_ago', { n: diffDay });
  return new Date(dateStr).toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', {
    day: 'numeric',
    month: 'short',
  });
}

// ── Hora de publicación (se añade al día en el detalle del post) ──
export function formatClockTime(dateStr, locale, hour24 = true) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(locale || 'es', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: !hour24,
  });
}

// ── Fecha y hora completas (tooltip de la hora del post) ──
export function formatFullDate(dateStr, locale, hour24 = true) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale || 'es', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: !hour24,
  });
}

// ── WCAG contrast text color ──
export function getContrastText(hex) {
  if (!hex) return '#000000';
  let r, g, b;
  if (hex.startsWith('#')) {
    const h = hex.slice(1);
    if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
    } else {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
  } else {
    return '#000000';
  }
  const srgb = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

// ── Extract URLs from text (absolute HTTP URLs + relative CDN paths) ──
export function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(URL_PATTERN) || [];
  // También extraer rutas relativas del CDN: /cdn/files/xxx
  const cdnMatches = text.match(/\/cdn\/files\/[^\s<]+/gi) || [];
  // Combinar y deduplicar
  const all = [...matches];
  for (const cdn of cdnMatches) {
    if (!all.includes(cdn)) all.push(cdn);
  }
  return all;
}

// ── URL sanitization (anti-XSS) ──
// Solo protocolos seguros. javascript:, data:, vbscript: y otros
// protocolos peligrosos se neutralizan para evitar ejecución de scripts.
// Sin los dos puntos: el regex de isSafeUrl captura el esquema sin ':' (ej. 'https')
const SAFE_URL_PROTOCOLS = new Set(['http', 'https', 'mailto']);

export function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // Los caracteres de control (C0, DEL) son inválidos en URLs y permiten
  // evadir el chequeo de protocolo: el navegador los elimina antes de
  // parsear el esquema (ej. "\u0000javascript:..." se vuelve "javascript:").
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;
  // Rutas relativas internas (perfil, posts, CDN) — no ejecutan scripts
  if (trimmed.startsWith('/')) return true;
  // Protocolo explícito → debe estar en la lista blanca
  const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (match) {
    return SAFE_URL_PROTOCOLS.has(match[1].toLowerCase());
  }
  // Sin protocolo → se resuelve como ruta relativa o se completa con https
  return true;
}

export function sanitizeUrl(url, fallback = '') {
  if (!isSafeUrl(url)) return fallback;
  const trimmed = url.trim();
  // URLs sin protocolo explícito y que no son rutas internas ("/") se
  // resuelven como rutas relativas del propio dominio (ej. href="x.com/u"
  // abriría app.foranly.space/x.com/u). Se completan con https:// para
  // que apunten al sitio externo. Rutas internas ("/...") se mantienen.
  if (!trimmed.startsWith('/') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

// ── Content sanitization (anti-XSS al guardar) ──
// La app es de texto plano: mentions/hashtags son texto, no HTML. Se eliminan
// tags peligrosos y atributos de eventos para que el contenido no pueda
// transportar scripts, incluso si un futuro render path no escapara.
export function sanitizeContent(text) {
  if (typeof text !== 'string' || !text) return text || '';
  let out = text;
  // 1) Eliminar bloques <script>…</script> completos (con su contenido)
  out = out.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '');
  // 2) Eliminar tags peligrosos (apertura y cierre), conservando el texto interior
  out = out.replace(/<\s*\/?\s*(?:script|iframe|object|embed|link|meta|base|style|form|template|svg|math)\b[^>]*>/gi, '');
  // 3) Eliminar TODOS los atributos de eventos (onclick, onerror, …) de tags restantes
  out = out.replace(/<[a-zA-Z][^>]*>/gi, (tag) =>
    tag.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  );
  // 4) Neutralizar protocolos peligrosos DENTRO de atributos href/src:
  //    <a href="javascript:..."> se convierte en <a href=""> (el valor se
  //    vacía por completo, no solo se quita el prefijo). Va ANTES del paso 5
  //    para que el protocolo aún esté presente cuando se vacía el atributo.
  out = out.replace(/(\s+(?:href|src|action|formaction)\s*=\s*["'])(?:javascript|vbscript|data):[^"']*(["'])/gi, '$1$2');
  // 5) Neutralizar protocolos peligrosos en texto plano (javascript:, vbscript:, data:)
  out = out.replace(/\b(?:javascript|vbscript|data):/gi, '');
  return out;
}

// ── Detect media type from text content (auto-detection) ──
export function detectMediaFromContent(text) {
  const urls = extractUrls(text);
  let imageUrl = null;
  let videoUrl = null;

  for (const url of urls) {
    if (videoUrl && imageUrl) break;
    if (!videoUrl && (VID_RE.test(url) || YOUTUBE_PATTERN.test(url) || VIMEO_PATTERN.test(url))) {
      videoUrl = url;
    }
    if (!imageUrl && IMG_RE.test(url)) {
      imageUrl = url;
    }
  }

  return { imageUrl, videoUrl };
}

// ── Get embed URL for YouTube/Vimeo ──
export function getEmbedUrl(url) {
  if (!url) return null;
  const yt = url.match(YOUTUBE_PATTERN);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vm = url.match(VIMEO_PATTERN);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return null;
}

// ── Check if URL is a video ──
export function isVideoUrl(url) {
  if (!url) return false;
  const videoExts = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv'];
  const lower = url.toLowerCase();
  return videoExts.some((ext) => lower.includes(ext)) || lower.includes('youtube.com') || lower.includes('youtu.be') || lower.includes('vimeo.com');
}

// ── Image position helpers ──
// Format: JSON string { x: 0-100, y: 0-100, zoom: 1-3 }
// Legacy: "X% Y%" string (no zoom, defaults to zoom=1)

export function parseImagePosition(pos) {
  if (!pos) return { x: 50, y: 50, zoom: 1 };

  // Try JSON format
  if (pos.startsWith('{')) {
    try {
      const parsed = JSON.parse(pos);
      return {
        x: typeof parsed.x === 'number' ? parsed.x : 50,
        y: typeof parsed.y === 'number' ? parsed.y : 50,
        zoom: typeof parsed.zoom === 'number' ? parsed.zoom : 1,
      };
    } catch {}
  }

  // Legacy "X% Y%" format
  const legacy = String(pos).match(/(\d+(?:\.\d+)?)\s*%\s*(\d+(?:\.\d+)?)\s*%/);
  if (legacy) {
    return { x: parseFloat(legacy[1]), y: parseFloat(legacy[2]), zoom: 1 };
  }

  return { x: 50, y: 50, zoom: 1 };
}

/**
 * Returns CSS styles to render a positioned image (avatar or banner).
 * Compatible with Avatar component (via style prop) and <img> elements.
 *
 * Usa object-fit: contain para mostrar la imagen COMPLETA en su ratio
 * original, igual que el editor. width/height: z*100% agranda el elemento
 * para el zoom, y la combinación de object-position: x% y% con
 * translate((50 - x*z)/z) posiciona el punto x% del CONTENIDO de la
 * imagen (no del elemento) en el centro del contenedor — exactamente
 * lo mismo que hace el editor con getContainedLayout, pero sin
 * necesitar las dimensiones naturales de la imagen.
 *
 * overflow:hidden en el contenedor padre clipea el excedente.
 */
export function getImageStyle(positionStr) {
  const p = parseImagePosition(positionStr || '');
  const z = Math.max(p.zoom, 1);

  const tx = ((50 - p.x * z) / z);
  const ty = ((50 - p.y * z) / z);

  return {
    objectFit: 'contain',
    objectPosition: `${p.x}% ${p.y}%`,
    transformOrigin: 'center center',
    width: `${z * 100}%`,
    height: `${z * 100}%`,
    maxWidth: 'none',
    maxHeight: 'none',
    transform: `translate(${tx}%, ${ty}%)`,
  };
}

/**
 * Returns background CSS style for a positioned profile background image.
 */
export function getBackgroundStyle(positionStr) {
  const p = parseImagePosition(positionStr || '');
  const z = Math.max(p.zoom, 1.05);
  return {
    backgroundPosition: `${p.x}% ${p.y}%`,
    backgroundSize: `${z * 100}%`,
    backgroundRepeat: 'no-repeat',
  };
}


/**
 * Error de rate limit devuelto por la DB (migración 092): los triggers lanzan
 * `rate_limited:<bucket>` con SQLSTATE P0001. Devuelve el bucket para poder
 * distinguir el contexto, o null si no es un error de límite.
 */
export function getRateLimitBucket(err) {
  const info = getRateLimitInfo(err);
  return info ? info.bucket : null;
}

/**
 * Info del rate limit: { bucket, retryAfter } donde retryAfter son los segundos
 * que faltan para reintentar (migración 093) o null si el servidor no lo envía.
 */
export function getRateLimitInfo(err) {
  const message = typeof err === 'string' ? err : err?.message || '';
  const match = /rate_limited:([a-z_]+)(?::(\d+))?/i.exec(message);
  if (!match) return null;
  return {
    bucket: match[1],
    retryAfter: match[2] ? Number(match[2]) : null,
  };
}

/** true si el error viene del rate limit de interacciones. */
export function isRateLimitError(err) {
  return getRateLimitInfo(err) !== null;
}
