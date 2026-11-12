import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../assets/services/i18n/useI18n';
import {
  MIN_TRANSLATE_LENGTH,
  ensureTranslationPrefs,
  getTranslationPrefs,
  subscribeTranslationPrefs,
  translatePostText,
} from '../assets/services/postTranslation';

/**
 * Traduce el texto de un post al idioma de destino (el elegido en Ajustes o, si
 * está en automático, el de la app) cuando detecta que está escrito en otro.
 *
 * Devuelve el texto a mostrar (`text`), si se está mostrando una traducción y el
 * toggle para volver al original. Si la traducción falla, `text` es el original
 * y `failed` permite ofrecer un botón manual.
 */
export default function usePostTranslation(text) {
  const { locale } = useI18n();
  const [prefs, setPrefs] = useState(getTranslationPrefs);
  const [result, setResult] = useState(null); // { forText, text, from, to }
  const [failedFor, setFailedFor] = useState(null);
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeTranslationPrefs(setPrefs);
    ensureTranslationPrefs();
    return unsubscribe;
  }, []);

  const source = prefs.source;
  const target = prefs.target || locale;

  useEffect(() => {
    if (!text || text.trim().length < MIN_TRANSLATE_LENGTH) return undefined;

    let cancelled = false;
    translatePostText(text, { source, target })
      .then((translation) => {
        if (!cancelled && translation) setResult({ ...translation, forText: text });
      })
      .catch(() => {
        if (!cancelled) setFailedFor(text);
      });
    return () => {
      cancelled = true;
    };
  }, [text, source, target]);

  const retry = useCallback(() => {
    if (!text) return;
    translatePostText(text, { source, target })
      .then((translation) => {
        if (!translation) return;
        setResult({ ...translation, forText: text });
        setFailedFor(null);
      })
      .catch(() => setFailedFor(text));
  }, [text, source, target]);

  const toggleOriginal = useCallback(() => setShowOriginal((value) => !value), []);

  const active = result && result.forText === text ? result : null;
  return {
    translated: !!active,
    text: active && !showOriginal ? active.text : text,
    from: active?.from || null,
    showOriginal,
    toggleOriginal,
    failed: !active && failedFor === text,
    retry,
  };
}
