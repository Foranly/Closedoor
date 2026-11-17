import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FaTimes, FaUser } from 'react-icons/fa';
import { toast } from 'react-toastify';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { setNickname, removeNickname } from '../../services/chatService';
import EmojiText from './EmojiText';
import EmojiPickerButton from './EmojiPickerButton';
import { DEFAULT_AVATAR, getImageStyle } from '../../services/helpers';
import Badge from './Badge';
import Avatar from './Avatar';
import '../Styles/chat.css';
import '../Styles/explore.css';
import './css/modal.css';

/**
 * NicknameModal — compartido entre Chat.jsx y profile.jsx.
 *
 * Previews idénticos a los del modal de editar perfil (fc-preview-card +
 * explore-card) aplicando getImageStyle para respetar el sistema de arrastre,
 * y el input/título usan las mismas clases del modal de editar perfil
 * (fc-modal-title / fc-modal-label / fc-modal-input / fc-modal-char-count).
 *
 * Props:
 *  - userData: perfil del usuario objetivo (id, avatar_url, banner_url, ...).
 *              null/undefined → el modal no se renderiza.
 *  - currentName: apodo actual ('' si no tiene) para el título y el botón de borrar.
 *  - onClose: () => void
 *  - onSaved: (finalName) => void — recibe el apodo final guardado ('' si se
 *             eliminó) para que el padre actualice su mapa de nicknames.
 */
