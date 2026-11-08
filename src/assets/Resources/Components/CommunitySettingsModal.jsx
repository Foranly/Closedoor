import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FaCamera,
  FaSpinner,
  FaTimes,
  FaGlobe,
  FaLock,
  FaPlus,
  FaTrash,
  FaComment,
} from 'react-icons/fa';
import ModalShell from './ModalShell';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { uploadWithLocalPreview } from '../../services/cdnService';
import { extractColors } from '../../services/colorExtractor';
import {
  updateCommunity,
  COMMUNITY_NAME_MAX,
  COMMUNITY_DESC_MAX,
} from '../../services/communityService';
import { SUGGESTED_INTERESTS } from '../../services/communityInterests';
import './css/modal.css';
import '../../Pages/styles/communities.css';

// Caché de colores extraídos por URL de banner (persiste entre aperturas, igual
// que en CreateCommunityModal).
const colorCache = {};

/**
 * CommunitySettingsModal — ajustes de una comunidad (solo dueño).
 *
 * Es el mismo modal que el de creación (ModalShell + community-create-modal):
 * mismo header con la acción primaria a la derecha, misma preview de
 * avatar/banner, mismas cards y mismos controles. Sin pestañas: todo a la vista
 * en tres columnas, como el resto de modales del producto.
 *
 *   col 1: imagen · nombre · descripción · reglas
 *   col 2: intereses · color de acento · privacidad
 *   col 3: invitaciones · roles
 *
 * Los campos viven en estado local y se persisten juntos con "Guardar cambios".
 */
