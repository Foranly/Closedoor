import emojiRegex from 'emoji-regex';
import twemoji from '@twemoji/api';
import { visit } from 'unist-util-visit';

export const TWEMOJI_CLASS = 'twemoji-emoji';

const URL_CACHE = new Map();

/**
 * URL del SVG de Twemoji para un emoji concreto. Se calcula con el propio
 * parser de twemoji (resuelve variaciones, ZWJ, banderas, keycaps…) y se
 * cachea: el mismo emoji se repite mucho en mensajes y reacciones.
 */
export function twemojiUrl(emoji) {
  if (URL_CACHE.has(emoji)) return URL_CACHE.get(emoji);
  let url = '';
  twemoji.parse(emoji, {
    folder: 'svg',
    ext: '.svg',
    callback: (icon, options) => {
      url = `${options.base}svg/${icon}.svg`;
      return url;
    },
  });
  // Emoji más nuevos que el set de Twemoji: sin URL, se pinta como texto
  // (la fuente del OS) en vez de un <img> roto.
  const result = url || null;
  URL_CACHE.set(emoji, result);
  return result;
}

/**
 * Divide un texto en tramos de texto plano y emojis. No usa HTML: el caller
 * pinta los emojis como <img> y el texto lo escapa React.
 */
export function splitEmoji(text) {
  const value = String(text ?? '');
  const re = emojiRegex();
  const parts = [];
  let last = 0;
  let match;
  while ((match = re.exec(value))) {
    if (match.index > last) {
      parts.push({ type: 'text', value: value.slice(last, match.index) });
    }
    parts.push({ type: 'emoji', value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
  return parts;
}

/**
 * Devuelve cuántos emojis contiene el texto SOLO si todo el contenido son
 * emojis y espacios. Si hay cualquier texto/signo, devuelve 0.
 */
export function countEmojiOnly(text) {
  const value = String(text ?? '').trim();
  if (!value) return 0;
  let count = 0;
  for (const part of splitEmoji(value)) {
    if (part.type === 'emoji') {
      count += 1;
      continue;
    }
    if (part.value.trim()) return 0;
  }
  return count;
}

/**
 * Plugin de remark: sustituye los emojis de los nodos de texto por nodos que
 * react-markdown convierte en <img> (Twemoji). Se omiten bloques de código.
 */
export function remarkTwemoji() {
  return (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || parent.type === 'code' || parent.type === 'inlineCode') return;
      if (!node.value) return;
      const parts = splitEmoji(node.value);
      if (!parts.some((part) => part.type === 'emoji')) return;
      parent.children.splice(index, 1, ...parts.map((part) => {
        if (part.type !== 'emoji') return { type: 'text', value: part.value };
        const src = twemojiUrl(part.value);
        if (!src) return { type: 'text', value: part.value };
        return {
          type: 'twemoji',
          value: part.value,
          data: {
            hName: 'img',
            hProperties: {
              src,
              alt: part.value,
              className: TWEMOJI_CLASS,
              draggable: 'false',
            },
          },
        };
      }));
      return index + parts.length;
    });
  };
}
