import { useEffect, useState } from 'react';
import { FaImage } from 'react-icons/fa';
import { getCdnUrl } from '../../services/cdnService';
import { useI18n } from '../../services/i18n/useI18n';

/**
 * SafeImage — Wrapper around <img> that gracefully handles load errors.
 *
 * - Normaliza URLs del CDN automáticamente (previene Mixed Content).
 * - By default: shows a dark placeholder with an icon when the image fails.
 * - hideOnError: returns null when the image fails (no placeholder rendered).
 * - fallbackIcon: custom icon element for the placeholder.
 * - fallbackText: optional text shown alongside the icon.
 * - GIF: respeta la preferencia de Ajustes → Sistema → Rendimiento
 *   ('always' animado | 'hover' primer frame hasta el hover | 'never' congelado).
 *   El frame estático se extrae con canvas y se pinta como PNG en el mismo
 *   <img>, así el CSS de imágenes sigue aplicando igual. Requiere CORS en el
 *   origen del GIF; si falla, se muestra animado (nunca roto).
 *
 * All extra props (onClick, style, etc.) are forwarded to both <img> and the
 * fallback <div> so clicking/handling works in both states.
 */

const GIF_RE = /\.gif(?:[?#]|$)/i;
const WEBP_RE = /\.webp(?:[?#]|$)/i;
// Hosts que sirven WebP ANIMADO (Pinterest /vwebp/, KLIPY, Tenor, Giphy).
// Un .webp estático también funciona: el "poster" sale igual al original.
const ANIMATED_WEBP_HOST = /(^|\.)(klipy\.com|tenor\.com|giphy\.com|pinimg\.com)$/i;

function isAnimatedImage(url) {
  if (!url) return false;
  if (GIF_RE.test(url)) return true;
  if (!WEBP_RE.test(url)) return false;
  if (/\/vwebp\//i.test(url)) return true;
  try {
    return ANIMATED_WEBP_HOST.test(new URL(url, window.location.origin).hostname);
  } catch {
    return false;
  }
}

// ¿La URL ya dice qué formato tiene? Las subidas al CDN propio no
// (`/cdn/files/<hash>_avatar_...`), así que para avatares se mira la cabecera
// del archivo (GIF8 / RIFF....WEBP) con una petición Range de 32 bytes, cacheada.
function hasImageExtension(url) {
  return /\.[a-z0-9]{2,5}(?:[?#]|$)/i.test(url || '');
}

const sniffCache = new Map();

async function detectAnimatedFile(url) {
  if (sniffCache.has(url)) return sniffCache.get(url);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-31' }, cache: 'force-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const head = String.fromCharCode(...bytes.slice(0, 12));
    const animated = head.startsWith('GIF8')
      || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP');
    sniffCache.set(url, animated);
    return animated;
  } catch {
    sniffCache.set(url, false);
    return false;
  }
}

// Cache de primer frame por URL (data URL). Evita volver a decodificar el GIF
// cada vez que la tarjeta se monta o el cursor entra/sale.
const posterCache = new Map();
const POSTER_CACHE_MAX = 80;

function rememberPoster(url, dataUrl) {
  if (posterCache.size >= POSTER_CACHE_MAX) {
    const first = posterCache.keys().next().value;
    posterCache.delete(first);
  }
  posterCache.set(url, dataUrl);
}

export default function SafeImage({
  src,
  alt = '',
  className = '',
  hideOnError = false,
  fallbackIcon,
  fallbackText,
  onClick,
  style,
  onError: onErrorProp,
  sniffAnimated = false,
  ...rest
}) {
  const [hasError, setHasError] = useState(false);
  const { gifBehavior = 'always' } = useI18n();
  const [hovered, setHovered] = useState(false);

  // Normalizar URL del CDN para evitar Mixed Content
  const normalizedSrc = getCdnUrl(src);
  const [sniffedAnimated, setSniffedAnimated] = useState(
    () => sniffCache.get(normalizedSrc) === true
  );
  const isGif = sniffedAnimated || isAnimatedImage(normalizedSrc);
  // { url, data }: el estado guarda a qué URL pertenece el frame cacheado.
  const [posterState, setPosterState] = useState(null);
  const [posterFailed, setPosterFailed] = useState(false);
  const poster = posterState?.url === normalizedSrc
    ? posterState.data
    : (posterCache.get(normalizedSrc) || null);

  const wantsStill = isGif && !posterFailed
    && (gifBehavior === 'never' || (gifBehavior === 'hover' && !hovered));

  // Avatares subidos sin extensión: identificar el formato real.
  useEffect(() => {
    if (!sniffAnimated || gifBehavior === 'always') return undefined;
    if (isAnimatedImage(normalizedSrc) || hasImageExtension(normalizedSrc)) return undefined;
    let alive = true;
    detectAnimatedFile(normalizedSrc).then((animated) => {
      if (alive && animated) setSniffedAnimated(true);
    });
    return () => { alive = false; };
  }, [sniffAnimated, gifBehavior, normalizedSrc]);

  // Extraer el primer frame del GIF (una sola vez por URL).
  useEffect(() => {
    if (!isGif || !normalizedSrc || poster || posterFailed) return undefined;

    let cancelled = false;
    // Segundo intento vía /api/image-proxy (mismo origen): necesario para hosts
    // que no mandan Access-Control-Allow-Origin (p. ej. i.pinimg.com), donde el
    // canvas quedaría tainted y no se podría exportar el frame.
    const proxyUrl = /^https?:/i.test(normalizedSrc)
      ? `/api/image-proxy?url=${encodeURIComponent(normalizedSrc)}`
      : null;

    const exportFirstFrame = (img, onFail) => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 1;
        canvas.height = img.naturalHeight || 1;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        rememberPoster(normalizedSrc, dataUrl);
        setPosterState({ url: normalizedSrc, data: dataUrl });
      } catch {
        onFail();
      }
    };

    const load = (url, viaProxy) => {
      const img = new Image();
      if (!viaProxy) img.crossOrigin = 'anonymous';
      const fail = () => {
        if (cancelled) return;
        if (!viaProxy && proxyUrl) load(proxyUrl, true);
        else setPosterFailed(true);
      };
      img.onload = () => exportFirstFrame(img, fail);
      img.onerror = fail;
      img.src = url;
    };

    load(normalizedSrc, false);

    return () => { cancelled = true; };
  }, [isGif, normalizedSrc, poster, posterFailed]);

  const handleError = () => {
    if (!hasError) {
      console.warn('[SafeImage] Failed to load:', src?.slice(0, 80));
      setHasError(true);
    }
  };

  if (hasError) {
    if (hideOnError) return null;

    return (
      <div
        className={`safe-image-fallback ${className}`}
        style={style}
        onClick={onClick}
        role="img"
        aria-label={alt || 'Image failed to load'}
      >
        <span className="safe-image-fallback-icon">
          {fallbackIcon || <FaImage />}
        </span>
        {fallbackText && (
          <span className="safe-image-fallback-text">{fallbackText}</span>
        )}
      </div>
    );
  }

  // Mientras se genera el frame estático no pintamos el GIF animado (se vería
  // la animación un instante). Si falla la extracción, cae al GIF normal.
  const waitingForPoster = wantsStill && !poster;
  const hoverHandlers = isGif && gifBehavior === 'hover'
    ? {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
      }
    : {};

  return (
    <img
      {...rest}
      {...hoverHandlers}
      src={wantsStill && poster ? poster : normalizedSrc}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onClick={onClick}
      // Si el consumidor gestiona el error (p. ej. Avatar cambia al avatar por
      // defecto), manda él; si no, se pinta el placeholder de SafeImage.
      onError={onErrorProp ? (e) => onErrorProp(e) : handleError}
      style={waitingForPoster ? { ...style, visibility: 'hidden' } : style}
    />
  );
}
