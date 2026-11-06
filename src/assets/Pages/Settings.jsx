import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../services/i18n/useI18n';
import usePageTitle from '../../hooks/usePageTitle';
import { useAuth } from '../../hooks/useAuth';
import { updateUserProfile } from '../services/userService';
import { clearAllAppCaches } from '../services/postService';
import { getBlockedUsers, getCachedBlockedUsers, unblockUser, cacheBlockStatus, subscribeBlockChanges, clearBlockedListsCache } from '../services/blockService';
import { useNavigate } from 'react-router-dom';
import { getItem } from '../services/secureStorage';
import { isWindowZoomAvailable, controlWindowZoom, isDesktopApp } from '../services/desktopApp';
import { listOpenApps, isOpenAppsAvailable } from '../../hooks/useLocalActivity';
import { APP_LOGO_CREDIT_URL } from '../services/appLogos';
import ProgramLogo from '../Resources/Components/ProgramLogo';
import { getActivitySettings, readActivityHistory, clearActivityHistory, persistActivity, persistProgramActivity, programFromProfile } from '../services/activityService';
import { supabase } from '../services/supabaseclient';
import { getNicknames, getCachedNicknames, cacheNicknames, setNickname, removeNickname } from '../services/chatService';
import { FaGlobe, FaPalette, FaLock, FaChevronDown, FaChevronRight, FaCheck, FaSun, FaMoon, FaEyeSlash, FaCog, FaFeather, FaHeart, FaHeartBroken, FaComment, FaRetweet, FaEye, FaUser, FaBookmark, FaTags, FaChartBar, FaBell, FaBrush, FaBan, FaClock, FaAt, FaTrashAlt, FaTimes, FaDiscord, FaEdit, FaImage, FaCompress, FaUndo, FaGamepad, FaHistory, FaMusic, FaTv, FaDesktop, FaBars } from 'react-icons/fa';
import { MdLogout } from 'react-icons/md';
import { toast } from 'react-toastify';
import ConfirmModal from '../Resources/Components/ConfirmModal';
import ModalShell from '../Resources/Components/ModalShell';
import '../Resources/Styles/settings.css';

/* Entradas visibles del historial de actividad antes de desplegar el resto. */
const ACTIVITY_HISTORY_PREVIEW = 3;

/* Menú de programas: medidas con las que se decide abrir hacia arriba o abajo. */
const PROGRAM_MENU_WIDTH = 300;
const PROGRAM_MENU_MAX_HEIGHT = 380;

/* ── SVG Flag Icons ── */

const FlagEs = () => (
  <svg viewBox="0 0 24 18" width="22" height="16" className="settings-flag">
    <rect width="24" height="18" fill="#c60b1e" />
    <rect y="3" width="24" height="12" fill="#ffc400" />
    <rect y="15" width="24" height="3" fill="#c60b1e" />
  </svg>
);

const FlagEn = () => (
  <svg viewBox="0 0 24 18" width="22" height="16" className="settings-flag">
    <rect width="24" height="18" fill="#012169" />
    <path d="M0 0 L24 18 M24 0 L0 18" stroke="#fff" strokeWidth="3.5" />
    <path d="M0 0 L24 18 M24 0 L0 18" stroke="#c8102e" strokeWidth="1.5" />
    <rect x="10" y="0" width="4" height="18" fill="#fff" />
    <rect x="10" y="0" width="4" height="18" fill="#c8102e" strokeWidth="1.5" />
    <rect x="0" y="6" width="24" height="6" fill="#fff" />
    <rect x="0" y="6" width="24" height="6" fill="#c8102e" strokeWidth="1.5" />
  </svg>
);

const FlagRu = () => (
  <svg viewBox="0 0 24 18" width="22" height="16" className="settings-flag">
    <rect width="24" height="18" fill="#fff" />
    <rect y="6" width="24" height="6" fill="#0039a6" />
    <rect y="12" width="24" height="6" fill="#d52b1e" />
  </svg>
);

const FlagJa = () => (
  <svg viewBox="0 0 24 18" width="22" height="16" className="settings-flag">
    <rect width="24" height="18" fill="#fff" rx="1" />
    <circle cx="12" cy="9" r="5" fill="#bc002d" />
  </svg>
);

const FlagPt = () => (
  <svg viewBox="0 0 24 18" width="22" height="16" className="settings-flag">
    <rect width="9.6" height="18" fill="#006600" />
    <rect x="9.6" width="14.4" height="18" fill="#ff0000" />
    <circle cx="9.6" cy="9" r="3.2" fill="#ffcc00" />
    <circle cx="9.6" cy="9" r="1.5" fill="#006600" />
  </svg>
);

const LANGUAGES = [
  { value: 'es', Flag: FlagEs },
  { value: 'en', Flag: FlagEn },
  { value: 'ru', Flag: FlagRu },
  { value: 'ja', Flag: FlagJa },
  { value: 'pt', Flag: FlagPt },
];

const CATEGORIES = [
  { id: 'account', icon: FaLock, titleKey: 'settings.category_account', descKey: 'settings.category_account_desc' },
  { id: 'system', icon: FaCog, titleKey: 'settings.category_system', descKey: 'settings.category_system_desc' },
  { id: 'profile', icon: FaUser, titleKey: 'settings.category_profile', descKey: 'settings.category_profile_desc' },
  { id: 'privacy', icon: FaEyeSlash, titleKey: 'settings.category_privacy', descKey: 'settings.category_privacy_desc' },
  { id: 'activity', icon: FaGamepad, titleKey: 'settings.category_activity', descKey: 'settings.category_activity_desc' },
  { id: 'notifications', icon: FaBell, titleKey: 'settings.category_notifications', descKey: 'settings.category_notifications_desc' },
];

/* ── Cuenta: nombre de usuario, correo y contraseña ──
   Los tres cambios exigen la contraseña ACTUAL: el servidor la verifica con
   bcrypt (RPC verify_password, migración 075) y aplica throttle. Los métodos
   de AuthContext devuelven códigos estables que aquí se traducen. */
