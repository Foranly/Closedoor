import { useMemo } from 'react';
import { splitEmoji, twemojiUrl, TWEMOJI_CLASS } from '../../services/twemoji';

/**
 * Texto plano con sus emojis pintados como SVG de Twemoji, para que se vean
 * igual en cualquier sistema operativo. Para markdown se usa `remarkTwemoji`
 * en PostMarkdown.
 */
export default function EmojiText({ text = '', className }) {
  const parts = useMemo(() => splitEmoji(text), [text]);

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (part.type !== 'emoji') return part.value;
        const src = twemojiUrl(part.value);
        if (!src) return part.value;
        return (
          <img
            key={index}
            className={TWEMOJI_CLASS}
            src={src}
            alt={part.value}
            draggable={false}
          />
        );
      })}
    </span>
  );
}
