import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PostVideoPlayer from '../assets/Resources/Components/PostVideoPlayer';

const FloatingVideoContext = createContext(null);

export const useFloatingVideo = () => useContext(FloatingVideoContext);

/**
 * FloatingVideoProvider — host del reproductor minimizado.
 *
 * En las listas virtualizadas la fila se desmonta al salir del overscan, y el
 * row usa `transform: translateY(...)`, que convierte al row en containing
 * block de cualquier `position: fixed` que viva dentro. Por eso el host se
 * monta con un portal en <body>: sobrevive al desmontaje de la fila y su
 * `position: fixed` se resuelve contra el viewport.
 *
 * `open(payload)` transfiere src/ratio/tiempo/volumen al host; `close()` lo
 * cierra. `resumeState` deja que el reproductor del host arranque donde iba.
 */
export function FloatingVideoProvider({ children }) {
  const [state, setState] = useState(null);
  const idRef = useRef(0);

  const open = useCallback((payload) => {
    if (payload == null) {
      setState(null);
      return;
    }
    const id = ++idRef.current;
    setState({ ...payload, id });
  }, []);

  const close = useCallback(() => setState(null), []);

  const value = { isHost: false, open, close, resumeState: state ?? null };

  return (
    <FloatingVideoContext.Provider value={value}>
      {children}
      {state &&
        createPortal(
          <div className="floating-video-host" role="dialog" aria-label={state.title || 'Video'}>
            <FloatingVideoContext.Provider
              value={{ isHost: true, open, close, resumeState: state }}
            >
              <PostVideoPlayer
                key={`floating-${state.src}::${state.id}`}
                src={state.src}
                title={state.title ?? undefined}
                ratio={state.ratio ?? 0}
                accent={state.accent ?? ''}
              />
            </FloatingVideoContext.Provider>
          </div>,
          document.body,
        )}
    </FloatingVideoContext.Provider>
  );
}

export default FloatingVideoContext;
