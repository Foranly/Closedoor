import { useEffect, useRef, useState, useCallback } from 'react';
import { ToastContainer } from 'react-toastify';
import './css/modal.css';

/**
 * ModalShell — wraps content in a native <dialog> element called via showModal().
 *
 * Benefits over a custom overlay:
 *  - Automatic scroll locking (no useLockBodyScroll needed)
 *  - Native focus trapping
 *  - ::backdrop pseudo-element for the overlay
 *  - Top-layer rendering (no z-index fights)
 *  - Better performance (browser-handled compositing)
 *
 * State machine: idle → entering → open → leaving → idle
 *  - idle: nothing rendered
 *  - entering: dialog is in the DOM with opacity:0; showModal() called; after
 *    double requestAnimationFrame, transitions to 'open' → CSS transition plays
 *  - open: dialog is visible, fully animated in
 *  - leaving: dialog animates out (CSS transition), then close() is called
 *    after 250ms, and state resets to idle
 *
 * Props:
 *  - isOpen: boolean — whether the dialog is shown
 *  - onClose: () => void — called when dialog should close (Escape, backdrop click)
 *  - onEscape: (e) => void — optional custom Escape handler (e.g. confirm before close)
 *  - className: string — additional classes for the <dialog> element
 *  - disableBackdropClose: boolean — if true, clicking outside the dialog won't close it
 *    (por defecto se cierra al pulsar fuera; los diálogos con cambios sin guardar
 *    pasan un onEscape/onClose que pide confirmación antes de cerrar)
 *  - children: ReactNode
 */
export default function ModalShell({ isOpen, onClose, onEscape, className = '', disableBackdropClose = false, children }) {
  const dialogRef = useRef(null);
  const [state, setState] = useState('idle'); // 'idle' | 'entering' | 'open' | 'leaving'
  const prevOpenRef = useRef(isOpen);

  // ── Synchronous state transitions during render ──
  // This is the recommended React pattern for deriving state from prop changes.
  // It ensures state updates happen BEFORE the next render, so the component
  // never briefly renders in an inconsistent state.
  // ── Mounted with isOpen=true, or isOpen just changed from false → true ──
  if (isOpen && state === 'idle') {
    setState('entering');
  }
  // ── isOpen changed from true → false (close) ──
  if (!isOpen && prevOpenRef.current && (state === 'open' || state === 'entering')) {
    setState('leaving');
  }
  // ── Re-open while leaving animation is still playing ──
  if (isOpen && !prevOpenRef.current && state === 'leaving') {
    setState('entering');
  }
  prevOpenRef.current = isOpen;

  // ── entering → open: wait for paint, then trigger CSS transition ──
  useEffect(() => {
    if (state !== 'entering') return;
    const el = dialogRef.current;
    if (!el) return;

    if (!el.open) el.showModal();
    // Double rAF ensures the browser paints the initial opacity:0 frame
    // before we add .fc-dialog--open, so the CSS transition fires.
    // Also check that state is still 'entering' before transitioning —
    // prevents race if user closes during the rAF delay.
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        setState((prev) => prev === 'entering' ? 'open' : prev);
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
    };
  }, [state]);

  // ── leaving → idle: wait for animation, then close natively ──
  useEffect(() => {
    if (state !== 'leaving') return;
    const el = dialogRef.current;
    if (!el) return;

    const timer = setTimeout(() => {
      if (el.open) el.close();
      setState('idle');
    }, 250); // matches CSS transition duration

    return () => clearTimeout(timer);
  }, [state]);

  // ── Intercept Escape to allow custom handling ──
  useEffect(() => {
    const el = dialogRef.current;
    if (!el || state !== 'open') return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (onEscape) {
          onEscape(e);
        } else if (onClose) {
          onClose();
        }
      }
    };

    el.addEventListener('keydown', handleKeyDown);
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [state, onClose, onEscape]);

  // ── Click on backdrop (target === dialog, fuera de su caja) ──
  // El <dialog> también recibe los clics de su propio padding: se comprueban
  // las coordenadas para cerrar solo cuando el clic cae fuera del panel.
  const handleBackdropClick = useCallback((e) => {
    const el = dialogRef.current;
    if (!el || e.target !== el || disableBackdropClose) return;
    const rect = el.getBoundingClientRect();
    const insidePanel =
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (insidePanel) return;
    if (onEscape) {
      onEscape(e);
    } else if (onClose) {
      onClose();
    }
  }, [onClose, onEscape, disableBackdropClose]);

  // ── Keep dialog always mounted so .fc-modal-overlays stays in the DOM ──
  // Never return null: portal targets must survive children unmount (prevents
  // "Failed to execute 'removeChild' on 'Node'" errors from React portal cleanup).
  // When idle, hide the dialog and children; when active, show everything.
  const isIdle = state === 'idle';

  const classes = [
    'fc-modal',
    className,
    state === 'open' ? 'fc-dialog--open' : '',
    state === 'leaving' ? 'fc-dialog--leaving' : '',
    isIdle ? 'fc-modal--idle' : '',
  ].filter(Boolean).join(' ');

  return (
    <dialog
      ref={dialogRef}
      className={classes}
      onClick={handleBackdropClick}
      style={isIdle ? { display: 'none' } : undefined}
    >
      <div className="fc-modal-inner">
        {!isIdle && children}
      </div>
      <div className="fc-modal-overlays" />
      {/* Toast container inside the dialog's top layer — appears above ::backdrop */}
      <ToastContainer
        containerId="modal"
        position="top-right"
        autoClose={3000}
        hideProgressBar={true}
        newestOnTop
        closeOnClick
        pauseOnFocusLoss={false}
        draggable={false}
        pauseOnHover
        theme="dark"
        closeButton={false}
        toastClassName="fc-toast"
        bodyClassName="fc-toast-body"
        style={{ position: 'fixed', top: 30, right: 30, zIndex: 2147483647 }}
      />
    </dialog>
  );
}
