import { twemojiUrl, TWEMOJI_CLASS } from '../../services/twemoji';
import './css/emojiShortcodeSuggest.css';

/**
 * Lista flotante de sugerencias de shortcodes para el composer.
 *
 * Debe ir dentro del mismo contenedor `position: relative` que el textarea y
 * pegado a él (`.chat-input-field` / `.fc-input-wrap`): ese contenedor no tiene
 * padding ni borde, así que `left: 0` alinea el borde del panel exactamente con
 * el del input. Toda la interacción con teclado vive en `useShortcodeSuggest`.
 */
export default function EmojiShortcodeSuggest({ open, options, activeIndex, onHover, onPick }) {
  if (!open || !options.length) return null;

  return (
    <div className="emoji-shortcode-suggest" role="listbox" aria-label="Emoji">
      {options.map((option, index) => {
        const src = twemojiUrl(option.emoji);
        return (
          <button
            type="button"
            key={option.name}
            role="option"
            aria-selected={index === activeIndex}
            className={`emoji-shortcode-option${index === activeIndex ? ' emoji-shortcode-option--active' : ''}`}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(index)}
          >
            {src
              ? <img className={TWEMOJI_CLASS} src={src} alt={option.emoji} draggable={false} />
              : <span className="emoji-shortcode-fallback">{option.emoji}</span>}
            <span className="emoji-shortcode-name">:{option.name}:</span>
          </button>
        );
      })}
    </div>
  );
}
