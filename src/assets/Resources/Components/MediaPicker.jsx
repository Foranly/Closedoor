import { useRef } from 'react';
import { FaImage, FaUpload, FaSpinner, FaTimes, FaVideo } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { isAttachableVideoUrl, getEmbedUrl } from '../../services/helpers';
import PostVideoPlayer from './PostVideoPlayer';
// Shell compartida con los selectores de GIF y de canciones: el contenedor de
// subida de imágenes queda idéntico al resto de paneles embebidos del composer
// (borde, radios, superficies, header y buscador).
import './css/gifPicker.css';
import './css/mediaPicker.css';

/**
 * MediaPicker — panel embebido para adjuntar una imagen en el chat.
 *
 * Reutiliza la misma estructura que GifPicker/SongPicker (`.gif-picker` +
 * `.gif-picker-header`) y añade un cuerpo (`.gif-picker-results`) con la zona
 * de subida, para que el contenedor no sea solo una barra de herramientas.
 */
export default function MediaPicker({
  url = '',
  onUrlChange,
  onFile,
  uploading = false,
  onSend,
  onClose,
}) {
  const { t } = useI18n();
  const fileInputRef = useRef(null);

  const openFilePicker = () => {
    if (uploading) return;
    fileInputRef.current?.click();
  };

  return (
    <div className="gif-picker chat-media-picker">
      <div className="gif-picker-header">
        <button
          type="button"
          className="chat-media-picker-upload"
          onClick={openFilePicker}
          title={t('chat.background_upload') || 'Upload image'}
          disabled={uploading}
        >
          {uploading ? <FaSpinner className="fc-spin" /> : <FaUpload size={12} />}
        </button>
        <div className="gif-picker-search-wrap">
          {isAttachableVideoUrl(url) ? (
            <FaVideo className="gif-picker-search-icon" size={12} />
          ) : (
            <FaImage className="gif-picker-search-icon" size={12} />
          )}
          <input
            className="gif-picker-search-input"
            type="url"
            value={url}
            onChange={(e) => onUrlChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (url.trim() && !uploading) onSend?.();
              }
            }}
            placeholder={t('chat.media_placeholder') || 'Paste image URL...'}
            autoFocus
          />
        </div>
        <button
          type="button"
          className="chat-song-picker-search-btn"
          onClick={() => onSend?.()}
          disabled={!url.trim() || uploading}
        >
          Add
        </button>
        <button
          type="button"
          className="gif-picker-close"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <FaTimes size={13} />
        </button>
      </div>

      <div className="gif-picker-results chat-media-picker-results">
        {/* Video por URL: se envía como mensaje y se reproduce en la burbuja */}
        {isAttachableVideoUrl(url) && (
          <div className="chat-media-picker-video-preview">
            {getEmbedUrl(url.trim()) ? (
              <iframe
                src={getEmbedUrl(url.trim())}
                className="chat-message-video-embed"
                title="Video"
                allowFullScreen
              />
            ) : (
              <PostVideoPlayer src={url.trim()} />
            )}
          </div>
        )}
        <button
          type="button"
          className="chat-media-picker-drop"
          onClick={openFilePicker}
          disabled={uploading}
        >
          {uploading ? <FaSpinner className="fc-spin" /> : <FaUpload />}
          <span>{uploading ? (t('upload.uploading') || 'Uploading...') : (t('chat.background_upload') || 'Upload image')}</span>
          <small>PNG · JPG · GIF · WEBP</small>
        </button>
        <input
          ref={fileInputRef}
          className="chat-media-picker-file-input"
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onFile?.(file);
          }}
          disabled={uploading}
        />
      </div>
    </div>
  );
}
