import { useEffect, useRef, useState } from 'react';
import { FaSearchMinus, FaSearchPlus, FaUndo } from 'react-icons/fa';
import { getImageStyle, parseImagePosition } from '../../services/helpers';

/**
 * AvatarFrameEditor
 *
 * Editor de arrastre + zoom para el marco del avatar. Usa exactamente la misma
 * matemática que `getImageStyle` (la que usa el Avatar para pintar el marco al
 * final), así que lo que se ve aquí es lo que se ve en el perfil y demás
 * vistas: el contenedor es cuadrado 1:1 y el marco se mueve/escala en píxeles
 * reales, guardando la posición como JSON `{x, y, zoom}` (igual que
 * `avatar_position`).
 *
 * Props:
 *   avatarUrl        – avatar actual, para ver cómo queda el marco encima
 *   frameUrl         – URL del marco (PNG con transparencia)
 *   initialPosition  – JSON `{x,y,zoom}` guardado, o null
 *   onPositionChange – callback(positionString)
 */
export default function AvatarFrameEditor({
  avatarUrl,
  frameUrl,
  initialPosition,
  onPositionChange,
}) {
  const init = parseImagePosition(initialPosition);
  const [pos, setPos] = useState(() => ({ x: init.x, y: init.y, zoom: Math.max(init.zoom, 1) }));

  const posRef = useRef(pos);
  useEffect(() => { posRef.current = pos; }, [pos]);

  const containerRef = useRef(null);
  const stageRef = useRef(null);
  // El avatar no ocupa todo el lienzo: ocupa el 64% central, para que el marco
  // tenga margen alrededor y no se recorte al pegarse al borde del avatar.
  const sizeRef = useRef(1);
  const dragging = useRef(false);
  const dragStart = useRef({ clientX: 0, clientY: 0, tx: 0, ty: 0 });
  const onChangeRef = useRef(onPositionChange);
  useEffect(() => { onChangeRef.current = onPositionChange; }, [onPositionChange]);

  // Medir el contenedor (el dialog arranca oculto: reintentar hasta tener tamaño).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.offsetWidth;
      if (w > 0) sizeRef.current = w;
    };
    measure();
    let raf = 0;
    const tick = () => {
      measure();
      if (sizeRef.current <= 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    }
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, []);

  // Reset cuando cambia el marco (nuevo PNG → centrado y zoom 1).
  const prevFrameRef = useRef(frameUrl);
  useEffect(() => {
    if (frameUrl !== prevFrameRef.current) {
      prevFrameRef.current = frameUrl;
      const next = { x: 50, y: 50, zoom: 1 };
      posRef.current = next;
      setPos(next);
      onChangeRef.current?.(JSON.stringify(next));
    }
  }, [frameUrl]);

  // ── Listeners de arrastre (una sola vez; todo se lee de refs) ──
  useEffect(() => {
    const applyDelta = (clientX, clientY) => {
      const C = sizeRef.current || 1;
      const z = posRef.current.zoom;
      const dx = clientX - dragStart.current.clientX;
      const dy = clientY - dragStart.current.clientY;
      // Igual que getImageStyle: x = (50 - 100 * translatePx / C) / zoom
      const next = {
        x: (50 - (100 * (dragStart.current.tx + dx)) / C) / z,
        y: (50 - (100 * (dragStart.current.ty + dy)) / C) / z,
        zoom: z,
      };
      posRef.current = next;
      setPos(next);
    };

    const onMouseMove = (e) => {
      if (dragging.current) applyDelta(e.clientX, e.clientY);
    };
    const onTouchMove = (e) => {
      if (!dragging.current || e.touches.length !== 1) return;
      e.preventDefault();
      applyDelta(e.touches[0].clientX, e.touches[0].clientY);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      const p = posRef.current;
      onChangeRef.current?.(JSON.stringify({
        x: Math.round(p.x),
        y: Math.round(p.y),
        zoom: Math.round(p.zoom * 10) / 10,
      }));
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
    };
  }, []);

  const startDrag = (clientX, clientY) => {
    const C = sizeRef.current || 1;
    const { x, y, zoom } = posRef.current;
    // translate actual en píxeles (inversa de applyDelta)
    dragStart.current = {
      clientX,
      clientY,
      tx: ((50 - x * zoom) * C) / 100,
      ty: ((50 - y * zoom) * C) / 100,
    };
    dragging.current = true;
  };

  const handleMouseDown = (e) => {
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
  };

  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
  };

  const commit = (next) => {
    posRef.current = next;
    setPos(next);
    onChangeRef.current?.(JSON.stringify({
      x: Math.round(next.x),
      y: Math.round(next.y),
      zoom: Math.round(next.zoom * 10) / 10,
    }));
  };

  const handleZoom = (e) => {
    commit({ ...posRef.current, zoom: parseFloat(e.target.value) });
  };

  const handleReset = () => commit({ x: 50, y: 50, zoom: 1 });

  if (!frameUrl) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '1',
          // Sin recorte: el marco puede salirse del lienzo y seguir viéndose.
          overflow: 'visible',
          borderRadius: 'var(--radius-sm, 6px)',
          background: 'var(--color-surface-hover, #252525)',
          backgroundImage:
            'linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%),'
            + 'linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 8px 8px',
          cursor: 'grab',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        {/* Escenario cuadrado = caja del avatar. El marco se coloca respecto a
            esta caja y puede desbordarla hacia el margen del lienzo. */}
        <div
          ref={stageRef}
          style={{
            position: 'absolute',
            inset: '18%',
          }}
        >
          {/* Avatar de fondo, para encuadrar el marco */}
          {avatarUrl && (
            <img
              src={avatarUrl}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                borderRadius: '50%',
                opacity: 0.85,
                pointerEvents: 'none',
              }}
            />
          )}
          {/* Marco (sin recorte: puede sobresalir del avatar) */}
          <img
            src={frameUrl}
            alt=""
            draggable={false}
            style={{
              ...getImageStyle(JSON.stringify(pos)),
              position: 'absolute',
              top: 0,
              left: 0,
              maxWidth: 'none',
              maxHeight: 'none',
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          />
        </div>
      </div>

      <div className="fc-modal-range-row" style={{ gap: 6 }}>
        <FaSearchMinus style={{ fontSize: '0.72rem', opacity: 0.5, flexShrink: 0 }} />
        <div className="fc-modal-range-control" style={{ flex: 1 }}>
          <input
            type="range"
            min="1"
            max="3"
            step="0.05"
            value={pos.zoom}
            onChange={handleZoom}
            className="fc-modal-range"
          />
        </div>
        <FaSearchPlus style={{ fontSize: '0.72rem', opacity: 0.5, flexShrink: 0 }} />
        <span className="fc-modal-range-value" style={{ minWidth: 32 }}>
          {pos.zoom.toFixed(1)}x
        </span>
        <button
          type="button"
          onClick={handleReset}
          className="fc-modal-sub-cancel"
          style={{ fontSize: '0.7rem', padding: '2px 10px', lineHeight: '20px', flexShrink: 0 }}
          title="Reset"
        >
          <FaUndo style={{ fontSize: '0.65rem' }} />
        </button>
      </div>
    </div>
  );
}
