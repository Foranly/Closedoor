import { useRef, useState } from 'react';
import { FaImage, FaSpinner, FaTrash } from 'react-icons/fa';
import ModalShell from './ModalShell';
import ConfirmModal from './ConfirmModal';
import ImagePositionEditor from './ImagePositionEditor';
import { useI18n } from '../../services/i18n/useI18n';
import { useAuth } from '../../../hooks/useAuth';
import { uploadWithLocalPreview } from '../../services/cdnService';
import { getCdnUrl } from '../../services/cdnService';
import { updateBookmarkCollection } from '../../services/postService';
import './css/bookmarkPicker.css';

/**
 * BookmarkEditModal — renombrar un bookmark, añadir una descripción corta y
 * ponerle portada.
 *
 * La portada sigue el mismo sistema que el avatar del perfil:
 *  - subir una imagen (CDN, con preview local inmediato) o pegar una URL,
 *  - ajustar el encuadre con ImagePositionEditor (arrastre + zoom),
 *  - guardar el ajuste como JSON `{x,y,zoom}` en `cover_position`.
 * La card 1:1 del perfil pinta la portada con `getImageStyle`, la misma
 * matemática que el avatar.
 */
const DESC_MAX = 30;

export default function BookmarkEditModal({ isOpen = true, collection, onClose, onSaved }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const [name, setName] = useState(collection?.name || '');
  const [description, setDescription] = useState(collection?.description || '');
  const [cover, setCover] = useState(collection?.cover_url || '');
  const [coverPosition, setCoverPosition] = useState(collection?.cover_position || '{"x":50,"y":50,"zoom":1}');
  const [urlInput, setUrlInput] = useState(collection?.cover_url || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pendingClose, setPendingClose] = useState(false);
  const fileRef = useRef(null);

  // Cambios sin guardar: nombre, descripción o portada distintos a los actuales.
  const isDirty =
    name !== (collection?.name || '') ||
    description !== (collection?.description || '') ||
    cover !== (collection?.cover_url || '') ||
    coverPosition !== (collection?.cover_position || '{"x":50,"y":50,"zoom":1}');

  const requestClose = () => {
    if (isDirty) setPendingClose(true);
    else onClose?.();
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !user?.id) return;
    if (!file.type.startsWith('image/')) {
      setError(t('modal.invalid_image_type'));
      return;
    }
    setUploading(true);
    setError('');
    try {
      // 'avatar' = recorte cuadrado: la portada de la card es 1:1.
      const { localUrl, realUrlPromise } = uploadWithLocalPreview(file, user.id, 'avatar');
      setCover(localUrl);
      setUrlInput(localUrl);
      const realUrl = await realUrlPromise;
      setCover(realUrl);
      setUrlInput(realUrl);
    } catch (err) {
      console.error('[bookmarks] cover upload failed:', err);
      setError(t('bookmarks.cover_upload_error'));
    } finally {
      setUploading(false);
    }
  };

  const applyUrl = () => {
    const next = urlInput.trim();
    setCover(next);
    if (!next) setCoverPosition('{"x":50,"y":50,"zoom":1}');
  };

  const handleSave = async () => {
    if (saving || !collection?.id || !user?.id) return;
    if (!name.trim()) {
      setError(t('bookmarks.name_required'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await updateBookmarkCollection(collection.id, user.id, {
        name,
        description,
        cover_url: cover || null,
        cover_position: cover ? coverPosition : null,
      });
      onSaved?.(updated);
      onClose?.();
    } catch (err) {
      setError(err?.message === 'DUPLICATE_NAME'
        ? t('bookmarks.name_duplicate')
        : t('bookmarks.update_error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={requestClose}
      onEscape={requestClose}
      className="fc-modal--bookmark-edit"
    >
      <div className="bookmark-edit" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <div className="bookmark-picker-header">
          <h3 className="fc-modal-title">{t('bookmarks.edit_title')}</h3>
          <button type="button" className="bookmark-picker-close" onClick={requestClose} aria-label={t('common.cancel')}>
            ×
          </button>
        </div>

        <div className="bookmark-edit-field">
          <label className="bookmark-edit-label" htmlFor="bookmark-name">{t('bookmarks.name_label')}</label>
          <input
            id="bookmark-name"
            className="bookmark-picker-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder={t('bookmarks.name_placeholder')}
          />
        </div>

        <div className="bookmark-edit-field">
          <label className="bookmark-edit-label" htmlFor="bookmark-desc">{t('bookmarks.description_label')}</label>
          <input
            id="bookmark-desc"
            className="bookmark-picker-input"
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, DESC_MAX))}
            maxLength={DESC_MAX}
            placeholder={t('bookmarks.description_placeholder')}
          />
          <span className="bookmark-edit-hint">{description.length}/{DESC_MAX}</span>
        </div>

        <div className="bookmark-edit-field">
          <span className="bookmark-edit-label">{t('bookmarks.cover_label')}</span>
          <div className="bookmark-edit-cover-actions">
            <button
              type="button"
              className="bookmark-edit-upload"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? <FaSpinner className="fc-spin" /> : <FaImage />}
              {t('bookmarks.cover_upload')}
            </button>
            {cover && (
              <button
                type="button"
                className="bookmark-edit-remove-cover"
                onClick={() => { setCover(''); setUrlInput(''); }}
                title={t('bookmarks.cover_remove')}
              >
                <FaTrash />
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={handleUpload}
              style={{ display: 'none' }}
            />
          </div>

          <div className="bookmark-edit-url-row">
            <input
              className="bookmark-picker-input"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onBlur={applyUrl}
              onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
              placeholder="https://.../cover.jpg"
            />
            <button type="button" className="bookmark-edit-url-apply" onClick={applyUrl}>
              {t('modal.apply')}
            </button>
          </div>
        </div>

        {cover && (
          <div className="bookmark-edit-cover-preview">
            <ImagePositionEditor
              key={cover}
              imageUrl={getCdnUrl(cover) || cover}
              initialPosition={coverPosition}
              aspectRatio={1}
              circular={false}
              onPositionChange={(pos) => setCoverPosition(pos)}
            />
          </div>
        )}

        {error && <p className="bookmark-picker-error">{error}</p>}

        <div className="bookmark-edit-actions">
          <button type="button" className="fc-modal-save" onClick={handleSave} disabled={saving || uploading}>
            {saving ? <FaSpinner className="fc-spin" /> : t('common.save')}
          </button>
          <button type="button" className="bookmark-edit-cancel" onClick={requestClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>

      {pendingClose && (
        <ConfirmModal
          message={t('modal.discard_changes')}
          onConfirm={() => { setPendingClose(false); onClose?.(); }}
          onCancel={() => setPendingClose(false)}
        />
      )}
    </ModalShell>
  );
}
