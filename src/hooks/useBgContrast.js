import { useState, useEffect, useRef } from 'react';
import { getContrastForBg, getContrastSidesForBg } from '../assets/services/colorExtractor';

/**
 * Custom hook that analyzes a background image URL and returns the ideal
 * text contrast color for glass/translucent overlays.
 *
 * - Returns '#000000' for light/bright images
 * - Returns '#ffffff' for dark images
 * - Defaults to '#ffffff' while loading or if no image
 * - Results are cached in localStorage by colorExtractor
 */
export default function useBgContrast(bgUrl) {
  const [contrastColor, setContrastColor] = useState('#ffffff');
  const prevUrlRef = useRef(null);

  useEffect(() => {
    if (!bgUrl) {
      setContrastColor('#ffffff');
      prevUrlRef.current = null;
      return;
    }

    // Avoid re-fetching if URL hasn't changed
    if (bgUrl === prevUrlRef.current) return;
    prevUrlRef.current = bgUrl;

    getContrastForBg(bgUrl).then((color) => {
      setContrastColor(color);
    }).catch(() => {
      // Fallback: default to white text on error
      setContrastColor('#ffffff');
    });
  }, [bgUrl]);

  return contrastColor;
}

const WHITE_SIDES = { left: '#ffffff', right: '#ffffff' };

/**
 * Igual que useBgContrast, pero devuelve el color de contraste de la mitad
 * IZQUIERDA y de la DERECHA por separado, para fondos partidos (oscuro a un
 * lado, claro al otro): así el texto de la izquierda y los botones de la
 * derecha pueden llevar cada uno el color que se lee.
 *
 * Si las dos mitades son parecidas, ambas traen el mismo color (el fondo se
 * trata como uniforme). Mientras carga o si no hay imagen: blanco.
 *
 * @returns {{ left: string, right: string }}
 */
export function useBgContrastSides(bgUrl) {
  const [sides, setSides] = useState(WHITE_SIDES);
  const prevUrlRef = useRef(null);

  useEffect(() => {
    if (!bgUrl) {
      prevUrlRef.current = null;
      return;
    }

    if (bgUrl === prevUrlRef.current) return;
    prevUrlRef.current = bgUrl;

    getContrastSidesForBg(bgUrl).then((result) => {
      if (result) setSides(result);
    }).catch(() => {
      setSides(WHITE_SIDES);
    });
  }, [bgUrl]);

  // Sin imagen se devuelve el respaldo sin tocar el estado (no hace falta
  // resetearlo: el resultado solo se usa cuando hay banner).
  return bgUrl ? sides : WHITE_SIDES;
}
