import { useCallback, useMemo, useState } from 'react';
import { getShortcodeToken, searchShortcodes } from '../assets/services/emojiShortcodes';

/**
 * Autocompletado de shortcodes (`:sm` → 😄). Se le pasa el texto del composer y
 * la posición del caret, y devuelve las opciones más el manejador de teclado.
 *
 * `onApply({ emoji, start, end })` debe sustituir `[start, end)` del texto por
 * el emoji y volver a colocar el caret.
 *
 * El índice seleccionado y el descarte con Escape se guardan junto al token
 * (`query` / texto completo) en vez de sincronizarse con efectos: si el token
 * cambia, el estado guardado deja de coincidir y se vuelve al principio.
 */
export function useShortcodeSuggest({ value, caret, onApply }) {
  const token = useMemo(() => getShortcodeToken(value, caret), [value, caret]);
  const options = useMemo(() => (token ? searchShortcodes(token.query) : []), [token]);

  const [nav, setNav] = useState({ query: null, index: 0 });
  const [dismissed, setDismissed] = useState(null);

  const activeIndex = Math.min(
    nav.query === token?.query ? nav.index : 0,
    Math.max(options.length - 1, 0),
  );
  const open = options.length > 0
    && !(dismissed?.query === token?.query && dismissed?.value === value);

  const setActiveIndex = useCallback((next) => {
    setNav({
      query: token?.query ?? null,
      index: typeof next === 'function' ? next(activeIndex) : next,
    });
  }, [activeIndex, token?.query]);

  const pick = useCallback((index = activeIndex) => {
    const option = options[index];
    if (!option || !token) return false;
    onApply({ emoji: option.emoji, start: token.start, end: token.end });
    return true;
  }, [activeIndex, onApply, options, token]);

  const handleKeyDown = useCallback((event) => {
    if (!open) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % options.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + options.length) % options.length);
      return true;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      if (!pick()) return false;
      event.preventDefault();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed({ query: token?.query ?? null, value });
      return true;
    }
    return false;
  }, [open, options.length, pick, setActiveIndex, token?.query, value]);

  return { open, options, activeIndex, setActiveIndex, pick, handleKeyDown };
}

export default useShortcodeSuggest;
