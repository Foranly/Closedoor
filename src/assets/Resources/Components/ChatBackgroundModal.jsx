import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaImage, FaSpinner, FaTimes, FaTrash, FaUpload } from 'react-icons/fa';
import { toast } from 'react-toastify';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { setChatBackground, normalizeBackgroundUrl } from '../../services/chatService';
import { clearColorsCache } from '../../services/colorExtractor';
import { uploadImage } from '../../services/cdnService';
import '../Styles/chat.css';
import './css/modal.css';

/**
 * ChatBackgroundModal — imagen de fondo de UNA conversación, solo para el
 * usuario que la pone.
 *
 * Se guarda en `chat_background_settings` (migración 078): una fila por
 * (user_id, conversation_id) con RLS `user_id = auth.uid()`, así que el otro
 * participante del chat no la ve ni la recibe nunca. Mismo patrón que
 * BubbleColorModal (colores de burbuja).
 *
 * La imagen se sube al CDN propio (uploadImage → type 'chat', el mismo que usa
 * el composer al enviar imágenes) o se pega una URL http(s) ya existente.
 *
 * Props:
 *  - conversationId: id de la conversación.
 *  - currentUrl: fondo actual ('' = sin fondo).
 *  - shared: true en grupos — el fondo es de la conversación y lo ven todos.
 *    En ese caso el guardado lo hace quien lo abre (onSaved), que además deja
 *    el aviso en el hilo; aquí no se escribe la preferencia personal.
 *  - onClose: () => void
 *  - onSaved: (url: string) => void — '' cuando se quita el fondo.
 */
export default function ChatBackgroundModal({ conversationId, currentUrl = '', shared = false, onClose, onSaved }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const [image, setImage] = useState(currentUrl || '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Reset al abrir para otra conversación (la card se reutiliza).
  useEffect(() => {
    setImage(currentUrl || '');
  }, [conversationId, currentUrl]);

  const close = useCallback(() => {
    if (!saving && !uploading) onClose?.();
  }, [saving, uploading, onClose]);

  const handlePickFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('modal.invalid_image_type') || 'Invalid image type');
      return;
    }

    setUploading(true);
    const toastId = toast.loading(t('upload.uploading') || 'Subiendo imagen...');
    try {
      const result = await uploadImage(file, user.id, 'chat');
      const url = result?.url || '';
      if (!url) throw new Error('Upload returned empty URL');
      setImage(url);
      toast.update(toastId, {
        render: t('upload.uploaded') || 'Imagen subida',
        type: 'success',
        isLoading: false,
        autoClose: 2000,
      });
    } catch (err) {
      console.error('Chat background upload error:', err);
      toast.update(toastId, {
        render: err?.message || 'Upload failed',
        type: 'error',
        isLoading: false,
        autoClose: 3000,
      });
    } finally {
      setUploading(false);
      e.target.value = ''; // permite volver a elegir el MISMO archivo
    }
  }, [user?.id, t]);

  const handleSave = useCallback(async () => {
    if (!user?.id || !conversationId) return;
    setSaving(true);
    try {
      const savedUrl = shared
        ? (normalizeBackgroundUrl(image) || '')
        : await setChatBackground(user.id, conversationId, image);
      // El acento se cachea por URL y NO caduca (las imágenes no cambian): la
      // única invalidación es cambiar el fondo, así que aquí —y solo aquí— se
      // borra la paleta de la nueva imagen para que se extraiga de cero.
      if (savedUrl && savedUrl !== (currentUrl || '')) clearColorsCache(savedUrl);
      await onSaved?.(savedUrl || '');
      toast.success(t('chat.background_saved') || 'Chat background saved');
      onClose?.();
    } catch (err) {
      console.error('Error saving chat background:', err);
      toast.error(t('common.error') || 'Error');
    } finally {
      setSaving(false);
    }
  }, [user?.id, conversationId, shared, image, currentUrl, onSaved, onClose, t]);

  if (!conversationId) return null;

  return createPortal(
    <div className="chat-nickname-overlay" onClick={close}>
      <div className="chat-nickname-modal" onClick={(e) => e.stopPropagation()}>
        <div className="chat-nickname-modal-header">
          <h3 className="fc-modal-title">{t('chat.background') || 'Chat background'}</h3>
          <button className="chat-nickname-modal-close" onClick={close} title={t('modal.cancel') || 'Cancel'}>
            <FaTimes />
          </button>
        </div>

        <div className="chat-nickname-modal-body">
          {/* Preview: la imagen tal cual se verá detrás de los mensajes */}
          <div
            className={`chat-bg-preview${image ? '' : ' chat-bg-preview--empty'}`}
            style={image ? { backgroundImage: `url("${image.replace(/"/g, '%22')}")` } : undefined}
          >
            {!image && (
              <>
                <FaImage />
                <span>{t('chat.background_empty') || 'No background'}</span>
              </>
            )}
          </div>

          <div className="chat-bg-actions">
            <label className={`chat-bg-upload${uploading ? ' chat-bg-upload--busy' : ''}`}>
              {uploading ? <FaSpinner className="fc-spin" /> : <FaUpload size={12} />}
              <span>{t('chat.background_upload') || 'Upload image'}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handlePickFile}
                disabled={uploading || saving}
              />
            </label>
            {image && (
              <button
                type="button"
                className="chat-bg-remove"
                onClick={() => setImage('')}
                disabled={saving || uploading}
              >
                <FaTrash size={11} />
                <span>{t('chat.background_remove') || 'Remove background'}</span>
              </button>
            )}
          </div>

          <input
            className="chat-bg-url"
            type="url"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder={t('chat.background_url_placeholder') || 'or paste an image URL'}
            disabled={saving || uploading}
          />

          <p className="chat-bg-hint">
            {shared
              ? (t('chat.background_hint_group') || 'Everyone in the group will see it')
              : (t('chat.background_hint') || 'Only you will see it')}
          </p>
        </div>

        <div className="chat-nickname-modal-footer">
          <button
            className="fc-modal-save"
            onClick={handleSave}
            disabled={saving || uploading}
          >
            {saving ? (t('modal.saving') || 'Saving...') : (t('common.save') || 'Save')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
