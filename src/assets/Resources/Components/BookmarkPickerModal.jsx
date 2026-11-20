import { useEffect, useState } from 'react';
import { FaBookmark, FaPlus, FaSpinner } from 'react-icons/fa';
import ModalShell from './ModalShell';
import { useI18n } from '../../services/i18n/useI18n';
import {
  getBookmarkCollections,
  createBookmarkCollection,
  deleteBookmarkCollection,
} from '../../services/postService';
import './css/bookmarkPicker.css';

/**
 * BookmarkPickerModal — se abre al guardar un post y pregunta en qué colección
 * (bookmark) meterlo.
 *
 * Las colecciones son privadas (RLS: solo el dueño) y pueden no existir: en ese
 * caso se ofrece crearlas al vuelo desde el mismo modal. "Todos los guardados"
 * guarda sin colección (`collection_id = null`), que es justo lo que hacían los
 * guardados antiguos, así nada queda fuera de la pestaña general.
 *
 * Props:
 *  - isOpen, onClose
 *  - onConfirm(collectionId | null) — el guardado real lo hace quien abre.
 */
export default function BookmarkPickerModal({ isOpen = true, userId, onClose, onConfirm }) {
  const { t } = useI18n();
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen || !userId) return;
    let cancelled = false;
    // El componente se monta solo al abrirlo (PostCard lo renderiza bajo
    // condición), así que el estado inicial ya es el de "cargando": no hace
    // falta resetear nada dentro del efecto.
    getBookmarkCollections(userId)
      .then((list) => { if (!cancelled) setCollections(list); })
      .catch(() => { if (!cancelled) setError(t('bookmarks.load_error')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, userId, t]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || busy || !userId) return;
    setBusy(true);
    setError('');
    try {
      const created = await createBookmarkCollection(userId, name);
      setCollections((prev) => [...prev, created]);
      setNewName('');
      setCreating(false);
      // Se guarda directamente en la colección recién creada.
      onConfirm(created.id);
    } catch (err) {
      setError(err?.message === 'DUPLICATE_NAME'
        ? t('bookmarks.name_duplicate')
        : t('bookmarks.create_error'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (collection) => {
    if (busy || !userId) return;
    setBusy(true);
    setError('');
    try {
      await deleteBookmarkCollection(collection.id, userId);
      setCollections((prev) => prev.filter((c) => c.id !== collection.id));
    } catch {
      setError(t('bookmarks.delete_error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      onEscape={onClose}
      className="fc-modal--bookmark-picker"
      disableBackdropClose
    >
      {/* El diálogo vive dentro del <article> del post (que abre el detalle al
          hacer clic), así que se corta la propagación para que crear/borrar
          colecciones no navegue al post. */}
      <div className="bookmark-picker" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <div className="bookmark-picker-header">
          <h3 className="fc-modal-title">{t('bookmarks.picker_title')}</h3>
          <button type="button" className="bookmark-picker-close" onClick={onClose} aria-label={t('common.cancel')}>
            ×
          </button>
        </div>

        <p className="bookmark-picker-subtitle">{t('bookmarks.picker_subtitle')}</p>

        <div className="bookmark-picker-list">
          <button
            type="button"
            className="bookmark-picker-item"
            onClick={() => onConfirm(null)}
            disabled={busy}
          >
            <span className="bookmark-picker-item-icon"><FaBookmark /></span>
            <span className="bookmark-picker-item-name">{t('bookmarks.all_saved')}</span>
          </button>

          {loading ? (
            <div className="bookmark-picker-loading"><FaSpinner className="fc-spin" /></div>
          ) : (
            collections.map((c) => (
              <div key={c.id} className="bookmark-picker-row">
                <button
                  type="button"
                  className="bookmark-picker-item"
                  onClick={() => onConfirm(c.id)}
                  disabled={busy}
                >
                  <span className="bookmark-picker-item-icon"><FaBookmark /></span>
                  <span className="bookmark-picker-item-name">{c.name}</span>
                  <span className="bookmark-picker-item-count">{c.count}</span>
                </button>
                <button
                  type="button"
                  className="bookmark-picker-row-delete"
                  onClick={() => handleDelete(c)}
                  disabled={busy}
                  title={t('bookmarks.delete')}
                  aria-label={t('bookmarks.delete')}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        {creating ? (
          <div className="bookmark-picker-new">
            <input
              className="bookmark-picker-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('bookmarks.name_placeholder')}
              maxLength={40}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleCreate(); }
              }}
            />
            <button
              type="button"
              className="fc-modal-save bookmark-picker-save"
              onClick={handleCreate}
              disabled={busy || !newName.trim()}
            >
              {busy ? <FaSpinner className="fc-spin" /> : t('bookmarks.create_and_save')}
            </button>
          </div>
        ) : (
          <button type="button" className="bookmark-picker-new-btn" onClick={() => setCreating(true)}>
            <FaPlus />
            {t('bookmarks.new_collection')}
          </button>
        )}

        {error && <p className="bookmark-picker-error">{error}</p>}
      </div>
    </ModalShell>
  );
}