function AccountSettings({ t }) {
  const { user, profile, changeUsername, changeEmail, changePassword } = useAuth();
  const [uForm, setUForm] = useState({ value: '', password: '', saving: false, result: null });
  const [eForm, setEForm] = useState({ value: '', password: '', saving: false, result: null });
  const [pForm, setPForm] = useState({ current: '', next: '', confirm: '', saving: false, result: null });
  // Los formularios arrancan plegados: solo se muestran los inputs del que el
  // usuario decide cambiar, en vertical y uno a la vez.
  const [openForm, setOpenForm] = useState(null);

  const toggleForm = (name) => setOpenForm((current) => (current === name ? null : name));

  const messages = {
    invalid_username: t('settings.account_err_invalid_username'),
    invalid_password: t('settings.account_err_invalid_password'),
    not_authenticated: t('settings.account_err_not_authenticated'),
    same: t('settings.account_err_same_username'),
    taken: t('settings.account_err_username_taken'),
    invalid_email: t('settings.account_err_invalid_email'),
    email_domain: t('settings.account_err_email_domain'),
    same_email: t('settings.account_err_same_email'),
    email_taken: t('settings.account_err_email_taken'),
    weak_password: t('settings.account_err_weak_password'),
    password_too_long: t('settings.account_err_password_too_long'),
    same_password: t('settings.account_err_same_password'),
    password_mismatch: t('settings.account_err_password_mismatch'),
    generic: t('settings.account_err_generic'),
  };

  const failText = (res) => messages[res?.code] || messages.generic;

  const submitUsername = async (event) => {
    event.preventDefault();
    if (uForm.saving) return;
    if (!uForm.value.trim()) {
      setUForm((f) => ({ ...f, result: { ok: false, text: messages.invalid_username } }));
      return;
    }
    setUForm((f) => ({ ...f, saving: true, result: null }));
    const res = await changeUsername(uForm.value, uForm.password);
    setUForm((f) => ({
      ...f,
      saving: false,
      password: res.success ? '' : f.password,
      value: res.success ? '' : f.value,
      result: res.success
        ? { ok: true, text: t('settings.account_username_updated') }
        : { ok: false, text: failText(res) },
    }));
    if (res.success) setOpenForm(null);
  };

  const submitEmail = async (event) => {
    event.preventDefault();
    if (eForm.saving) return;
    if (!eForm.value.trim()) {
      setEForm((f) => ({ ...f, result: { ok: false, text: messages.invalid_email } }));
      return;
    }
    setEForm((f) => ({ ...f, saving: true, result: null }));
    const res = await changeEmail(eForm.value, eForm.password);
    setEForm((f) => ({
      ...f,
      saving: false,
      password: res.success ? '' : f.password,
      value: res.success ? '' : f.value,
      result: res.success
        ? { ok: true, text: t('settings.account_email_sent') }
        : { ok: false, text: failText(res) },
    }));
    if (res.success) setOpenForm(null);
  };

  const submitPassword = async (event) => {
    event.preventDefault();
    if (pForm.saving) return;
    if (pForm.next !== pForm.confirm) {
      setPForm((f) => ({ ...f, result: { ok: false, text: messages.password_mismatch } }));
      return;
    }
    setPForm((f) => ({ ...f, saving: true, result: null }));
    const res = await changePassword(pForm.next, pForm.current);
    setPForm((f) => ({
      ...f,
      saving: false,
      current: res.success ? '' : f.current,
      next: res.success ? '' : f.next,
      confirm: res.success ? '' : f.confirm,
      result: res.success
        ? { ok: true, text: t('settings.account_password_updated') }
        : { ok: false, text: failText(res) },
    }));
    if (res.success) setOpenForm(null);
  };

  const feedback = (result) => (
    result ? (
      <p className={`settings-account-feedback ${result.ok ? 'settings-account-feedback--ok' : 'settings-account-feedback--err'}`}>
        {result.text}
      </p>
    ) : null
  );

  return (
    <>
      {/* ── Nombre de usuario ── */}
      <form className="settings-account-form" onSubmit={submitUsername}>
        <div className="settings-row">
          <div className="settings-row-header">
            <span className="settings-section-icon"><FaUser /></span>
            <div className="settings-account-heading">
              <h2 className="settings-section-title">{t('settings.account_username')}</h2>
              <p className="settings-section-desc">
                {t('settings.account_username_desc', { username: profile?.username || '—' })}
              </p>
            </div>
            <button
              type="button"
              className="settings-edit-btn settings-account-toggle"
              onClick={() => toggleForm('username')}
              aria-expanded={openForm === 'username'}
              aria-controls="account-username-fields"
            >
              {openForm === 'username' ? t('common.cancel') : t('common.edit')}
            </button>
          </div>
          {openForm === 'username' && (
            <div className="settings-account-fields" id="account-username-fields">
              <input
                className="settings-account-input"
                type="text"
                name="new-username"
                autoComplete="username"
                spellCheck={false}
                maxLength={20}
                placeholder={t('settings.account_new_username')}
                aria-label={t('settings.account_new_username')}
                value={uForm.value}
                disabled={uForm.saving}
                onChange={(e) => setUForm((f) => ({ ...f, value: e.target.value, result: null }))}
              />
              <input
                className="settings-account-input"
                type="password"
                name="current-password-username"
                autoComplete="current-password"
                placeholder={t('settings.account_current_password')}
                aria-label={t('settings.account_current_password')}
                value={uForm.password}
                disabled={uForm.saving}
                onChange={(e) => setUForm((f) => ({ ...f, password: e.target.value, result: null }))}
              />
              <button
                type="submit"
                className="settings-account-submit"
                disabled={uForm.saving || !uForm.value.trim() || !uForm.password}
              >
                {uForm.saving ? t('common.loading') : t('settings.account_save')}
              </button>
            </div>
          )}
          {feedback(uForm.result)}
        </div>
      </form>

      {/* ── Correo electrónico ── */}
      <form className="settings-account-form" onSubmit={submitEmail}>
        <div className="settings-row">
          <div className="settings-row-header">
            <span className="settings-section-icon"><FaAt /></span>
            <div className="settings-account-heading">
              <h2 className="settings-section-title">{t('settings.account_email')}</h2>
              <p className="settings-section-desc">
                {t('settings.account_email_desc', { email: user?.email || '—' })}
              </p>
            </div>
            <button
              type="button"
              className="settings-edit-btn settings-account-toggle"
              onClick={() => toggleForm('email')}
              aria-expanded={openForm === 'email'}
              aria-controls="account-email-fields"
            >
              {openForm === 'email' ? t('common.cancel') : t('common.edit')}
            </button>
          </div>
          {openForm === 'email' && (
            <div className="settings-account-fields" id="account-email-fields">
              <input
                className="settings-account-input"
                type="email"
                name="new-email"
                autoComplete="email"
                spellCheck={false}
                placeholder={t('settings.account_new_email')}
                aria-label={t('settings.account_new_email')}
                value={eForm.value}
                disabled={eForm.saving}
                onChange={(e) => setEForm((f) => ({ ...f, value: e.target.value, result: null }))}
              />
              <input
                className="settings-account-input"
                type="password"
                name="current-password-email"
                autoComplete="current-password"
                placeholder={t('settings.account_current_password')}
                aria-label={t('settings.account_current_password')}
                value={eForm.password}
                disabled={eForm.saving}
                onChange={(e) => setEForm((f) => ({ ...f, password: e.target.value, result: null }))}
              />
              <button
                type="submit"
                className="settings-account-submit"
                disabled={eForm.saving || !eForm.value.trim() || !eForm.password}
              >
                {eForm.saving ? t('common.loading') : t('settings.account_save')}
              </button>
            </div>
          )}
          {feedback(eForm.result)}
        </div>
      </form>

      {/* ── Contraseña ── */}
      <form className="settings-account-form" onSubmit={submitPassword}>
        <div className="settings-row">
          <div className="settings-row-header">
            <span className="settings-section-icon"><FaLock /></span>
            <div className="settings-account-heading">
              <h2 className="settings-section-title">{t('settings.account_password')}</h2>
              <p className="settings-section-desc">{t('settings.account_password_desc')}</p>
            </div>
            <button
              type="button"
              className="settings-edit-btn settings-account-toggle"
              onClick={() => toggleForm('password')}
              aria-expanded={openForm === 'password'}
              aria-controls="account-password-fields"
            >
              {openForm === 'password' ? t('common.cancel') : t('common.edit')}
            </button>
          </div>
          {openForm === 'password' && (
            <div className="settings-account-fields" id="account-password-fields">
              <input
                className="settings-account-input"
                type="password"
                name="current-password"
                autoComplete="current-password"
                placeholder={t('settings.account_current_password')}
                aria-label={t('settings.account_current_password')}
                value={pForm.current}
                disabled={pForm.saving}
                onChange={(e) => setPForm((f) => ({ ...f, current: e.target.value, result: null }))}
              />
              <input
                className="settings-account-input"
                type="password"
                name="new-password"
                autoComplete="new-password"
                placeholder={t('settings.account_new_password')}
                aria-label={t('settings.account_new_password')}
                value={pForm.next}
                disabled={pForm.saving}
                onChange={(e) => setPForm((f) => ({ ...f, next: e.target.value, result: null }))}
              />
              <input
                className="settings-account-input"
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                placeholder={t('settings.account_confirm_password')}
                aria-label={t('settings.account_confirm_password')}
                value={pForm.confirm}
                disabled={pForm.saving}
                onChange={(e) => setPForm((f) => ({ ...f, confirm: e.target.value, result: null }))}
              />
              <button
                type="submit"
                className="settings-account-submit"
                disabled={pForm.saving || !pForm.current || !pForm.next || !pForm.confirm}
              >
                {pForm.saving ? t('common.loading') : t('settings.account_save')}
              </button>
            </div>
          )}
          {feedback(pForm.result)}
        </div>
      </form>
    </>
  );
}

/* ── Main Settings Component ── */

