import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import EmojiPicker, { EmojiStyle, Theme } from 'emoji-picker-react';
import { FaSmile } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import './css/emojiPickerButton.css';

const PICKER_WIDTH = 320;
const PICKER_HEIGHT = 360;
const GAP = 8;
const MARGIN = 8;

/**
 * Botón de emoji reutilizable con picker (emoji-picker-react).
 *
 * Puede insertar el emoji en un textarea/input controlando el caret:
 *   <EmojiPickerButton textareaRef={ref} value={value} onChange={setValue} />
 *
 * o simplemente devolverlo por `onSelect`. El picker se pinta en un portal
 * (dentro del <dialog> si existe) para no quedar recortado por overflow.
 */
const EmojiPickerButton = forwardRef(function EmojiPickerButton({
  textareaRef,
  value = '',
  onChange,
  onSelect,
  className = 'emoji-picker-trigger',
  title,
  disabled = false,
  placement = 'top',
}, forwardedRef) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const buttonRef = useRef(null);
  const pickerRef = useRef(null);

  const setRefs = useCallback((node) => {
    buttonRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  const updatePosition = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(MARGIN, rect.right - PICKER_WIDTH),
      window.innerWidth - PICKER_WIDTH - MARGIN,
    );
    const spaceAbove = rect.top - GAP;
    const spaceBelow = window.innerHeight - rect.bottom - GAP;
    const openUp = placement === 'top' || (spaceBelow < PICKER_HEIGHT && spaceAbove > spaceBelow);
    const top = openUp
      ? Math.max(MARGIN, rect.top - PICKER_HEIGHT - GAP)
      : Math.min(window.innerHeight - PICKER_HEIGHT - MARGIN, rect.bottom + GAP);
    setPosition({ left, top });
  }, [placement]);

  const label = title || t('common.emoji') || 'Emoji';
  const close = useCallback(() => setOpen(false), []);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => {
      const next = !prev;
      if (next) requestAnimationFrame(updatePosition);
      return next;
    });
  }, [disabled, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;

    updatePosition();

    const handlePointerDown = (e) => {
      if (buttonRef.current?.contains(e.target)) return;
      if (pickerRef.current?.contains(e.target)) return;
      close();
    };
    const handleKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    let scrollFrame = 0;
    const handleScroll = (e) => {
      if (pickerRef.current?.contains(e.target)) return;
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        updatePosition();
      });
    };
    const handleResize = () => updatePosition();

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [open, close, updatePosition]);

  const portalTarget = useMemo(() => {
    const el = buttonRef.current;
    if (el) {
      const dialog = el.closest('dialog');
      if (dialog) {
        const overlays = dialog.querySelector(':scope > .fc-modal-overlays');
        return overlays || dialog;
      }
    }
    return document.body;
  }, [open]);

  const handleEmojiClick = useCallback((emojiData) => {
    const emoji = emojiData.emoji;
    if (onSelect) {
      onSelect(emoji);
      return;
    }
    if (!onChange) return;

    const el = textareaRef?.current;
    const current = String(el?.value ?? value ?? '');
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? start;
    const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`;
    const maxLength = el?.maxLength ?? -1;
    if (maxLength > 0 && next.length > maxLength) return;

    onChange(next);

    requestAnimationFrame(() => {
      if (!el) return;
      el.focus({ preventScroll: true });
      const caret = start + emoji.length;
      el.setSelectionRange(caret, caret);
    });
  }, [onChange, onSelect, textareaRef, value]);

  return (
    <>
      <button
        ref={setRefs}
        type="button"
        className={`${className}${open ? ' is-open' : ''}`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        <FaSmile />
      </button>
      {open && createPortal(
        <div
          ref={pickerRef}
          className="emoji-picker-popover"
          style={{ left: position.left, top: position.top }}
        >
          <EmojiPicker
            onEmojiClick={handleEmojiClick}
            emojiStyle={EmojiStyle.TWITTER}
            theme={Theme.DARK}
            width={PICKER_WIDTH}
            height={PICKER_HEIGHT}
            lazyLoadEmojis
            autoFocusSearch={false}
            previewConfig={{ showPreview: false }}
            searchPlaceholder={t('chat.search_emojis') || 'Search emoji'}
          />
        </div>,
        portalTarget,
      )}
    </>
  );
});

export default EmojiPickerButton;