export default function CommunitySettingsModal({
  isOpen,
  onClose,
  community,
  onSaved,
  roles = [],
  onCreateRole,
  onDeleteRole,
  myInvite = null,
  inviteUrl,
  onCopyInvite,
  onCreateInvite,
  onDeleteInvite,
  onShareInvite,
}) {
  const { t } = useI18n();
  const { user } = useAuth();

  // Drafts: se rellenan desde la comunidad al abrir y solo se persisten al
  // pulsar "Guardar cambios" (igual que la creación, que guarda todo de golpe).
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rulesText, setRulesText] = useState('');
  const [interests, setInterests] = useState([]);
  const [interestInput, setInterestInput] = useState('');
  const [showSuggested, setShowSuggested] = useState(false);
  const [avatar, setAvatar] = useState('');
  const [banner, setBanner] = useState('');
  const [accentColor, setAccentColor] = useState('');
  const [accentSecondary, setAccentSecondary] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isMature, setIsMature] = useState(false);

  const [extractedColors, setExtractedColors] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  // Subida en vuelo: bloquea guardar mientras la URL real del CDN no llega
  // (un blob: solo lo vería quien lo subió).
  const [uploading, setUploading] = useState(false);

  // ── Rellenar drafts al abrir ──
  useEffect(() => {
    if (!isOpen || !community) return;
    setName(community.name || '');
    setDescription(community.description || '');
    setRulesText(Array.isArray(community.rules) ? community.rules.join('\n') : '');
    setInterests(Array.isArray(community.interests) ? community.interests : []);
    setInterestInput('');
    setShowSuggested(false);
    setAvatar(community.avatar_url || '');
    setBanner(community.banner_url || '');
    setAccentColor(community.accent_color || '');
    setAccentSecondary(community.accent_color_secondary || '');
    setIsPrivate(community.is_private === true);
    setIsMature(community.is_mature === true);
    setSaving(false);
    setUploading(false);
    // Solo al abrir (o al cambiar de comunidad): editar no debe reiniciar los
    // campos cuando llega una actualización de la fila de la comunidad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, community?.id]);

  // ── Colores del banner (mismo comportamiento que el modal de creación) ──
  const bannerUrl = banner.trim();
  useEffect(() => {
    if (!bannerUrl) {
      setExtractedColors([]);
      setExtracting(false);
      return undefined;
    }
    if (colorCache[bannerUrl]) {
      setExtractedColors(colorCache[bannerUrl]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        setExtracting(true);
        const colors = await extractColors(bannerUrl);
        if (!cancelled && colors.length >= 4) {
          setExtractedColors(colors);
          colorCache[bannerUrl] = colors;
        }
      } catch {
        /* silencioso: sin colores extraídos se pueden usar los selectores */
      } finally {
        if (!cancelled) setExtracting(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bannerUrl]);

  // ── Subida de avatar/banner ──
  const handleFileUpload = async (e, type) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('modal.invalid_image_type'));
      return;
    }
    setUploading(true);
    try {
      const { localUrl, realUrlPromise } = uploadWithLocalPreview(file, user.id, type);
      if (type === 'avatar') setAvatar(localUrl);
      else setBanner(localUrl);
      const realUrl = await realUrlPromise;
      if (type === 'avatar') setAvatar(realUrl);
      else setBanner(realUrl);
      toast.success(t('upload.uploaded'), { autoClose: 2000 });
    } catch (err) {
      console.error('CDN upload error:', err);
      toast.error(err.message || t('comunidades.error'));
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const addInterest = () => {
    const val = interestInput.trim();
    if (val && !interests.includes(val)) setInterests((prev) => [...prev, val]);
    setInterestInput('');
  };

  const removeInterest = (interest) => {
    setInterests((prev) => prev.filter((x) => x !== interest));
  };

  // ── Guardar ──
  const handleSave = async () => {
    if (!community?.id) return;
    const cleanName = name.trim();
    if (cleanName.length < 3) {
      toast.error(t('comunidades.name_min'));
      return;
    }
    if (avatar.startsWith('blob:') || banner.startsWith('blob:')) {
      toast.error(t('comunidades.media_uploading'));
      return;
    }

    setSaving(true);
    try {
      const updated = await updateCommunity(community.id, {
        name: cleanName,
        description,
        rules: rulesText.split('\n').map((r) => r.trim()).filter(Boolean),
        interests,
        avatar_url: avatar.trim() || null,
        banner_url: banner.trim() || null,
        accent_color: accentColor || null,
        accent_color_secondary: accentSecondary || null,
        is_private: isPrivate,
        is_mature: isMature,
      });
      toast.success(t('comunidades.settings_saved'));
      if (onSaved) onSaved(updated);
      onClose();
    } catch (err) {
      console.error('[Community] Error saving settings:', err);
      toast.error(err.message || t('comunidades.error'));
    } finally {
      setSaving(false);
    }
  };

  if (!community) {
    return <ModalShell isOpen={false} onClose={onClose} className="community-create-modal community-settings-modal" />;
  }

  const previewHasAccent = !!(accentColor || accentSecondary);

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      className="community-create-modal community-settings-modal"
    >
      {/* Header: mismo patrón que el modal de creación */}
      <div className="fc-modal-header">
        <h3 className="fc-modal-title">{t('comunidades.settings')}</h3>
        <div className="fc-modal-header-actions">
          <button className="fc-modal-save" onClick={handleSave} disabled={saving || uploading}>
            {saving ? <FaSpinner className="fc-spin" /> : t('comunidades.save_changes')}
          </button>
          <button type="button" className="fc-modal-close" onClick={onClose} aria-label={t('common.close')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="community-settings-grid">
        {/* ══ Columna 1: imagen · nombre · descripción · reglas ══ */}
        <div className="community-settings-col">
          <div
            className={`community-create-preview${previewHasAccent ? ' community-create-preview--accent' : ''}`}
            style={{
              '--cc-accent': accentColor || accentSecondary || 'transparent',
              '--cc-accent-2': accentSecondary || accentColor || 'transparent',
            }}
          >
            <div className="community-create-preview-banner">
              {banner.trim() ? (
                <img src={banner.trim()} alt="" onError={(e) => { e.target.style.display = 'none'; }} />
              ) : (
                <div className="community-create-preview-banner-empty" />
              )}
              <button
                type="button"
                className="fc-preview-banner-edit"
                onClick={(e) => { e.stopPropagation(); document.getElementById('cc-settings-banner-input')?.click(); }}
                title={t('comunidades.banner')}
              >
                <FaCamera />
              </button>
              <input
                id="cc-settings-banner-input"
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => handleFileUpload(e, 'banner')}
              />
              <div className="community-create-preview-avatar-wrap">
                <div className="community-create-preview-avatar">
                  {avatar.trim() ? (
                    <img src={avatar.trim()} alt="" onError={(e) => { e.target.src = ''; }} />
                  ) : (
                    <span className="community-create-preview-avatar-letter">
                      {(name.trim() || community.slug || 'C').charAt(0).toUpperCase()}
                    </span>
                  )}
                  <button
                    type="button"
                    className="fc-preview-avatar-edit"
                    onClick={() => document.getElementById('cc-settings-avatar-input')?.click()}
                    title={t('comunidades.avatar')}
                  >
                    <FaCamera />
                  </button>
                  <input
                    id="cc-settings-avatar-input"
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    style={{ display: 'none' }}
                    onChange={(e) => handleFileUpload(e, 'avatar')}
                  />
                </div>
              </div>
            </div>
            <div className="community-create-preview-info">
              <span className="community-create-preview-name">{name.trim() || t('comunidades.name_placeholder')}</span>
              {isPrivate && (
                <span className="community-create-preview-private"><FaLock /> {t('comunidades.private')}</span>
              )}
            </div>
          </div>

          <div className="fc-modal-card">
            <label className="fc-modal-label">
              <span className="community-settings-label-row">
                {t('comunidades.name')}
                {/* El slug no se edita (cambiarlo rompería los enlaces
                    c/<slug>): se muestra junto al título del campo. */}
                {community.slug && (
                  <span className="community-settings-slug">c/{community.slug}</span>
                )}
              </span>
              <input
                className="fc-modal-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('comunidades.name_placeholder')}
                maxLength={COMMUNITY_NAME_MAX}
              />
              <span className="fc-modal-char-count">{name.length}/{COMMUNITY_NAME_MAX}</span>
            </label>

            <label className="fc-modal-label">
              {t('comunidades.description')}
              <textarea
                className="fc-modal-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={COMMUNITY_DESC_MAX}
                placeholder={t('comunidades.description_placeholder')}
              />
              <span className="fc-modal-char-count">{description.length}/{COMMUNITY_DESC_MAX}</span>
            </label>

            <label className="fc-modal-label" style={{ marginTop: 2 }}>
              {t('comunidades.rules')}
              <textarea
                className="fc-modal-input"
                value={rulesText}
                onChange={(e) => setRulesText(e.target.value)}
                rows={4}
                maxLength={1000}
                placeholder={t('comunidades.rules_placeholder')}
              />
              <span className="fc-modal-input-hint">{t('comunidades.rules_hint')}</span>
            </label>
          </div>
        </div>

        {/* ══ Columna 2: intereses · acento · privacidad ══ */}
        <div className="community-settings-col">
          {/* Intereses */}
          <div className="fc-modal-card">
            <label className="fc-modal-label">{t('comunidades.interests')}</label>
            <div className="fc-modal-interests-input-row">
              <input
                className="fc-modal-input fc-modal-interests-input"
                value={interestInput}
                onChange={(e) => setInterestInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addInterest();
                  }
                }}
                placeholder={t('comunidades.interests_placeholder')}
              />
              <button
                type="button"
                className="fc-modal-interests-add"
                onClick={addInterest}
                disabled={!interestInput.trim()}
              >
                +
              </button>
            </div>
            {interests.length > 0 && (
              <div className="fc-modal-interests-pills">
                {interests.map((interest) => (
                  <span key={interest} className="fc-modal-interest-pill">
                    {interest}
                    <button
                      type="button"
                      className="fc-modal-interest-pill-remove"
                      onClick={() => removeInterest(interest)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="fc-modal-suggested-wrapper">
              <button
                type="button"
                className="fc-modal-suggested-toggle"
                onClick={() => setShowSuggested((prev) => !prev)}
              >
                <span>{t('modal.suggested_interests')}</span>
                <svg className={`fc-modal-suggested-chevron ${showSuggested ? 'fc-modal-suggested-chevron--open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <div className={`fc-modal-suggested-collapse ${showSuggested ? 'fc-modal-suggested-collapse--open' : ''}`}>
                <div className="fc-modal-suggested-list">
                  {SUGGESTED_INTERESTS.filter((s) => !interests.includes(s)).map((interest) => (
                    <button
                      key={interest}
                      type="button"
                      className="fc-modal-suggested-chip"
                      onClick={() => setInterests((prev) => [...prev, interest])}
                    >
                      + {interest}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Acento primario + secundario */}
          <div className="fc-modal-card">
            <label className="fc-modal-label">{t('comunidades.accent_color')}</label>
            {banner.trim() && extracting && <p className="fc-modal-social-hint">{t('modal.extracting_colors')}</p>}
            {banner.trim() && !extracting && extractedColors.length < 4 && (
              <p className="fc-modal-social-hint">{t('modal.add_banner_hint')}</p>
            )}

            <div className="fc-modal-color-section">
              <span className="fc-modal-color-subtitle">{t('modal.color_primary')}</span>
              <div className="fc-modal-color-picker">
                {banner.trim() && !extracting && extractedColors.length >= 4 && extractedColors.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`fc-modal-color-swatch ${accentColor === color ? 'fc-modal-color-swatch--selected' : ''}`}
                    style={{ '--swatch-color': color }}
                    onClick={() => setAccentColor(color)}
                    title={color}
                  >
                    {accentColor === color && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                ))}
                <label
                  htmlFor="community-settings-accent-input"
                  className="fc-modal-color-swatch"
                  style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: accentColor || '#000000',
                    border: '2px solid var(--color-border, #2a2a2a)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  title={`${t('modal.accent_color_custom')}: ${accentColor || '#000000'}`}
                >
                  <input
                    id="community-settings-accent-input"
                    type="color"
                    value={accentColor || '#000000'}
                    onChange={(e) => setAccentColor(e.target.value)}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
                  />
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </label>
              </div>
            </div>

            <div className="fc-modal-color-section">
              <span className="fc-modal-color-subtitle">{t('modal.accent_color_secondary')}</span>
              <div className="fc-modal-color-picker">
                <label
                  htmlFor="community-settings-accent-secondary-input"
                  className="fc-modal-color-swatch"
                  style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: accentSecondary || '#000000',
                    border: '2px solid var(--color-border, #2a2a2a)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  title={`${t('modal.accent_color_secondary')}: ${accentSecondary || '#000000'}`}
                >
                  <input
                    id="community-settings-accent-secondary-input"
                    type="color"
                    value={accentSecondary || '#000000'}
                    onChange={(e) => setAccentSecondary(e.target.value)}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
                  />
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </label>
                {accentSecondary && (
                  <button
                    type="button"
                    onClick={() => setAccentSecondary('')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--color-text-muted, #6b7280)',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      padding: '2px 6px',
                    }}
                  >
                    {t('common.clear')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Privacidad + +18 */}
          <div className="fc-modal-card">
            <label className="fc-modal-label">{t('comunidades.privacy')}</label>
            <div className="community-create-privacy-row">
              <button
                type="button"
                className={`community-create-privacy-opt ${!isPrivate ? 'community-create-privacy-opt--active' : ''}`}
                onClick={() => setIsPrivate(false)}
              >
                <FaGlobe className="community-create-privacy-icon" />
                <span>
                  <strong>{t('comunidades.privacy_public')}</strong>
                  <small>{t('comunidades.privacy_public_hint')}</small>
                </span>
              </button>
              <button
                type="button"
                className={`community-create-privacy-opt ${isPrivate ? 'community-create-privacy-opt--active' : ''}`}
                onClick={() => setIsPrivate(true)}
              >
                <FaLock className="community-create-privacy-icon" />
                <span>
                  <strong>{t('comunidades.privacy_private')}</strong>
                  <small>{t('comunidades.privacy_private_hint')}</small>
                </span>
              </button>
            </div>

            <div className="community-create-mature-row">
              <div className="community-create-mature-info">
                <strong>{t('comunidades.mature')}</strong>
                <small>{t('comunidades.mature_hint')}</small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isMature}
                className={`community-create-mature-switch${isMature ? ' community-create-mature-switch--on' : ''}`}
                onClick={() => setIsMature((prev) => !prev)}
              >
                <span className="community-create-mature-knob" />
              </button>
            </div>
          </div>
        </div>

        {/* ══ Columna 3: invitaciones · roles ══ */}
        <div className="community-settings-col">
          <div className="fc-modal-card">
            <label className="fc-modal-label">{t('comunidades.invites')}</label>
            <div className="community-settings-invites">
              <button
                type="button"
                className="community-invite-create"
                onClick={() => onCreateInvite?.()}
                disabled={!!myInvite}
              >
                <FaPlus /> {t('comunidades.invite_create')}
              </button>
              {myInvite && (
                <p className="community-invite-limit">{t('comunidades.invite_limit')}</p>
              )}
              {myInvite ? (
                <div className="community-invite-row">
                  <code className="community-invite-token">{inviteUrl?.(myInvite)}</code>
                  <button type="button" className="community-invite-copy" onClick={() => onCopyInvite?.(myInvite)}>
                    {t('comunidades.invite_copy')}
                  </button>
                  <button
                    type="button"
                    className="community-invite-chat"
                    title={t('comunidades.invite_send_chat')}
                    onClick={() => onShareInvite?.()}
                  >
                    <FaComment />
                  </button>
                  <button type="button" className="community-invite-del" onClick={() => onDeleteInvite?.(myInvite.id)}>
                    <FaTrash />
                  </button>
                </div>
              ) : (
                <p className="community-modal-empty">{t('comunidades.no_invites')}</p>
              )}
            </div>
          </div>

          <div className="fc-modal-card">
            <label className="fc-modal-label">{t('comunidades.roles')}</label>
            <div className="community-roles-bar-list">
              {roles.map((r) => (
                <span key={r.id} className="community-role-chip" style={{ '--cc-role': r.color || '#6366f1' }}>
                  {r.name}
                  <button type="button" onClick={() => onDeleteRole?.(r)}><FaTimes /></button>
                </span>
              ))}
              <button type="button" className="community-roles-bar-add" onClick={() => onCreateRole?.()}>
                <FaPlus /> {t('comunidades.role_create')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