export default function Settings() {
  const { locale, setLocale, showAccent, setShowAccent, showAccentProfile, setShowAccentProfile, showAccentExplore, setShowAccentExplore, accentVisibility, setAccentVisibility, showProfileStats, setShowProfileStats, showToastNotifications, setShowToastNotifications, showGlobalBg, setShowGlobalBg, showCardsGlass, setShowCardsGlass, chatDefaultStyle, setChatDefaultStyle, sidebarDefaultStyle, setSidebarDefaultStyle, sidebarDefaultColors, setSidebarDefaultColors, showPushNotifications, setShowPushNotifications, showLikes, setShowLikes, filterEncrypted, setFilterEncrypted, allowMention, setAllowMention, allowEncryptedAdd, setAllowEncryptedAdd, hour24, setHour24, showBadges, setShowBadges, theme, setTheme, t } = useI18n();
  usePageTitle(t('settings.title'));
  const { user, profile, profileLoading, refreshProfile, logout, linkDiscord, isDiscordLinked } = useAuth();
  const navigate = useNavigate();
  const [selectOpen, setSelectOpen] = useState(false);
  const selectRef = useRef(null);
  const [privacyUpdating, setPrivacyUpdating] = useState(false);
  const [statsPrivacyUpdating, setStatsPrivacyUpdating] = useState(false);
  const [activeCategory, setActiveCategory] = useState('system');
  // ── Zoom de la ventana (solo tiene sentido en la app de escritorio) ──
  const zoomAvailable = isWindowZoomAvailable();
  const [zoomPercent, setZoomPercent] = useState(100);
  const [languageExpanded, setLanguageExpanded] = useState(false);
  const [appearanceExpanded, setAppearanceExpanded] = useState(false);
  const [accentExpanded, setAccentExpanded] = useState(false);
  const [cardsExpanded, setCardsExpanded] = useState(false);
  const [statsExpanded, setStatsExpanded] = useState(false);
  const [badgesExpanded, setBadgesExpanded] = useState(false);
  const [showBlockedModal, setShowBlockedModal] = useState(false);
  const [showNicknamesModal, setShowNicknamesModal] = useState(false);
  const [nicknameList, setNicknameList] = useState([]);
  const [nicknameListLoading, setNicknameListLoading] = useState(false);
  const [editingNickname, setEditingNickname] = useState({ userId: null, current: '' });
  const [removingNicknameId, setRemovingNicknameId] = useState(null);
  const [blockedUsers, setBlockedUsers] = useState(() => {
    if (!user?.id) return [];
    return getCachedBlockedUsers(user.id) || [];
  });
  const [blockedUsersLoading, setBlockedUsersLoading] = useState(() => {
    return !user?.id || !getCachedBlockedUsers(user.id);
  });
  const [unblockingId, setUnblockingId] = useState(null);
  const [showClearCacheModal, setShowClearCacheModal] = useState(false);
  const [cacheRevision, setCacheRevision] = useState(0);
  // ── Actividad (migración 080) ──
  const [activityUpdating, setActivityUpdating] = useState(false);
  const [showClearHistoryModal, setShowClearHistoryModal] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  // Programa compartido (migración 081) y la lista de programas abiertos que
  // detecta la app de escritorio para elegirlo.
  const [openApps, setOpenApps] = useState(null); // null = todavía cargando
  const [openAppsRevision, setOpenAppsRevision] = useState(0);
  const [programMenuOpen, setProgramMenuOpen] = useState(false);
  // Posición fija del menú calculada al abrirlo: así escapa del contenedor que
  // hace scroll y elige abrirse hacia arriba o hacia abajo según el hueco.
  const [programMenuPos, setProgramMenuPos] = useState(null);
  const programMenuRef = useRef(null);
  const programMenuListRef = useRef(null);
  const activitySettings = getActivitySettings(profile);
  // El historial vive en el localStorage del renderer, es decir, solo existe en
  // la app de escritorio (la web nunca detecta actividad).
  const isDesktop = isDesktopApp();
  const activityHistory = useMemo(
    () => (activeCategory === 'activity' && isDesktop ? readActivityHistory(user?.id) : []),
    [activeCategory, isDesktop, user?.id, historyRevision]
  );
  // Programa que el usuario comparte ahora mismo (columna de la migración 081).
  const selectedProgram = programFromProfile(profile)?.title || null;
  // Con la actividad apagada o en "nadie" no se escribe: el programa se publica
  // en la fila del perfil igual que la canción, así que comparte su privacidad.
  const programSelectable = activitySettings.enabled && activitySettings.visibility !== 'nobody';
  // Si el preload es anterior al listado de programas, la lista llega vacía sin
  // ser un fallo de detección: hay que reiniciar la app de escritorio.
  const appsApiReady = isOpenAppsAvailable();
  // Icono real del programa elegido (si sigue en la lista de abiertos).
  const selectedProgramEntry = selectedProgram
    ? (openApps || []).find((app) => app.name === selectedProgram)
    : null;

  // Programas abiertos en el equipo: se piden al entrar en la categoría (y al
  // pulsar "actualizar", que suma a openAppsRevision), no en cada render: es una
  // consulta al sistema. El estado se escribe tras el await para no encadenar
  // renders síncronos desde el efecto.
  useEffect(() => {
    if (activeCategory !== 'activity' || !isDesktop) return undefined;
    let alive = true;
    listOpenApps().then((apps) => {
      if (alive) setOpenApps(apps);
    });
    return () => {
      alive = false;
    };
  }, [activeCategory, isDesktop, openAppsRevision]);

  // Al cambiar de categoría el menú se cierra solo: si no, al volver a
  // Actividad aparecería abierto sin que el usuario lo pidiera.
  useEffect(() => () => setProgramMenuOpen(false), [activeCategory]);

  // Cierre del menú de programas al hacer clic fuera, con Escape, o si la página
  // se desplaza/redimensiona (su posición es fija y quedaría descolocado).
  useEffect(() => {
    if (!programMenuOpen) return undefined;

    const isInside = (node) => {
      const trigger = programMenuRef.current;
      const menu = programMenuListRef.current;
      return (
        (trigger && trigger.contains(node)) ||
        (menu && menu.contains(node))
      );
    };

    const handlePointer = (event) => {
      if (!isInside(event.target)) setProgramMenuOpen(false);
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') setProgramMenuOpen(false);
    };
    const handleScroll = (event) => {
      // Desplazarse dentro de la propia lista no debe cerrar el menú.
      if (isInside(event.target)) return;
      setProgramMenuOpen(false);
    };
    const handleResize = () => setProgramMenuOpen(false);

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    document.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [programMenuOpen]);

  // ── Calculate cache size ──
  const cacheSize = useMemo(() => {
    try {
      let total = 0;
      // Cuenta entradas encriptadas (prefijo _s) + legacy fc_* que aun existan
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('_s') || key.startsWith('fc_'))) {
          const value = localStorage.getItem(key);
          if (value) total += value.length * 2; // UTF-16: 2 bytes per char
        }
      }
      if (total === 0) return '0 KB';
      if (total < 1024) return `${total} B`;
      if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
      return `${(total / (1024 * 1024)).toFixed(1)} MB`;
    } catch {
      return '0 KB';
    }
  }, [cacheRevision]);

  const handleClearCache = () => {
    clearAllAppCaches();
    setCacheRevision(v => v + 1);
    setShowClearCacheModal(false);
    toast.success(t('settings.cache_cleared'));
  };

  // ── Zoom de la ventana (Electron) ──
  // Se relee al montar y en cada resize: cambiar el zoom cambia el viewport del
  // documento, así que Ctrl +/- (menú de Electron) queda reflejado en el %.
  useEffect(() => {
    if (!zoomAvailable) return;
    let alive = true;
    let timer = null;
    const sync = async () => {
      const state = await controlWindowZoom('get');
      if (alive && state?.ok) setZoomPercent(state.percent);
    };
    sync();
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(sync, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [zoomAvailable]);

  const handleResetZoom = useCallback(async () => {
    const state = await controlWindowZoom('reset');
    if (state?.ok) setZoomPercent(state.percent);
  }, []);

  // ── Forzar re-render cuando cambia el estado de bloqueo (subscribeBlockChanges) ──
  const [blockRevision, setBlockRevision] = useState(0);
  useEffect(() => {
    return subscribeBlockChanges(() => setBlockRevision(v => v + 1));
  }, []);

  // ── Cargar usuarios bloqueados al abrir el modal (siempre refresca en background) ──
  useEffect(() => {
    if (!showBlockedModal || !user?.id) return;
    getBlockedUsers(user.id)
      .then((data) => {
        setBlockedUsers(data);
        setBlockedUsersLoading(false);
      })
      .catch((err) => {
        console.warn('Error loading blocked users:', err);
        setBlockedUsersLoading(false);
      });
  }, [showBlockedModal, user?.id, blockRevision]);

  // ── Nickname management ──
  const loadNicknamesForSettings = useCallback(async () => {
    if (!user?.id) return;
    // Cache-first: restore immediately from localStorage (no flash)
    const cached = getCachedNicknames(user.id);
    if (cached) {
      const targetIds = Object.keys(cached);
      if (targetIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, displayname, avatar_url')
          .in('id', targetIds);
        const profileMap = {};
        for (const p of profiles || []) profileMap[p.id] = p;
        const list = targetIds.map(id => ({
          userId: id,
          nickname: cached[id],
          profile: profileMap[id] || null,
        })).filter(item => item.nickname);
        setNicknameList(list);
        // Don't show spinner — data is already cached, fetch silently in background
      } else {
        setNicknameList([]);
      }
    } else {
      setNicknameListLoading(true); // No cache → show spinner while fetching
    }
    // DB fetch in background (updates cache)
    try {
      const nickMap = await getNicknames(user.id);
      cacheNicknames(user.id, nickMap);
      const targetIds = Object.keys(nickMap);
      if (targetIds.length === 0) {
        setNicknameList([]);
        return;
      }
      // Fetch profiles for display
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, displayname, avatar_url')
        .in('id', targetIds);
      const profileMap = {};
      for (const p of profiles || []) profileMap[p.id] = p;
      const list = targetIds.map(id => ({
        userId: id,
        nickname: nickMap[id],
        profile: profileMap[id] || null,
      })).filter(item => item.nickname);
      setNicknameList(list);
    } catch (err) {
      console.warn('Error loading nicknames:', err);
    } finally {
      setNicknameListLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (showNicknamesModal && user?.id) loadNicknamesForSettings();
  }, [showNicknamesModal, user?.id, loadNicknamesForSettings]);

  const handleSaveNicknameSetting = async (targetUserId, newNickname) => {
    if (!user?.id) return;
    const trimmed = (newNickname || '').trim();
    try {
      if (trimmed) {
        await setNickname(user.id, targetUserId, trimmed);
      } else {
        await removeNickname(user.id, targetUserId);
      }
      // Refresh list
      loadNicknamesForSettings();
      setEditingNickname({ userId: null, current: '' });
      toast.success(t('chat.nickname_saved') || 'Nickname saved');
    } catch (err) {
      console.error('Error saving nickname:', err);
      toast.error(t('common.error') || 'Error');
    }
  };

  const handleRemoveNickname = async (targetUserId) => {
    if (!user?.id) return;
    setRemovingNicknameId(targetUserId);
    try {
      await removeNickname(user.id, targetUserId);
      loadNicknamesForSettings();
      setEditingNickname({ userId: null, current: '' });
      toast.success(t('chat.nickname_removed') || 'Nickname removed');
    } catch (err) {
      console.error('Error removing nickname:', err);
      toast.error(t('common.error') || 'Error');
    } finally {
      setRemovingNicknameId(null);
    }
  };

  const handleUnblock = async (blockedId) => {
    if (!user?.id || unblockingId) return;
    setUnblockingId(blockedId);
    try {
      await unblockUser(user.id, blockedId);
      cacheBlockStatus(user.id, blockedId, false);
      clearBlockedListsCache(user.id);
      setBlockedUsers((prev) => prev.filter((u) => u.id !== blockedId));
    } catch (err) {
      console.error('Error unblocking user:', err);
    } finally {
      setUnblockingId(null);
    }
  };

  const isPrivate = profile?.is_private ?? false;
  const statsPrivate = profile?.stats_private ?? false;
  // No usar || {} para poder distinguir null (legacy) de {} (explicitamente vacío)
  const statsVisibility = profile?.stats_visibility;

  // ── User badges (roles excluyendo 'user') ──
  const VALID_BADGE_TYPES = ['admin', 'dev', 'mod', 'partner', 'verified'];
  const userBadges = useMemo(() => {
    if (!profile?.roles) return [];
    return (Array.isArray(profile.roles) ? profile.roles : [profile.roles])
      .filter(r => r !== 'user' && VALID_BADGE_TYPES.includes(r));
  }, [profile?.roles]);
  const badgesVisibility = profile?.badges_visibility || {};
  const getBadgeVisible = (badge) => badgesVisibility[badge] !== false;

  const handleBadgeVisibilityChange = async (badge, visible) => {
    if (!user?.id) return;
    const newVisibility = { ...badgesVisibility, [badge]: visible };
    try {
      await updateUserProfile(user.id, { badges_visibility: newVisibility });
      await refreshProfile(user.id);
    } catch (err) {
      console.error('Error updating badge visibility:', err);
    }
  };

  // ── Sincronizar preferencias con Supabase ──
  // Flag per-key + cola del último valor: los clics rápidos sobre el mismo
  // setting no se pierden (gana siempre el último); keys distintas van en paralelo
  const savingRef = useRef({});
  const pendingRef = useRef({});

  const syncProfilePref = async (key, value) => {
    if (!user?.id) return;
    pendingRef.current[key] = value;
    if (savingRef.current[key]) return; // Ya hay un save en vuelo → solo encolar
    savingRef.current[key] = true;
    try {
      while (pendingRef.current[key] !== undefined) {
        const latest = pendingRef.current[key];
        delete pendingRef.current[key];
        await updateUserProfile(user.id, { [key]: latest });
      }
      await refreshProfile(user.id);
    } catch (err) {
      console.error('Error syncing profile pref:', err);
    } finally {
      savingRef.current[key] = false;
    }
  };

  // ── Cargar preferencias del perfil al montar (para que persistan
  //     aunque se borre el localStorage o se abra en otro navegador) ──
  const [profileSynced, setProfileSynced] = useState(false);
  useEffect(() => {
    if (!profile || profileSynced) return;
    setProfileSynced(true);

    // Mapear columnas del perfil a los setters de I18nContext
    const mappings = [
      { col: 'show_accent', setter: setShowAccent },
      { col: 'show_accent_profile', setter: setShowAccentProfile },
      { col: 'show_accent_explore', setter: setShowAccentExplore },
      { col: 'accent_visibility', setter: setAccentVisibility },
      { col: 'show_profile_stats', setter: setShowProfileStats },
      { col: 'show_likes', setter: setShowLikes },
      { col: 'show_badges', setter: setShowBadges },
      { col: 'allow_mention', setter: setAllowMention },
      { col: 'allow_encrypted_add', setter: setAllowEncryptedAdd },
      { col: 'filter_encrypted', setter: setFilterEncrypted },
      { col: 'time_format_24h', setter: setHour24 },
      { col: 'theme', setter: setTheme },
      { col: 'locale', setter: setLocale },
      { col: 'show_global_bg', setter: setShowGlobalBg },
      { col: 'show_cards_glass', setter: setShowCardsGlass },
      { col: 'chat_default_style', setter: setChatDefaultStyle },
      { col: 'sidebar_default_style', setter: setSidebarDefaultStyle },
      { col: 'sidebar_default_colors', setter: setSidebarDefaultColors },
    ];
    for (const { col, setter } of mappings) {
      if (profile[col] !== undefined && profile[col] !== null) {
        setter(profile[col]);
      }
    }
  }, [profile, profileSynced, setShowAccentProfile, setShowAccentExplore, setAccentVisibility, setShowProfileStats, setShowLikes, setAllowMention, setAllowEncryptedAdd, setFilterEncrypted, setShowGlobalBg, setShowCardsGlass, setChatDefaultStyle, setSidebarDefaultStyle, setSidebarDefaultColors]);

  const handlePrivacyChange = async (value) => {
    if (!user?.id || privacyUpdating || value === isPrivate) return;
    setPrivacyUpdating(true);
    try {
      await updateUserProfile(user.id, { is_private: value });
      await refreshProfile(user.id);
    } catch (err) {
      console.error('Error updating privacy:', err);
    } finally {
      setPrivacyUpdating(false);
    }
  };

  const handleStatsPrivacyChange = async (value) => {
    if (!user?.id || statsPrivacyUpdating || value === statsPrivate) return;
    setStatsPrivacyUpdating(true);
    try {
      // El toggle general sincroniza todas las stats individuales:
      // Public (false) → todas visibles, Private (true) → todas ocultas
      const allStats = { posts: true, likes: true, dislikes: true, comments: true, reposts: true, views: true, profileViews: true, saves: true };
      const newVisibility = value ? {} : allStats; // {} = todas ocultas, allStats = todas visibles
      await updateUserProfile(user.id, {
        stats_private: value,
        stats_visibility: newVisibility,
      });
      await refreshProfile(user.id);
    } catch (err) {
      console.error('Error updating stats privacy:', err);
    } finally {
      setStatsPrivacyUpdating(false);
    }
  };

  // ── Actividad: master switch y visibilidad ──
  // Se guardan en profiles (no en localStorage) para que el ajuste valga en
  // cualquier dispositivo. Al apagarla, o al ponerla en "nadie", se limpia
  // también la actividad publicada: si nadie debe verla, no tiene sentido
  // conservarla en la fila.
  const handleActivityEnabledChange = async (next) => {
    if (!user?.id || activityUpdating) return;
    setActivityUpdating(true);
    try {
      await updateUserProfile(user.id, { activity_enabled: next });
      if (!next) {
        await persistActivity(user.id, null).catch(() => {});
        await persistProgramActivity(user.id, null).catch(() => {});
      }
      await refreshProfile(user.id);
    } catch (err) {
      console.error('Error updating activity settings:', err);
      toast.error(t('settings.activity_save_error'));
    } finally {
      setActivityUpdating(false);
    }
  };

  const handleActivityVisibilityChange = async (value) => {
    if (!user?.id || activityUpdating || value === activitySettings.visibility) return;
    setActivityUpdating(true);
    try {
      await updateUserProfile(user.id, { activity_visibility: value });
      if (value === 'nobody') {
        await persistActivity(user.id, null).catch(() => {});
        await persistProgramActivity(user.id, null).catch(() => {});
      }
      await refreshProfile(user.id);
    } catch (err) {
      console.error('Error updating activity visibility:', err);
      toast.error(t('settings.activity_save_error'));
    } finally {
      setActivityUpdating(false);
    }
  };

  // Abre el menú calculando el hueco real alrededor del disparador: dentro del
  // panel con scroll un menú absoluto se cortaba contra el borde del contenedor.
  const toggleProgramMenu = () => {
    if (programMenuOpen) {
      setProgramMenuOpen(false);
      return;
    }

    const trigger = programMenuRef.current;
    if (!trigger) return;

    const gap = 6;
    const edge = 8;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - gap - edge;
    const spaceAbove = rect.top - gap - edge;
    const openAbove = spaceBelow < Math.min(PROGRAM_MENU_MAX_HEIGHT, spaceAbove);
    const maxHeight = Math.max(160, Math.min(PROGRAM_MENU_MAX_HEIGHT, openAbove ? spaceAbove : spaceBelow));
    // Nunca se sale por la derecha: se pega al borde con 8px de margen.
    const left = Math.max(edge, Math.min(rect.left, window.innerWidth - PROGRAM_MENU_WIDTH - edge));

    setProgramMenuPos(
      openAbove
        ? { bottom: window.innerHeight - rect.top + gap, left, width: PROGRAM_MENU_WIDTH, maxHeight }
        : { top: rect.bottom + gap, left, width: PROGRAM_MENU_WIDTH, maxHeight },
    );
    setProgramMenuOpen(true);
  };

  // Programa compartido: se escribe en su propia columna para no pisar la
  // canción/juego que publica ActivitySync.
  const handleProgramChange = async (appName) => {
    if (!user?.id || activityUpdating || !programSelectable) return;
    setActivityUpdating(true);
    try {
      await persistProgramActivity(user.id, appName === selectedProgram ? null : appName);
      await refreshProfile(user.id);
    } catch (err) {
      console.error('Error updating shared program:', err);
      toast.error(t('settings.activity_save_error'));
    } finally {
      setActivityUpdating(false);
    }
  };

  const handleClearActivityHistory = () => {
    clearActivityHistory(user?.id);
    setHistoryRevision((v) => v + 1);
    setShowClearHistoryModal(false);
  };

  // Hora del historial con el idioma de la interfaz. Si la fecha guardada está
  // corrupta devuelve '' en vez de "Invalid Date".
  const formatActivityWhen = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return date.toLocaleString(locale || 'en', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return date.toLocaleString();
    }
  };

  // ── Stats individuales: iconos y keys ──
  const STAT_ITEMS = [
    { key: 'posts', icon: FaFeather, labelKey: 'profile.posts_tab' },
    { key: 'likes', icon: FaHeart, labelKey: 'profile.stats_likes' },
    { key: 'dislikes', icon: FaHeartBroken, labelKey: 'profile.stats_dislikes' },
    { key: 'comments', icon: FaComment, labelKey: 'profile.stats_comments' },
    { key: 'reposts', icon: FaRetweet, labelKey: 'profile.stats_reposts' },
    { key: 'views', icon: FaEye, labelKey: 'profile.stats_views' },
    { key: 'profileViews', icon: FaUser, labelKey: 'profile.stats_profile_views' },
    { key: 'saves', icon: FaBookmark, labelKey: 'profile.stats_saved' },
  ];

  const handleStatVisibilityChange = async (statKey, visible) => {
    if (!user?.id) return;
    const newVisibility = { ...(profile?.stats_visibility || {}), [statKey]: visible };
    try {
      await updateUserProfile(user.id, { stats_visibility: newVisibility });
      await refreshProfile(user.id);
    } catch (err) {
      console.error('Error updating stat visibility:', err);
    }
  };

  // Cerrar dropdown al hacer clic fuera
  useEffect(() => {
    if (!selectOpen) return;
    const handleClick = (e) => {
      if (selectRef.current && !selectRef.current.contains(e.target)) {
        setSelectOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [selectOpen]);

  const currentLang = LANGUAGES.find((l) => l.value === locale) || LANGUAGES[0];
  const CurrentFlag = currentLang.Flag;

  return (
    <div className="settings-page">
      <div className="settings-card settings-card--split">
        {/* ── Left Panel: Category Navigation ── */}
        <nav className="settings-nav">
          {CATEGORIES.map(({ id, icon: Icon, titleKey, descKey }) => (
            <button
              key={id}
              type="button"
              className={`settings-nav-btn ${activeCategory === id ? 'settings-nav-btn--active' : ''}`}
              onClick={() => {
                setSelectOpen(false);
                setActiveCategory(id);
              }}
            >
              <span className="settings-nav-icon"><Icon /></span>
              <div className="settings-nav-info">
                <span className="settings-nav-title">{t(titleKey)}</span>
                <span className="settings-nav-desc">{t(descKey)}</span>
              </div>
            </button>
          ))}
        </nav>

        {/* ── Right Panel: Active Category Content ── */}
        <div className="settings-panel">
          {activeCategory === 'account' && (
            <>
              <AccountSettings t={t} />

              <div className="settings-row-divider" />

              {/* ── Cerrar sesión ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><MdLogout /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.logout')}</h2>
                    <p className="settings-section-desc">{t('settings.logout_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-danger-btn"
                  onClick={async () => {
                    await logout();
                    navigate('/');
                  }}
                >
                  <MdLogout style={{ marginRight: 6 }} />
                  {t('settings.logout_btn')}
                </button>
              </div>
            </>
          )}

          {activeCategory === 'system' && (
            <>
              {/* ── Idioma y hora (plegable: las opciones viven dentro) ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaGlobe /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.language_time')}</h2>
                    <p className="settings-section-desc">{t('settings.language_time_desc')}</p>
                  </div>
                </div>

                <button
                  type="button"
                  className="settings-stats-expand-btn"
                  onClick={() => setLanguageExpanded((s) => !s)}
                  aria-expanded={languageExpanded}
                >
                  <span className={`settings-stats-expand-arrow ${languageExpanded ? 'settings-stats-expand-arrow--open' : ''}`}>
                    <FaChevronRight />
                  </span>
                  <span>{languageExpanded ? t('settings.options_hide') : t('settings.options_show')}</span>
                </button>
              </div>

              {languageExpanded && (
              <div className="settings-accent-list">
              {/* Idioma */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaGlobe /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.language')}</h2>
                    <p className="settings-section-desc">{t('settings.language_desc')}</p>
                  </div>
                </div>

                <div className="settings-select-wrapper" ref={selectRef}>
                  <button
                    type="button"
                    className="settings-select-trigger"
                    onClick={() => setSelectOpen((s) => !s)}
                  >
                    <CurrentFlag />
                    <span className="settings-select-label">{t(`settings.${locale}`)}</span>
                    <FaChevronDown className={`settings-select-arrow ${selectOpen ? 'settings-select-arrow--open' : ''}`} />
                  </button>

                  {selectOpen && (
                    <div className="settings-select-dropdown">
                      {LANGUAGES.map(({ value, Flag }) => (
                        <button
                          key={value}
                          type="button"
                          className={`settings-select-option ${value === locale ? 'settings-select-option--active' : ''}`}
                          onClick={() => {
                            setLocale(value);
                            syncProfilePref('locale', value);
                            setSelectOpen(false);
                          }}
                        >
                          <Flag />
                          <span>{t(`settings.${value}`)}</span>
                          {value === locale && <FaCheck className="settings-select-check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Formato de hora */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaClock /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.time_format')}</h2>
                    <p className="settings-section-desc">{t('settings.time_format_desc')}</p>
                  </div>
                </div>
                <div className="settings-segmented">
                  <button
                    type="button"
                    className={`settings-segmented-btn ${hour24 ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => {
                      setHour24(true);
                      syncProfilePref('time_format_24h', true);
                    }}
                  >
                    {t('settings.time_format_24h')}
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${!hour24 ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => {
                      setHour24(false);
                      syncProfilePref('time_format_24h', false);
                    }}
                  >
                    {t('settings.time_format_12h')}
                  </button>
                </div>
              </div>
              </div>
              )}

              <div className="settings-row-divider" />

              {/* ── Apariencia (plegable: las opciones viven dentro) ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaBrush /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.appearance')}</h2>
                    <p className="settings-section-desc">{t('settings.appearance_desc')}</p>
                  </div>
                </div>

                <button
                  type="button"
                  className="settings-stats-expand-btn"
                  onClick={() => setAppearanceExpanded((s) => !s)}
                  aria-expanded={appearanceExpanded}
                >
                  <span className={`settings-stats-expand-arrow ${appearanceExpanded ? 'settings-stats-expand-arrow--open' : ''}`}>
                    <FaChevronRight />
                  </span>
                  <span>{appearanceExpanded ? t('settings.options_hide') : t('settings.options_show')}</span>
                </button>
              </div>

              {appearanceExpanded && (
              <div className="settings-accent-list">
              {/* Tema */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon">{theme === 'light' ? <FaSun /> : <FaMoon />}</span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.theme')}</h2>
                    <p className="settings-section-desc">{t('settings.theme_desc')}</p>
                  </div>
                </div>
                <div className="settings-segmented">
                  <button
                    type="button"
                    className={`settings-segmented-btn ${theme === 'dark' ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => {
                      setTheme('dark');
                      syncProfilePref('theme', 'dark');
                    }}
                  >
                    <FaMoon style={{ marginRight: 6 }} />{t('settings.theme_dark')}
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${theme === 'light' ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => {
                      setTheme('light');
                      syncProfilePref('theme', 'light');
                    }}
                  >
                    <FaSun style={{ marginRight: 6 }} />{t('settings.theme_light')}
                  </button>
                </div>
              </div>

              <div className="settings-row-divider" />

              {/* Fondo de perfil en todo el app (preferencia personal local) */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaImage /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.show_global_bg')}</h2>
                    <p className="settings-section-desc">{t('settings.show_global_bg_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${showGlobalBg ? 'settings-toggle--active' : ''}`}
                  onClick={() => {
                    const next = !showGlobalBg;
                    setShowGlobalBg(next);
                    syncProfilePref('show_global_bg', next);
                    // Sin el fondo del perfil, todo lo que lo decora (vidrio,
                    // chat y sidebar "por defecto") deja de tener sentido: se
                    // apaga también, en vez de quedarse como interruptores
                    // activos que no hacen nada.
                    if (!next) {
                      setShowCardsGlass(false);
                      syncProfilePref('show_cards_glass', false);
                      setChatDefaultStyle(false);
                      syncProfilePref('chat_default_style', false);
                      setSidebarDefaultStyle(false);
                      syncProfilePref('sidebar_default_style', false);
                      setSidebarDefaultColors(false);
                      syncProfilePref('sidebar_default_colors', false);
                    }
                  }}
                  aria-pressed={showGlobalBg}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* Cards translúcidas en todo el app (misma receta que el perfil) */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaBrush /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.show_cards_glass')}</h2>
                    <p className="settings-section-desc">{t('settings.show_cards_glass_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${showCardsGlass && showGlobalBg ? 'settings-toggle--active' : ''}`}
                  disabled={!showGlobalBg}
                  title={!showGlobalBg ? t('settings.needs_global_bg') : undefined}
                  onClick={() => {
                    if (!showGlobalBg) return;
                    const next = !showCardsGlass;
                    setShowCardsGlass(next);
                    syncProfilePref('show_cards_glass', next);
                    // Al quitar el vidrio, el sidebar vuelve a su superficie
                    // del tema: los "colores por defecto" dejan de aplicar y
                    // se apagan para no reactivarse solos más adelante.
                    if (!next) {
                      setSidebarDefaultColors(false);
                      syncProfilePref('sidebar_default_colors', false);
                    }
                  }}
                  aria-pressed={showCardsGlass && showGlobalBg}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* Chat con estilos por defecto (ignora vidrio, superficie y
                  color de texto del perfil, mantiene el tema claro/oscuro) */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaComment /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.chat_default_style')}</h2>
                    <p className="settings-section-desc">{t('settings.chat_default_style_desc')}</p>
                  </div>
                </div>
                {/* Solo tiene sentido con "Tarjetas transparentes" activo: sin
                    vidrio no hay estilos que desactivar en el chat. */}
                <button
                  type="button"
                  className={`settings-toggle ${chatDefaultStyle && showCardsGlass && showGlobalBg ? 'settings-toggle--active' : ''}`}
                  disabled={!showCardsGlass || !showGlobalBg}
                  title={!showGlobalBg ? t('settings.needs_global_bg') : !showCardsGlass ? t('settings.chat_default_style_disabled') : undefined}
                  onClick={() => {
                    if (!showCardsGlass || !showGlobalBg) return;
                    const next = !chatDefaultStyle;
                    setChatDefaultStyle(next);
                    syncProfilePref('chat_default_style', next);
                  }}
                  aria-pressed={chatDefaultStyle && showCardsGlass}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* Sidebar con estilos por defecto (apaga y bloquea la opción de
                  colores por defecto del sidebar) */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaBars /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.sidebar_default_style')}</h2>
                    <p className="settings-section-desc">{t('settings.sidebar_default_style_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${sidebarDefaultStyle && showGlobalBg ? 'settings-toggle--active' : ''}`}
                  disabled={!showGlobalBg}
                  title={!showGlobalBg ? t('settings.needs_global_bg') : undefined}
                  onClick={() => {
                    if (!showGlobalBg) return;
                    const next = !sidebarDefaultStyle;
                    setSidebarDefaultStyle(next);
                    syncProfilePref('sidebar_default_style', next);
                  }}
                  aria-pressed={sidebarDefaultStyle && showGlobalBg}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* Sidebar con colores por defecto (solo acento; mantiene el vidrio) */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaPalette /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.sidebar_default_colors')}</h2>
                    <p className="settings-section-desc">{t('settings.sidebar_default_colors_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${sidebarDefaultColors && !sidebarDefaultStyle && showGlobalBg ? 'settings-toggle--active' : ''}`}
                  disabled={!showGlobalBg || sidebarDefaultStyle}
                  title={
                    !showGlobalBg
                      ? t('settings.needs_global_bg')
                      : sidebarDefaultStyle
                        ? t('settings.sidebar_default_colors_disabled')
                        : undefined
                  }
                  onClick={() => {
                    if (!showGlobalBg || sidebarDefaultStyle) return;
                    const next = !sidebarDefaultColors;
                    setSidebarDefaultColors(next);
                    syncProfilePref('sidebar_default_colors', next);
                  }}
                  aria-pressed={sidebarDefaultColors && !sidebarDefaultStyle && showGlobalBg}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>
              </div>
              )}

              <div className="settings-row-divider" />

              {/* ── Zoom (solo app de escritorio: el navegador no puede
                     cambiar el zoom de la ventana) ── */}
              {zoomAvailable && (
                <>
                  <div className="settings-row">
                    <div className="settings-row-header">
                      <span className="settings-section-icon"><FaCompress /></span>
                      <div>
                        <h2 className="settings-section-title">{t('settings.zoom_title')}</h2>
                        <p className="settings-section-desc">{t('settings.zoom_desc')}</p>
                      </div>
                    </div>
                    <span className="settings-cache-size">{zoomPercent}%</span>
                    <button
                      type="button"
                      className="settings-edit-btn"
                      onClick={handleResetZoom}
                    >
                      <FaUndo style={{ marginRight: 6 }} />
                      {t('settings.zoom_reset')}
                    </button>
                  </div>

                  <div className="settings-row-divider" />
                </>
              )}

              {/* ── Caché ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaTrashAlt /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.cache')}</h2>
                    <p className="settings-section-desc">{t('settings.cache_desc')}</p>
                  </div>
                </div>
                <span className="settings-cache-size">{t('settings.cache_size', { size: cacheSize })}</span>
                <button
                  type="button"
                  className="settings-edit-btn"
                  onClick={() => setShowClearCacheModal(true)}
                >
                  <FaTrashAlt style={{ marginRight: 6 }} />
                  {t('settings.cache_clear')}
                </button>
              </div>
            </>
          )}

          {activeCategory === 'profile' && (
            <>
              {/* ── Colores de acento ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaPalette /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.show_accent')}</h2>
                    <p className="settings-section-desc">{t('settings.show_accent_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${showAccent ? 'settings-toggle--active' : ''}`}
                  onClick={() => {
                      const next = !showAccent;
                      setShowAccent(next);
                      syncProfilePref('show_accent', next);
                    }}
                  aria-pressed={showAccent}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>

                {/* Expandir sub-opciones de acento */}
                <button
                  type="button"
                  className="settings-stats-expand-btn"
                  onClick={() => setAccentExpanded((s) => !s)}
                >
                  <span className={`settings-stats-expand-arrow ${accentExpanded ? 'settings-stats-expand-arrow--open' : ''}`}>
                    <FaChevronRight />
                  </span>
                  <span>{accentExpanded ? t('settings.accent_hide_details') : t('settings.accent_show_details')}</span>
                </button>

                {accentExpanded && (
                  <div className="settings-accent-list">
                    {/* Mostrar en el perfil */}
                    <div className="settings-row">
                      <div className="settings-row-header">
                        <span className="settings-section-icon"><FaPalette /></span>
                        <div>
                          <h2 className="settings-section-title">{t('settings.show_accent_profile')}</h2>
                          <p className="settings-section-desc">{t('settings.show_accent_profile_desc')}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`settings-toggle ${showAccentProfile ? 'settings-toggle--active' : ''}`}
                        onClick={() => {
                          const next = !showAccentProfile;
                          setShowAccentProfile(next);
                          syncProfilePref('show_accent_profile', next);
                        }}
                        aria-pressed={showAccentProfile}
                      >
                        <span className="settings-toggle-track">
                          <span className="settings-toggle-thumb" />
                        </span>
                      </button>
                    </div>

                    {/* Mostrar en Explore */}
                    <div className="settings-row">
                      <div className="settings-row-header">
                        <span className="settings-section-icon"><FaPalette /></span>
                        <div>
                          <h2 className="settings-section-title">{t('settings.show_accent_explore')}</h2>
                          <p className="settings-section-desc">{t('settings.show_accent_explore_desc')}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`settings-toggle ${showAccentExplore ? 'settings-toggle--active' : ''}`}
                        onClick={() => {
                          const next = !showAccentExplore;
                          setShowAccentExplore(next);
                          syncProfilePref('show_accent_explore', next);
                        }}
                        aria-pressed={showAccentExplore}
                      >
                        <span className="settings-toggle-track">
                          <span className="settings-toggle-thumb" />
                        </span>
                      </button>
                    </div>

                    {/* Visibilidad del color acento */}
                    <div className="settings-row">
                      <div className="settings-row-header">
                        <span className="settings-section-icon"><FaPalette /></span>
                        <div>
                          <h2 className="settings-section-title">{t('settings.accent_visibility')}</h2>
                          <p className="settings-section-desc">{t('settings.accent_visibility_desc')}</p>
                        </div>
                      </div>
                      <div className="settings-segmented">
                        <button
                          type="button"
                          className={`settings-segmented-btn ${accentVisibility === 'others' ? 'settings-segmented-btn--active' : ''}`}
                          onClick={() => {
                            setAccentVisibility('others');
                            syncProfilePref('accent_visibility', 'others');
                          }}
                        >
                          {t('settings.accent_visibility_others')}
                        </button>
                        <button
                          type="button"
                          className={`settings-segmented-btn ${accentVisibility === 'both' ? 'settings-segmented-btn--active' : ''}`}
                          onClick={() => {
                            setAccentVisibility('both');
                            syncProfilePref('accent_visibility', 'both');
                          }}
                        >
                          {t('settings.accent_visibility_both')}
                        </button>
                        <button
                          type="button"
                          className={`settings-segmented-btn ${accentVisibility === 'me' ? 'settings-segmented-btn--active' : ''}`}
                          onClick={() => {
                            setAccentVisibility('me');
                            syncProfilePref('accent_visibility', 'me');
                          }}
                        >
                          {t('settings.accent_visibility_me')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="settings-row-divider" />

              {/* ── Visibilidad de cards ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaEye /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.profile_display')}</h2>
                    <p className="settings-section-desc">{t('settings.profile_display_desc')}</p>
                  </div>
                </div>

                {/* Expandir sub-opciones de cards */}
                <button
                  type="button"
                  className="settings-stats-expand-btn"
                  onClick={() => setCardsExpanded((s) => !s)}
                >
                  <span className={`settings-stats-expand-arrow ${cardsExpanded ? 'settings-stats-expand-arrow--open' : ''}`}>
                    <FaChevronRight />
                  </span>
                  <span>{cardsExpanded ? t('settings.cards_hide_details') : t('settings.cards_show_details')}</span>
                </button>

                {cardsExpanded && (
                  <div className="settings-accent-list">
                    {/* Mostrar estadísticas */}
                    <div className="settings-row">
                      <div className="settings-row-header">
                        <span className="settings-section-icon"><FaChartBar /></span>
                        <div>
                          <h2 className="settings-section-title">{t('settings.show_stats_card')}</h2>
                          <p className="settings-section-desc">{t('settings.show_stats_card_desc')}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`settings-toggle ${showProfileStats ? 'settings-toggle--active' : ''}`}
                        onClick={() => {
                          const next = !showProfileStats;
                          setShowProfileStats(next);
                          syncProfilePref('show_profile_stats', next);
                        }}
                        aria-pressed={showProfileStats}
                      >
                        <span className="settings-toggle-track">
                          <span className="settings-toggle-thumb" />
                        </span>
                      </button>
                    </div>

                  </div>
                )}
              </div>

              <div className="settings-row-divider" />

              {/* ── Mostrar badges ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaTags /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.show_badges')}</h2>
                    <p className="settings-section-desc">{t('settings.show_badges_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${showBadges ? 'settings-toggle--active' : ''}`}
                  onClick={() => {
                    const next = !showBadges;
                    setShowBadges(next);
                    syncProfilePref('show_badges', next);
                  }}
                  aria-pressed={showBadges}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>

                {/* Expandir sub-opciones de badges */}
                {userBadges.length > 0 ? (
                  <>
                    <button
                      type="button"
                      className="settings-stats-expand-btn"
                      onClick={() => setBadgesExpanded((s) => !s)}
                    >
                      <span className={`settings-stats-expand-arrow ${badgesExpanded ? 'settings-stats-expand-arrow--open' : ''}`}>
                        <FaChevronRight />
                      </span>
                      <span>
                        {badgesExpanded ? t('settings.badges_hide_individual') : t('settings.badges_show_individual', { count: userBadges.length })}
                      </span>
                    </button>

                    {badgesExpanded && (
                      <div className="settings-accent-list">
                        {userBadges.map((badge) => {
                          const visible = getBadgeVisible(badge);
                          const badgeImg = badge === 'mod' ? null : `/${badge}_badge2.png`;
                          return (
                            <label key={badge} className="settings-stat-toggle">
                              <span className="settings-stat-toggle-label">
                                {badgeImg ? (
                                  <img
                                    src={badgeImg}
                                    alt={badge}
                                    className="role-badge-img"
                                    style={{ width: 18, height: 18, objectFit: 'contain', marginRight: 8, flexShrink: 0 }}
                                    draggable={false}
                                  />
                                ) : (
                                  <span className="role-badge role-badge--mod" style={{ marginRight: 8, fontSize: '0.65rem', padding: '1px 6px' }}>
                                    Mod
                                  </span>
                                )}
                                {t(`badge.${badge}`) || badge}
                              </span>
                              <span className="settings-toggle">
                                <input
                                  type="checkbox"
                                  checked={visible}
                                  onChange={() => handleBadgeVisibilityChange(badge, !visible)}
                                />
                                <span className="settings-toggle-track">
                                  <span className="settings-toggle-thumb" />
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="settings-no-badges" style={{ fontSize: '0.78rem', opacity: 0.6, marginTop: 8, width: '100%' }}>{t('settings.no_badges')}</p>
                )}
              </div>

              <div className="settings-row-divider" />

              {/* ── Conexión con Discord ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaDiscord /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.discord_title')}</h2>
                    <p className="settings-section-desc">{isDiscordLinked ? t('settings.discord_linked_desc') : t('settings.discord_not_linked_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-edit-btn ${isDiscordLinked ? 'settings-danger-btn' : ''}`}
                  style={!isDiscordLinked ? { background: '#5865F2', color: '#fff', border: 'none' } : {}}
                  onClick={async () => {
                    if (isDiscordLinked) {
                      toast.info(t('settings.discord_unlink_info'));
                    } else {
                      await linkDiscord();
                    }
                  }}
                >
                  <FaDiscord style={{ marginRight: 6 }} />
                  {isDiscordLinked ? t('settings.discord_linked') : t('settings.discord_link_btn')}
                </button>
              </div>
            </>
          )}

          {activeCategory === 'activity' && (
            <>
              {/* ── Compartir actividad (master switch) ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaGamepad /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.activity_enabled')}</h2>
                    <p className="settings-section-desc">{t('settings.activity_enabled_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${activitySettings.enabled ? 'settings-toggle--active' : ''}`}
                  onClick={() => handleActivityEnabledChange(!activitySettings.enabled)}
                  aria-pressed={activitySettings.enabled}
                  disabled={activityUpdating || profileLoading}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* ── Quién puede verla ── */}
              <div className="settings-row" style={activitySettings.enabled ? undefined : { opacity: 0.55 }}>
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaEyeSlash /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.activity_privacy')}</h2>
                    <p className="settings-section-desc">{t('settings.activity_privacy_desc')}</p>
                  </div>
                </div>

                <div className="settings-segmented">
                  <button
                    type="button"
                    className={`settings-segmented-btn ${activitySettings.visibility === 'followers' ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => handleActivityVisibilityChange('followers')}
                    disabled={activityUpdating || profileLoading || !activitySettings.enabled}
                  >
                    {t('settings.activity_visibility_followers')}
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${activitySettings.visibility === 'nobody' ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => handleActivityVisibilityChange('nobody')}
                    disabled={activityUpdating || profileLoading || !activitySettings.enabled}
                  >
                    {t('settings.activity_visibility_nobody')}
                  </button>
                </div>
              </div>

              <div className="settings-row-divider" />

              {/* ── Programa compartido (segunda actividad) ── */}
              <div className="settings-row settings-row--stacked" style={programSelectable ? undefined : { opacity: 0.55 }}>
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaDesktop /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.activity_program')}</h2>
                    <p className="settings-section-desc">{t('settings.activity_program_desc')}</p>
                  </div>
                </div>

                {!isDesktop ? (
                  <p className="settings-activity-empty">{t('settings.activity_program_desktop_only')}</p>
                ) : !appsApiReady ? (
                  <p className="settings-activity-empty">{t('settings.activity_program_restart')}</p>
                ) : (
                  <div className="settings-activity-program-select" ref={programMenuRef}>
                    <button
                      type="button"
                      className="settings-activity-program-btn"
                      onClick={toggleProgramMenu}
                      aria-haspopup="menu"
                      aria-expanded={programMenuOpen}
                      disabled={activityUpdating || !programSelectable}
                    >
                      <ProgramLogo
                        title={selectedProgram || ''}
                        imgClassName="settings-activity-program-option-icon"
                        fallback={
                          selectedProgramEntry?.icon ? (
                            <img
                              src={selectedProgramEntry.icon}
                              alt=""
                              className="settings-activity-program-option-icon"
                              draggable={false}
                            />
                          ) : null
                        }
                      />
                      <span className="settings-activity-program-btn-label">
                        {selectedProgram || t('settings.activity_program_none')}
                      </span>
                      <FaChevronDown className="settings-activity-program-btn-chevron" />
                    </button>

                    {programMenuOpen && programMenuPos && createPortal(
                      <div
                        className="settings-activity-program-menu fc-dropdown"
                        role="menu"
                        ref={programMenuListRef}
                        style={programMenuPos}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className={`fc-dropdown-btn${selectedProgram ? '' : ' fc-dropdown-btn--active'}`}
                          onClick={() => {
                            handleProgramChange(null);
                            setProgramMenuOpen(false);
                          }}
                        >
                          {t('settings.activity_program_none')}
                        </button>

                        <div className="fc-dropdown-divider" />

                        <div className="settings-activity-program-list">
                          {openApps === null ? (
                            <p className="settings-activity-empty">{t('settings.activity_program_loading')}</p>
                          ) : openApps.length === 0 ? (
                            <p className="settings-activity-empty">{t('settings.activity_program_empty')}</p>
                          ) : (
                            <>
                              {/* El elegido se mantiene aunque ahora esté cerrado:
                                  sin esto parecería que no hay nada compartido. */}
                              {selectedProgram && !openApps.some((app) => app.name === selectedProgram) && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="fc-dropdown-btn fc-dropdown-btn--active"
                                  onClick={() => {
                                    handleProgramChange(selectedProgram);
                                    setProgramMenuOpen(false);
                                  }}
                                >
                                  {selectedProgram}
                                </button>
                              )}

                              {openApps.map((app) => (
                                <button
                                  key={app.exe}
                                  type="button"
                                  role="menuitem"
                                  className={`fc-dropdown-btn${selectedProgram === app.name ? ' fc-dropdown-btn--active' : ''}`}
                                  onClick={() => {
                                    handleProgramChange(app.name);
                                    setProgramMenuOpen(false);
                                  }}
                                >
                                  <ProgramLogo
                                    title={app.name}
                                    imgClassName="settings-activity-program-option-icon"
                                    fallback={
                                      app.icon ? (
                                        <img
                                          src={app.icon}
                                          alt=""
                                          className="settings-activity-program-option-icon"
                                          loading="lazy"
                                          draggable={false}
                                        />
                                      ) : (
                                        <FaDesktop className="settings-activity-program-option-icon settings-activity-program-option-icon--fallback" />
                                      )
                                    }
                                  />
                                  <span className="settings-activity-program-option-name">{app.name}</span>
                                  <span className="settings-activity-program-option-exe">{app.exe}</span>
                                </button>
                              ))}
                            </>
                          )}
                        </div>

                        <div className="fc-dropdown-divider" />

                        <button
                          type="button"
                          role="menuitem"
                          className="fc-dropdown-btn"
                          onClick={() => {
                            setOpenApps(null);
                            setOpenAppsRevision((v) => v + 1);
                          }}
                        >
                          <FaUndo />
                          {t('settings.activity_program_refresh')}
                        </button>

                        <div className="fc-dropdown-divider" />

                        {/* Atribución exigida por el uso gratuito de apistemic logos. */}
                        <a
                          className="settings-activity-program-credit"
                          href={APP_LOGO_CREDIT_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Logos by apistemic logos
                        </a>
                      </div>,
                      document.body,
                    )}
                  </div>
                )}
              </div>

              <div className="settings-row-divider" />

              {/* ── Historial local (solo app de escritorio) ── */}
              <div className="settings-row settings-row--stacked">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaHistory /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.activity_history')}</h2>
                    <p className="settings-section-desc">{t('settings.activity_history_desc')}</p>
                  </div>
                </div>

                {!isDesktop ? (
                  <p className="settings-activity-empty">{t('settings.activity_history_desktop_only')}</p>
                ) : activityHistory.length === 0 ? (
                  <p className="settings-activity-empty">{t('settings.activity_history_empty')}</p>
                ) : (
                  <>
                    <ul className="settings-activity-history">
                      {(historyExpanded ? activityHistory : activityHistory.slice(0, ACTIVITY_HISTORY_PREVIEW)).map((entry, index) => {
                        const EntryIcon = entry.kind === 'game' ? FaGamepad : entry.kind === 'video' ? FaTv : FaMusic;
                        const when = formatActivityWhen(entry.startedAt);
                        const sub = [entry.subtitle, entry.app].filter(Boolean).join(' · ');
                        return (
                          <li className="settings-activity-item" key={`${entry.startedAt || 'x'}-${index}`}>
                            <span className="settings-activity-item-icon"><EntryIcon /></span>
                            <span className="settings-activity-item-meta">
                              <span className="settings-activity-item-title" title={entry.title}>{entry.title}</span>
                              {sub && <span className="settings-activity-item-sub" title={sub}>{sub}</span>}
                              <span className="settings-activity-item-time">{when}</span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>

                    {activityHistory.length > ACTIVITY_HISTORY_PREVIEW && (
                      <button
                        type="button"
                        className="settings-activity-toggle"
                        onClick={() => setHistoryExpanded((prev) => !prev)}
                        aria-expanded={historyExpanded}
                      >
                        {historyExpanded
                          ? t('profile.show_less')
                          : t('profile.show_more', { count: activityHistory.length - ACTIVITY_HISTORY_PREVIEW })}
                      </button>
                    )}

                    <button
                      type="button"
                      className="settings-danger-btn settings-activity-clear"
                      onClick={() => setShowClearHistoryModal(true)}
                    >
                      <FaTrashAlt style={{ marginRight: 6 }} />
                      {t('settings.activity_history_clear')}
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          {activeCategory === 'notifications' && (
            <>
              {/* ── Notificaciones ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaBell /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.notifications')}</h2>
                    <p className="settings-section-desc">{t('settings.notifications_desc')}</p>
                  </div>
                </div>
              </div>

              {/* Notificaciones toast */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaBell /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.show_toast_notifications')}</h2>
                    <p className="settings-section-desc">{t('settings.show_toast_notifications_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${showToastNotifications ? 'settings-toggle--active' : ''}`}
                  onClick={() => setShowToastNotifications(!showToastNotifications)}
                  aria-pressed={showToastNotifications}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              {/* Notificaciones push */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaBell /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.show_push_notifications')}</h2>
                    <p className="settings-section-desc">{t('settings.show_push_notifications_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${showPushNotifications ? 'settings-toggle--active' : ''}`}
                  onClick={() => {
                    const next = !showPushNotifications;
                    setShowPushNotifications(next);
                    // Si se activa push, pedir permiso al navegador
                    if (next && 'Notification' in window && Notification.permission === 'default') {
                      Notification.requestPermission();
                    }
                  }}
                  aria-pressed={showPushNotifications}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>
            </>
          )}

          {activeCategory === 'privacy' && (
            <>
              {/* Configuración de perfil */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaLock /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.profile_config')}</h2>
                    <p className="settings-section-desc">{t('settings.profile_config_desc')}</p>
                  </div>
                </div>

                <div className="settings-segmented">
                  <button
                    type="button"
                    className={`settings-segmented-btn ${!isPrivate ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => handlePrivacyChange(false)}
                    disabled={privacyUpdating || profileLoading}
                  >
                    {t('settings.public_profile')}
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${isPrivate ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => handlePrivacyChange(true)}
                    disabled={privacyUpdating || profileLoading}
                  >
                    {t('settings.private_profile')}
                  </button>
                </div>
              </div>

              <div className="settings-row-divider" />

              {/* Privacidad de estadísticas */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaEyeSlash /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.stats_privacy')}</h2>
                    <p className="settings-section-desc">{t('settings.stats_privacy_desc')}</p>
                  </div>
                </div>

                <div className="settings-segmented">
                  <button
                    type="button"
                    className={`settings-segmented-btn ${!statsPrivate ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => handleStatsPrivacyChange(false)}
                    disabled={statsPrivacyUpdating || profileLoading}
                  >
                    {t('settings.stats_public')}
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${statsPrivate ? 'settings-segmented-btn--active' : ''}`}
                    onClick={() => handleStatsPrivacyChange(true)}
                    disabled={statsPrivacyUpdating || profileLoading}
                  >
                    {t('settings.stats_private')}
                  </button>
                </div>

                {/* ── Expandir stats individuales ── */}
                <button
                  type="button"
                  className="settings-stats-expand-btn"
                  onClick={() => setStatsExpanded((s) => !s)}
                >
                  <span className={`settings-stats-expand-arrow ${statsExpanded ? 'settings-stats-expand-arrow--open' : ''}`}>
                    <FaChevronRight />
                  </span>
                  <span>{statsExpanded ? t('settings.stats_hide_individual') : t('settings.stats_show_individual')}</span>
                </button>

                {statsExpanded && (
                  <div className="settings-stats-list">
                    {STAT_ITEMS.map(({ key, icon: Icon, labelKey }) => {
                      // null = legacy: mostrar según statsPrivate
                      // {} = todas ocultas (seteado por toggle general Privado)
                      // {likes: true} = solo likes visibles
                      // undefined = stat agregada después, visible por defecto
                      const isVisible = statsVisibility == null ? !statsPrivate : statsVisibility[key] !== false;
                      return (
                        <label key={key} className="settings-stat-toggle">
                          <span className="settings-stat-toggle-label">
                            <Icon className="settings-stat-toggle-icon" />
                            {t(labelKey)}
                          </span>
                          <span className="settings-toggle">
                            <input
                              type="checkbox"
                              checked={isVisible}
                              onChange={() => handleStatVisibilityChange(key, !isVisible)}
                            />
                            <span className="settings-toggle-track">
                              <span className="settings-toggle-thumb" />
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="settings-row-divider" />

              {/* ── Privacidad de likes ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaHeart /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.show_likes')}</h2>
                    <p className="settings-section-desc">{t('settings.show_likes_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${showLikes ? 'settings-toggle--active' : ''}`}
                  onClick={() => {
                    const next = !showLikes;
                    setShowLikes(next);
                    syncProfilePref('show_likes', next);
                  }}
                  aria-pressed={showLikes}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* ── Permisos de interacción ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaAt /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.allow_mention')}</h2>
                    <p className="settings-section-desc">{t('settings.allow_mention_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${allowMention ? 'settings-toggle--active' : ''}`}
                  onClick={() => {
                    const next = !allowMention;
                    setAllowMention(next);
                    syncProfilePref('allow_mention', next);
                  }}
                  aria-pressed={allowMention}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* ── Filtrar posts encriptados ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaEyeSlash /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.filter_encrypted')}</h2>
                    <p className="settings-section-desc">{t('settings.filter_encrypted_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${filterEncrypted ? 'settings-toggle--active' : ''}`}                    onClick={() => {
                      const next = !filterEncrypted;
                      setFilterEncrypted(next);
                      syncProfilePref('filter_encrypted', next);
                      // Si filterEncrypted se activa, desactivar allowEncryptedAdd
                      if (next) {
                        setAllowEncryptedAdd(false);
                        syncProfilePref('allow_encrypted_add', false);
                      }
                    }}
                  aria-pressed={filterEncrypted}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* ── Permitir inclusión en posts encriptados ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaEyeSlash /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.allow_encrypted_add')}</h2>
                    <p className="settings-section-desc">{t('settings.allow_encrypted_add_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-toggle ${allowEncryptedAdd ? 'settings-toggle--active' : ''}`}
                  onClick={() => {
                    if (filterEncrypted) return;
                    const next = !allowEncryptedAdd;
                    setAllowEncryptedAdd(next);
                    syncProfilePref('allow_encrypted_add', next);
                  }}
                  aria-pressed={allowEncryptedAdd}
                  disabled={filterEncrypted}
                  style={filterEncrypted ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                >
                  <span className="settings-toggle-track">
                    <span className="settings-toggle-thumb" />
                  </span>
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* ── Usuarios bloqueados ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaBan /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.blocked_users')}</h2>
                    <p className="settings-section-desc">{t('settings.blocked_users_desc')}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-edit-btn"
                  onClick={() => setShowBlockedModal(true)}
                >
                  <FaBan style={{ marginRight: 6 }} />
                  {t('settings.blocked_users')}
                </button>
              </div>

              <div className="settings-row-divider" />

              {/* ── Apodos ── */}
              <div className="settings-row">
                <div className="settings-row-header">
                  <span className="settings-section-icon"><FaEdit /></span>
                  <div>
                    <h2 className="settings-section-title">{t('settings.nicknames') || 'Nicknames'}</h2>
                    <p className="settings-section-desc">{t('settings.nicknames_desc') || 'Manage nicknames you have set for other users in chat.'}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-edit-btn"
                  onClick={() => setShowNicknamesModal(true)}
                >
                  <FaEdit style={{ marginRight: 6 }} />
                  {t('settings.nicknames') || 'Nicknames'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Clear Cache Confirmation ── */}
      {showClearCacheModal && (
        <ConfirmModal
          message={t('settings.cache_clear_confirm')}
          onConfirm={handleClearCache}
          onCancel={() => setShowClearCacheModal(false)}
        />
      )}

      {/* ── Clear Activity History Confirmation ── */}
      {showClearHistoryModal && (
        <ConfirmModal
          message={t('settings.activity_history_clear_confirm')}
          onConfirm={handleClearActivityHistory}
          onCancel={() => setShowClearHistoryModal(false)}
        />
      )}

      {/* ── Blocked Users Modal ── */}
      <ModalShell
        isOpen={showBlockedModal}
        onClose={() => setShowBlockedModal(false)}
        onEscape={() => setShowBlockedModal(false)}
        disableBackdropClose={false}
        className="settings-blocked-modal"
      >
        <div className="settings-blocked-header">
          <h3 className="fc-modal-title">{t('settings.blocked_users')}</h3>
          <button
            type="button"
            className="settings-blocked-close"
            onClick={() => setShowBlockedModal(false)}
            aria-label={t('common.close')}
          >
            <FaTimes />
          </button>
        </div>
        <div className="settings-blocked-list">
          {blockedUsersLoading ? (
            <div className="settings-blocked-loading">{t('common.loading')}</div>
          ) : blockedUsers.length === 0 ? (
            <div className="settings-blocked-empty">
              <FaBan className="settings-blocked-empty-icon" />
              <p>{t('block.no_blocked_users')}</p>
            </div>
          ) : (
            blockedUsers.map((u) => (
              <div key={u.id} className="settings-blocked-item">
                <img
                  className="settings-blocked-avatar"
                  src={u.avatar_url || 'https://i.pinimg.com/736x/ac/13/74/ac137456b996efec340292a585eb6dc7.jpg'}
                  alt={u.username}
                />
                <div className="settings-blocked-info">
                  <span className="settings-blocked-username">@{u.username}</span>
                </div>
                <button
                  type="button"
                  className="settings-blocked-unblock-btn"
                  onClick={() => handleUnblock(u.id)}
                  disabled={unblockingId === u.id}
                >
                  {unblockingId === u.id ? '...' : t('block.unblock')}
                </button>
              </div>
            ))
          )}
        </div>
      </ModalShell>

      {/* ── Nicknames Modal ── */}
      <ModalShell
        isOpen={showNicknamesModal}
        onClose={() => setShowNicknamesModal(false)}
        onEscape={() => setShowNicknamesModal(false)}
        disableBackdropClose={false}
        className="settings-blocked-modal"
      >
        <div className="settings-blocked-header">
          <h3 className="fc-modal-title">{t('settings.nicknames') || 'Nicknames'}</h3>
          <button
            type="button"
            className="settings-blocked-close"
            onClick={() => setShowNicknamesModal(false)}
            aria-label={t('common.close')}
          >
            <FaTimes />
          </button>
        </div>
        <div className="settings-blocked-list">
          {nicknameListLoading ? (
            <div className="settings-blocked-loading">{t('common.loading')}</div>
          ) : nicknameList.length === 0 ? (
            <div className="settings-blocked-empty">
              <FaEdit className="settings-blocked-empty-icon" />
              <p>{t('settings.nicknames_empty') || 'No nicknames set yet.'}</p>
            </div>
          ) : (
            nicknameList.map((item) => (
              <div key={item.userId} className="settings-blocked-item">
                <img
                  className="settings-blocked-avatar"
                  src={item.profile?.avatar_url || 'https://i.pinimg.com/736x/ac/13/74/ac137456b996efec340292a585eb6dc7.jpg'}
                  alt={item.profile?.username || 'user'}
                />
                <div className="settings-blocked-info">
                  <span className="settings-blocked-username">@{item.profile?.username || 'unknown'}</span>
                  {editingNickname.userId === item.userId ? (
                    <div className="settings-nickname-edit-row">
                      <input
                        className="settings-nickname-input"
                        type="text"
                        value={editingNickname.current}
                        onChange={(e) => setEditingNickname(prev => ({ ...prev, current: e.target.value }))}
                        maxLength={50}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveNicknameSetting(item.userId, editingNickname.current);
                          if (e.key === 'Escape') setEditingNickname({ userId: null, current: '' });
                        }}
                      />
                      <button
                        className="settings-nickname-save-btn"
                        onClick={() => handleSaveNicknameSetting(item.userId, editingNickname.current)}
                        title={t('common.save')}
                      >
                        <FaCheck />
                      </button>
                    </div>
                  ) : (
                    <span className="settings-nickname-label">{item.nickname}</span>
                  )}
                </div>
                <div className="settings-nickname-actions">
                  <button
                    type="button"
                    className="settings-nickname-edit-btn"
                    onClick={() => setEditingNickname({ userId: item.userId, current: item.nickname })}
                    title={t('common.edit')}
                  >
                    <FaEdit />
                  </button>
                  <button
                    type="button"
                    className="settings-nickname-remove-btn"
                    onClick={() => handleRemoveNickname(item.userId)}
                    disabled={removingNicknameId === item.userId}
                    title={t('common.delete')}
                  >
                    {removingNicknameId === item.userId ? t('common.loading') : <FaTimes />}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </ModalShell>
    </div>
  );
}
