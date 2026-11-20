import { useEffect, useState } from 'react';
import { DEFAULT_AVATAR, getImageStyle } from '../../services/helpers';
import { getCdnUrl } from '../../services/cdnService';
import { isImageCached, preloadImage } from '../../services/imageCache';
import { useRegisterUserStatus } from '../../../context/UserStatusContext';

/**
 * Avatar — Wrapper para mostrar avatares de usuario.
 * Normaliza automáticamente URLs del CDN para evitar Mixed Content.
 * Si se pasa `status`, muestra un punto indicador de estado.
 * Si se pasa `userId` (sin `status` explícito), obtiene el estado
 * automáticamente del UserStatusContext global, funcionando en
 * cualquier ruta sin necesidad de pasar `status` manualmente.
 * Si se pasa `frame` (URL del marco del avatar, PNG 1:1 con transparencia)
 * se dibuja por encima de la imagen, sin capturar clicks y sin recortarse con
 * el radio del avatar: los marcos suelen sobresalir del círculo.
 * `framePosition` (JSON {x,y,zoom}, mismo formato que `avatar_position`)
 * aplica el ajuste de arrastre/zoom elegido en el editor del marco.
 *
 * NOTA: className se aplica al <img>, no al wrapper div.
 * El wrapper div solo existe para posicionar el status dot.
 */
export default function Avatar({ src, alt = 'avatar', className, style, onClick, onError: customOnError, status, userId, frame, framePosition }) {
  const normalizedSrc = getCdnUrl(src) || DEFAULT_AVATAR;
  const normalizedFrame = getCdnUrl(frame);
  // Si el marco ya está en caché se pinta en el primer frame (sin pop-in); si
  // no, aparece con un fundido corto en cuanto la imagen está lista.
  const [frameReady, setFrameReady] = useState(() => isImageCached(normalizedFrame));

  useEffect(() => {
    if (normalizedFrame) preloadImage(normalizedFrame);
  }, [normalizedFrame]);
  // Si no se pasa status explícitamente pero hay userId, obtener del contexto global
  const contextStatus = useRegisterUserStatus(!status ? userId : null);
  const effectiveStatus = status || contextStatus;

  const handleError = (e) => {
    e.target.src = DEFAULT_AVATAR;
    customOnError?.(e);
  };

  const showStatus = effectiveStatus && ['online', 'dnd', 'idle', 'disconnected'].includes(effectiveStatus);

  // The className is applied to the outer wrapper so avatar CSS classes (which
  // set width, height, border-radius, etc.) still target the container.
  // The inner <img> always has avatar-img class + explicit object-fit:cover.
  // The status dot (when shown) lives outside the clipping div so it's never clipped.
  return (
    <div className={`avatar-wrapper ${className || ''}`.trim()} style={{ position: 'relative', display: 'inline-flex', overflow: 'visible' }}>
      <div style={{ width: '100%', height: '100%', borderRadius: 'inherit', overflow: 'hidden' }}>
        <img
          className="avatar-img"
          src={normalizedSrc}
          alt={alt}
          loading="lazy"
          decoding="async"
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', ...style }}
          onClick={onClick}
          onError={handleError}
        />
      </div>
      {normalizedFrame && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            // Sin recorte: los marcos con detalles que sobresalen del aro deben
            // verse completos por encima del borde del avatar.
            overflow: 'visible',
            pointerEvents: 'none',
          }}
        >
          <img
            className="avatar-frame"
            src={normalizedFrame}
            alt=""
            aria-hidden="true"
            draggable={false}
            loading="lazy"
            decoding="async"
            onLoad={() => setFrameReady(true)}
            style={{
              // Misma matemática que la imagen del avatar (arrastre + zoom).
              ...getImageStyle(framePosition),
              position: 'absolute',
              top: 0,
              left: 0,
              maxWidth: 'none',
              maxHeight: 'none',
              pointerEvents: 'none',
              userSelect: 'none',
              opacity: frameReady ? 1 : 0,
              transition: 'opacity 0.15s ease',
            }}
          />
        </div>
      )}
      {showStatus && <span className={`status-dot status-dot--${effectiveStatus}`} />}
    </div>
  );
}