export default function NicknameModal({ userData, currentName = '', onClose, onSaved }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const [input, setInput] = useState(currentName || '');
  const inputRef = useRef(null);
  const [saving, setSaving] = useState(false);

  // Reset del input al abrir para otro usuario (incluye cambiar de usuario
  // con el mismo apodo/vacío: userData?.id cambia undefined → id)
  useEffect(() => {
    setInput(currentName || '');
  }, [userData?.id, currentName]);

  const close = useCallback(() => { if (!saving) onClose?.(); }, [saving, onClose]);

  const handleSave = useCallback(async () => {
    if (!userData?.id || !user?.id) return;
    const trimmed = input.trim();
    setSaving(true);
    try {
      if (trimmed) {
        await setNickname(user.id, userData.id, trimmed);
      } else {
        await removeNickname(user.id, userData.id);
      }
      onSaved?.(trimmed);
      toast.success(t('chat.nickname_saved') || 'Nickname saved');
      onClose?.();
    } catch (err) {
      console.error('Error saving nickname:', err);
      toast.error(t('common.error') || 'Error');
    } finally {
      setSaving(false);
    }
  }, [userData?.id, user?.id, input, onSaved, onClose, t]);

  const handleRemove = useCallback(async () => {
    if (!userData?.id || !user?.id) return;
    setSaving(true);
    try {
      await removeNickname(user.id, userData.id);
      onSaved?.('');
      toast.success(t('chat.nickname_removed') || 'Nickname removed');
      onClose?.();
    } catch (err) {
      console.error('Error removing nickname:', err);
      toast.error(t('common.error') || 'Error');
    } finally {
      setSaving(false);
    }
  }, [userData?.id, user?.id, onSaved, onClose, t]);

  if (!userData) return null;

  return createPortal(
    <div className="chat-nickname-overlay" onClick={close}>
      <div className="chat-nickname-modal" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="chat-nickname-modal-header">
          <h3 className="fc-modal-title">{currentName ? (t('chat.edit_nickname') || 'Edit nickname') : (t('chat.set_nickname') || 'Set nickname')}</h3>
          <button className="chat-nickname-modal-close" onClick={close} title={t('modal.cancel') || 'Cancel'}>
            <FaTimes />
          </button>
        </div>

        <div className="chat-nickname-modal-body">
          <div
            className="fc-preview-card fc-preview-card--large"
            style={{
              '--accent-color': userData?.accent_color || 'transparent',
              '--accent-color-2': userData?.accent_color_secondary || userData?.accent_color || 'transparent',
            }}
          >
            <div className="fc-preview-card-banner" style={{ position: 'relative', overflow: 'hidden' }}>
              {userData?.banner_url ? (
                <img
                  src={userData.banner_url}
                  alt=""
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    ...getImageStyle(userData?.banner_position),
                  }}
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              ) : null}
              <div className="fc-preview-card-overlay"></div>

              <div className="fc-preview-card-avatar">
                <img
                  src={userData?.avatar_url || DEFAULT_AVATAR}
                  alt={userData?.username || ''}
                  style={getImageStyle(userData?.avatar_position)}
                  onError={(e) => { e.target.src = DEFAULT_AVATAR; }}
                />
              </div>

              <div className="fc-preview-card-info" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <div style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  <span className="fc-preview-card-name">
                    <EmojiText text={input.trim() || userData?.displayname || userData?.username || t('common.unknown')} />
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 400, opacity: 0.6, color: 'rgba(255,255,255,0.7)' }}>
                    @{userData?.username || ''}
                  </span>
                  {Array.isArray(userData?.roles) && userData.roles.some(r => r !== 'user') && (
                    <Badge roles={userData.roles} />
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 1, fontSize: '0.7rem', color: 'rgba(255,255,255,0.7)', textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
                  <span style={{ display: 'flex', gap: 2 }}>
                    <strong style={{ color: '#fff', fontWeight: 700, fontSize: '0.75rem' }}>{userData?.followerCount || 0}</strong>
                    {t('profile.followers')}
                  </span>
                </div>

                {(userData?.bio || userData?.pronouns) && (
                  <p style={{ margin: 0, fontSize: '0.7rem', lineHeight: 1.4, color: 'rgba(255,255,255,0.75)', textShadow: '0 1px 2px rgba(0,0,0,0.6)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                    <EmojiText text={userData?.bio || ''} />
                    {userData?.bio && userData?.pronouns && (
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.5 }}> · <EmojiText text={userData.pronouns} /></span>
                    )}
                    {!userData?.bio && userData?.pronouns && (
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.5 }}><EmojiText text={userData.pronouns} /></span>
                    )}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* ── Explore card preview ── */}
          <div className={`explore-card${(userData?.accent_color || userData?.accent_color_secondary) ? ' explore-card--accent' : ''}`}
            style={{
              '--accent-color': userData?.accent_color || 'transparent',
              '--accent-color-2': userData?.accent_color_secondary || userData?.accent_color || 'transparent',
            }}
          >
            <div className="explore-card-banner">
              {userData?.banner_url ? (
                <img
                  className="explore-card-banner-img"
                  src={userData.banner_url}
                  alt=""
                  style={getImageStyle(userData?.banner_position)}
                />
              ) : (
                <div className="explore-card-banner" style={{ background: 'var(--color-surface, #1a1a1a)' }} />
              )}
              <div className="explore-card-overlay" />
            </div>
            <div className="explore-card-body">
              <Avatar
                className="explore-card-avatar"
                src={userData?.avatar_url || DEFAULT_AVATAR}
                alt={userData?.username || ''}
                style={getImageStyle(userData?.avatar_position)}
              />
              <div className="explore-card-info">
                <div className="explore-card-name-row">
                  <span className="explore-card-name">
                    <EmojiText text={input.trim() || userData?.displayname || userData?.username || t('common.unknown')} />
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 400, opacity: 0.5 }}>@{userData?.username || ''}</span>
                  {Array.isArray(userData?.roles) && userData.roles.some(r => r !== 'user') && (
                    <Badge roles={userData.roles} />
                  )}
                </div>
                <span className="explore-card-followers">
                  {userData?.followerCount || 0} {userData?.followerCount === 1 ? t('explore.followers_singular') : t('explore.followers_plural')}
                </span>
                {(userData?.bio || userData?.pronouns) && (
                  <p className="explore-card-bio">
                    <EmojiText text={userData?.bio || ''} />
                    {userData?.bio && userData?.pronouns && <span> · <EmojiText text={userData?.pronouns} /></span>}
                    {!userData?.bio && userData?.pronouns && <span><EmojiText text={userData?.pronouns} /></span>}
                  </p>
                )}
              </div>
              <div className="explore-card-action">
                <button type="button" className="follow-btn follow-btn--follow" disabled>
                  {t('follow.follow')}
                </button>
              </div>
            </div>
          </div>

          {/* ── Nickname input (mismas clases que el modal de editar perfil) ── */}
          <label className="fc-modal-label" style={{ marginBottom: 0 }}>
            {t('chat.nickname_placeholder') || 'Enter a nickname...'}
            <input
              ref={inputRef}
              className="fc-modal-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('chat.nickname_placeholder') || 'Enter a nickname...'}
              maxLength={50}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') close(); }}
            />
            <span className="fc-modal-char-count">{input.length}/50</span>
            <div className="fc-modal-emoji-row">
              <EmojiPickerButton
                title={t('common.emoji') || 'Emoji'}
                textareaRef={inputRef}
                value={input}
                onChange={setInput}
              />
            </div>
          </label>
        </div>

        {/* ── Footer ── */}
        <div className="chat-nickname-modal-footer">
          <button
            className="fc-modal-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? (t('modal.saving') || 'Saving...') : (t('common.save') || 'Save')}
          </button>
          {currentName && (
            <button
              className="fc-modal-save--danger"
              onClick={handleRemove}
              disabled={saving}
            >
              {t('common.delete') || 'Remove'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
