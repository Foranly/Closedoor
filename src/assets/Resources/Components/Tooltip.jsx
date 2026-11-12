import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';

const TOOLTIP_STYLES = {
  position: 'fixed',
  zIndex: 99999,
  padding: '4px 10px',
  borderRadius: 6,
  fontSize: '0.72rem',
  fontWeight: 500,
  lineHeight: 1.4,
  color: '#fff',
  background: 'rgba(30, 30, 35, 0.95)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  transition: 'opacity 0.15s ease, transform 0.15s ease',
};

/**
 * Custom tooltip rendered via createPortal.
 *
 * Portals to the nearest native <dialog> ancestor when available so the
 * tooltip inherits the dialog's top-layer stacking context (without it,
 * showModal() puts the dialog above anything at document.body level).
 * Falls back to document.body when there is no dialog parent.
 *
 * Uses position:fixed for screen-relative positioning, avoiding overflow
 * or transform clipping on intermediate ancestors.
 */
export default function Tooltip({ text, children, style, className, placement = 'top', suppress = false }) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const targetRef = useRef(null);
  const tooltipRef = useRef(null);
  const showTimeoutRef = useRef(null);
  const hideTimeoutRef = useRef(null);

  const isBottom = placement === 'bottom';
  const isRight = placement === 'right';
  const isLeft = placement === 'left';

  // ── Portal target: .fc-modal-overlays inside nearest <dialog>, else document.body ──
  // The overlay container has position:fixed;inset:0;overflow:visible;pointer-events:none
  // so tooltips at modal edges are not clipped by the dialog's overflow-y:auto.
  const portalTarget = useMemo(() => {
    const el = targetRef.current;
    if (el) {
      const dialog = el.closest('dialog');
      if (dialog) {
        const overlays = dialog.querySelector(':scope > .fc-modal-overlays');
        return overlays || dialog;
      }
    }
    return document.body;
  }, [visible]);

  const updatePosition = useCallback(() => {
    if (!targetRef.current) return;
    const rect = targetRef.current.getBoundingClientRect();
    if (isRight) {
      setPosition({
        top: rect.top + rect.height / 2,
        left: rect.right + 8,
      });
    } else if (isLeft) {
      setPosition({
        top: rect.top + rect.height / 2,
        left: rect.left - 8,
      });
    } else {
      setPosition({
        top: isBottom ? rect.bottom + 6 : rect.top - 6,
        left: rect.left + rect.width / 2,
      });
    }
  }, [isBottom, isRight, isLeft]);

  // Update position on scroll / resize while visible
  // Throttled with requestAnimationFrame to avoid layout thrashing
  // from getBoundingClientRect() on every scroll event
  useEffect(() => {
    if (!visible) return;
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          updatePosition();
          ticking = false;
        });
        ticking = true;
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [visible, updatePosition]);

  // Keep the tooltip inside the viewport horizontally. Titlebar buttons (close)
  // sit against the right edge, so a centered tooltip would be clipped.
  useLayoutEffect(() => {
    if (!visible || isRight || isLeft || !tooltipRef.current) return;
    const rect = tooltipRef.current.getBoundingClientRect();
    const margin = 8;
    const viewportWidth = document.documentElement.clientWidth;
    let delta = 0;
    if (rect.left < margin) delta = margin - rect.left;
    else if (rect.right > viewportWidth - margin) delta = (viewportWidth - margin) - rect.right;
    if (Math.abs(delta) > 0.5) {
      setPosition((prev) => ({ ...prev, left: prev.left + delta }));
    }
  }, [visible, position.left, isRight, isLeft]);

  const handleMouseEnter = useCallback(() => {
    if (suppress) return;
    clearTimeout(hideTimeoutRef.current);
    showTimeoutRef.current = setTimeout(() => {
      updatePosition();
      setVisible(true);
    }, 150);
  }, [updatePosition, suppress]);

  const handleMouseLeave = useCallback(() => {
    clearTimeout(showTimeoutRef.current);
    setVisible(false);
  }, []);

  if (!text) return <>{children}</>;

  let visibleTransform, hiddenTransform, arrowStyle;

  if (isRight) {
    visibleTransform = 'translateY(-50%)';
    hiddenTransform = 'translateY(calc(-50% + 2px))';
    arrowStyle = {
      position: 'absolute',
      left: -4,
      top: '50%',
      transform: 'translateY(-50%)',
      width: 0,
      height: 0,
      borderTop: '5px solid transparent',
      borderBottom: '5px solid transparent',
      borderRight: '5px solid rgba(30, 30, 35, 0.95)',
    };
  } else if (isLeft) {
    // El tooltip se coloca a la izquierda del elemento (p. ej. el rail derecho).
    visibleTransform = 'translate(-100%, -50%)';
    hiddenTransform = 'translate(calc(-100% + 2px), -50%)';
    arrowStyle = {
      position: 'absolute',
      right: -4,
      top: '50%',
      transform: 'translateY(-50%)',
      width: 0,
      height: 0,
      borderTop: '5px solid transparent',
      borderBottom: '5px solid transparent',
      borderLeft: '5px solid rgba(30, 30, 35, 0.95)',
    };
  } else {
    visibleTransform = isBottom
      ? 'translate(-50%, 6px)'
      : 'translate(-50%, -100%)';
    hiddenTransform = isBottom
      ? 'translate(-50%, 0)'
      : 'translate(-50%, calc(-100% + 4px))';

    arrowStyle = isBottom
      ? {
          position: 'absolute',
          top: -4,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 0,
          height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderBottom: '5px solid rgba(30, 30, 35, 0.95)',
        }
      : {
          position: 'absolute',
          bottom: -4,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 0,
          height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderTop: '5px solid rgba(30, 30, 35, 0.95)',
        };
  }

  return (
    <>
      <span
        ref={targetRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={className}
        style={{ display: 'inline-flex', ...style }}
      >
        {children}
      </span>
      {createPortal(
        <div
          ref={tooltipRef}
          style={{
            ...TOOLTIP_STYLES,
            top: position.top,
            left: position.left,
            transform: visible ? visibleTransform : hiddenTransform,
            opacity: visible ? 1 : 0,
          }}
        >
          {text}
          {/* Arrow */}
          <div style={arrowStyle} />
        </div>,
        portalTarget
      )}
    </>
  );
}
