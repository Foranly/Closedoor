import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaInfoCircle, FaTimes, FaMusic, FaTv, FaGamepad, FaEllipsisH, FaShareAlt } from 'react-icons/fa';
import { toast } from 'react-toastify';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { useLocalActivityState, isLocalActivityAvailable } from '../../../hooks/useLocalActivity';
import {
  normalizeActivity,
  activityFromProfile,
  getActivitySettings,
} from '../../services/activityService';
import { getFollowCounts, getCachedFollowCounts, setCachedFollowCounts } from '../../services/followService';
import { supabase } from '../../services/supabaseclient';
import { useUserStatus } from '../../services/useUserStatus';
import { getImageStyle } from '../../services/helpers';
import { getCdnUrl } from '../../services/cdnService';
import { useBgContrastSides } from '../../../hooks/useBgContrast';
import Avatar from './Avatar';
import ExploreCard from './ExploreCard';

/**
 * Posición de la card en pantalla, para flotar el panel justo encima.
 * Se mide desde el botón pulsado hasta su card contenedora, así que no hace
 * falta un ref y el panel sale siempre donde está la card ahora mismo.
 */
function anchorFromElement(el) {
  const rect = el?.closest('.chat-account-card')?.getBoundingClientRect();
  if (!rect) return null;
  return {
    left: Math.round(rect.left),
    bottom: Math.round(window.innerHeight - rect.top + 8),
    width: Math.round(rect.width),
  };
}

/**
 * ChatAccountCard — tu propia cuenta, anclada al pie del listado de chats.
 *
 * Muestra avatar, nombre y, debajo, qué estás haciendo ahora mismo (la misma
 * actividad de la card del perfil: música, vídeo o juego). La card entera es
 * clicable y abre tu tarjeta de Explore en un panel flotante encima de ella; el
 * icono de información (independiente, para no anidar botones) abre los
 * detalles de la cuenta.
 *
 * Los paneles NO son modales: son un div flotante en un portal a <body>, sin
 * backdrop, así que flotan sobre la interfaz y se cierran al hacer clic fuera,
 * con Escape o con la X. Al ser position: fixed tampoco los recorta el
 * overflow del sidebar.
 *
 * Los 3 puntos abren el mismo menú .fc-dropdown que el resto de la app (el de
 * tu propia tarjeta de perfil): compartir perfil y elegir estado, vía
 * useUserStatus.
 *
 * El banner del perfil se usa como fondo de la card, colocado y velado igual
 * que el banner de las cards de Explore (cover + degradado oscuro), para que
 * ambas se vean igual. El color del texto sale de useBgContrastSides, que mide
 * la luminancia de la MITAD IZQUIERDA y de la DERECHA por separado: un banner
 * negro a la izquierda y blanco a la derecha necesita texto claro en una zona y
 * oscuro en la otra, así que el nombre y la actividad usan el color de la
 * izquierda y los botones de icono el de la derecha. Si las dos mitades dan un
 * color parecido se usa uno solo. Con banner claro no se echa velo blanco (se
 * lavaba la imagen). Si el banner no carga, la card vuelve a los colores del
 * tema.
 *
 * Solo es la cuenta del usuario en sesión: no consulta la actividad de otros.
 * La actividad se lee del detector en vivo si estamos en la app de escritorio y
 * la tenías activada; si no (navegador, o actividad apagada), se cae a lo último
 * publicado en el perfil. Con la actividad apagada en Ajustes no se muestra nada.
 *
 * Los contadores de seguidores/siguiendo se piden con getFollowCounts y se
 * mantienen al día con Realtime sobre `follows` (mismo patrón que
 * FollowCountsWatcher), porque las columnas `profiles.followers/followings` son
 * contadores que pueden ir con retraso.
 */
export default function ChatAccountCard() {
  const { t, locale, showAccent } = useI18n();
  const { user, profile } = useAuth();
  const { activity: liveActivity } = useLocalActivityState();
  const [panel, setPanel] = useState(null); // null | { kind: 'card' | 'details', ...anchor }
  const [menu, setMenu] = useState(null); // null | { top, right } — menú fc-dropdown
  const { myStatus, setMyStatus } = useUserStatus(user?.id);

  // ── Contadores en vivo ──
  // Cache primero (pinta al instante) y refresco en segundo plano; cualquier
  // INSERT/DELETE en `follows` que me afecte vuelve a pedirlos.
  const [counts, setCounts] = useState(() => getCachedFollowCounts(user?.id) || null);

  useEffect(() => {
    if (!user?.id) return undefined;
    let alive = true;

    const refresh = async () => {
      try {
        const next = await getFollowCounts(user.id);
        if (!alive) return;
        setCounts(next);
        setCachedFollowCounts(user.id, next);
      } catch (err) {
        console.warn('[ChatAccountCard] No se pudieron leer los contadores:', err?.message || err);
      }
    };

    refresh();

    const channel = supabase
      .channel(`chat-account-counts-${user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'follows', filter: `following_id=eq.${user.id}` }, refresh)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'follows', filter: `following_id=eq.${user.id}` }, refresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'follows', filter: `follower_id=eq.${user.id}` }, refresh)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'follows', filter: `follower_id=eq.${user.id}` }, refresh)
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  // ── Cierre del panel flotante ──
  // Clic fuera (salvo en la propia card, que ya gestiona su botón), Escape y
  // redimensionar la ventana (la card se habría movido y el panel quedaría
  // desanclado).
  useEffect(() => {
    if (!panel) return undefined;

    const handlePointerDown = (e) => {
      if (e.target.closest('.chat-account-float')) return;
      if (e.target.closest('.chat-account-card')) return;
      setPanel(null);
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setPanel(null);
    };
    const handleResize = () => setPanel(null);

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [panel]);

  // ── Cierre del menú fc-dropdown ──
  useEffect(() => {
    if (!menu) return undefined;

    const handlePointerDown = (e) => {
      if (e.target.closest('.fc-dropdown')) return;
      if (e.target.closest('.chat-account-card-menu-btn')) return;
      setMenu(null);
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setMenu(null);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menu]);

  const openPanel = (kind) => (event) => {
    const anchor = anchorFromElement(event.currentTarget);
    if (!anchor) return;
    setMenu(null);
    setPanel({ kind, ...anchor });
  };

  // El menú se abre hacia ARRIBA del botón: la card está al pie del sidebar, así
  // que un dropdown hacia abajo se saldría de la pantalla.
  const handleOpenMenu = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPanel(null);
    setMenu((open) => (open ? null : {
      bottom: Math.round(window.innerHeight - rect.top + 6),
      right: Math.round(window.innerWidth - rect.right),
    }));
  };

  const handleShareProfile = async () => {
    setMenu(null);
    const url = `${window.location.origin}/profile/${username}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    toast.success(t('profile.share_copied') || 'Profile link copied!');
  };

  const closePanel = () => setPanel(null);

  // ── Actividad ──
  const settings = getActivitySettings(profile);
  const isLive = settings.enabled && isLocalActivityAvailable();
  const activity = isLive
    ? normalizeActivity(liveActivity)
    : settings.enabled
      ? activityFromProfile(profile)
      : null;

  const name = profile?.displayname || profile?.username || user?.user_metadata?.username || '';
  const username = profile?.username || user?.user_metadata?.username || '';

  // ── Banner como fondo ──
  const bannerUrl = profile?.banner_url || null;
  const [brokenBanner, setBrokenBanner] = useState(null);
  const showBanner = Boolean(bannerUrl) && brokenBanner !== bannerUrl;
  // Color por mitades: el nombre y la actividad van sobre la izquierda y los
  // dos botones de icono sobre la derecha, así que cada zona lleva el color que
  // se lee en SU trozo de banner. Si las dos mitades dan el mismo color, se usa
  // uno solo para toda la card.
  const bannerSides = useBgContrastSides(showBanner ? bannerUrl : null);
  const splitBanner = bannerSides.left !== bannerSides.right;
  // '#000000' ⇒ esa zona clara ⇒ texto e iconos oscuros.
  const lightBanner = bannerSides.left === '#000000';
  // Tinte del hover opuesto al color del texto, para que el botón se marque sin
  // desaparecer sobre la imagen.
  const hoverTint = (fg) => (fg === '#000000'
    ? 'rgba(0, 0, 0, 0.12)'
    : 'rgba(255, 255, 255, 0.2)');

  const bannerVars = showBanner
    ? {
        '--chat-account-fg': bannerSides.left,
        '--chat-account-fg-right': bannerSides.right,
        // Con el banner partido no se echa velo: cada mitad ya es contraria a su
        // texto, y oscurecerla estropearía justo la que va en negro.
        '--chat-account-scrim': splitBanner
          ? 'none'
          : lightBanner
            ? 'linear-gradient(180deg, rgba(0, 0, 0, 0.02) 0%, rgba(0, 0, 0, 0.07) 100%)'
            : 'linear-gradient(180deg, rgba(0, 0, 0, 0.2) 0%, rgba(0, 0, 0, 0.6) 100%)',
        '--chat-account-hover': hoverTint(bannerSides.left),
        '--chat-account-hover-right': hoverTint(bannerSides.right),
      }
    : undefined;

  const ActivityIcon = !activity
    ? null
    : activity.kind === 'game'
      ? FaGamepad
      : activity.kind === 'video'
        ? FaTv
        : FaMusic;

  const activityDetail = activity
    ? [activity.title, activity.subtitle].filter(Boolean).join(' · ')
    : '';

  const joined = (() => {
    const date = new Date(profile?.created_at || user?.created_at || '');
    if (Number.isNaN(date.getTime())) return '';
    try {
      return date.toLocaleDateString(locale || 'en', { year: 'numeric', month: 'long' });
    } catch {
      return date.toLocaleDateString();
    }
  })();

  const rows = [
    { label: t('chat.account_joined'), value: joined || '—' },
    { label: t('chat.account_followers'), value: counts?.followers ?? profile?.followers ?? 0 },
    { label: t('chat.account_following'), value: counts?.following ?? profile?.followings ?? 0 },
    {
      label: t('chat.account_privacy'),
      value: profile?.is_private ? t('settings.private_profile') : t('settings.public_profile'),
    },
  ];

  const panelStyle = panel
    ? {
        '--anchor-left': `${panel.left}px`,
        '--anchor-bottom': `${panel.bottom}px`,
        '--anchor-width': `${panel.width}px`,
      }
    : undefined;

  return (
    <>
      <div className={`chat-account-card${showBanner ? ' chat-account-card--banner' : ''}`} style={bannerVars}>
        {showBanner && (
          <div className="chat-account-card-banner" aria-hidden="true">
            <img
              src={getCdnUrl(bannerUrl)}
              alt=""
              style={{ ...getImageStyle(profile?.banner_position), objectFit: 'cover' }}
              onError={() => setBrokenBanner(bannerUrl)}
            />
            <div className="chat-account-card-scrim" />
          </div>
        )}

        <button
          type="button"
          className="chat-account-card-main"
          onClick={openPanel('card')}
          title={t('chat.account_open_card')}
          aria-label={t('chat.account_open_card')}
          aria-expanded={panel?.kind === 'card'}
        >
          <Avatar
            src={profile?.avatar_url}
            alt={username || '?'}
            className="chat-account-card-avatar"
            status={myStatus}
          />

          <span className="chat-account-card-info">
            <span className="chat-account-card-name" title={name}>{name}</span>
            <span
              className={`chat-account-card-activity${activity ? '' : ' chat-account-card-activity--idle'}`}
              title={activityDetail || t('chat.account_idle')}
            >
              {ActivityIcon && <ActivityIcon className="chat-account-card-activity-icon" />}
              {activityDetail || t('chat.account_idle')}
            </span>
          </span>
        </button>

        <button
          type="button"
          className="chat-account-card-info-btn"
          onClick={openPanel('details')}
          aria-label={t('chat.account_info_aria')}
          title={t('chat.account_info_aria')}
          aria-expanded={panel?.kind === 'details'}
        >
          <FaInfoCircle />
        </button>

        <button
          type="button"
          className="chat-account-card-info-btn chat-account-card-menu-btn"
          onClick={handleOpenMenu}
          aria-label={t('chat.account_menu_aria')}
          title={t('chat.account_menu_aria')}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
        >
          <FaEllipsisH />
        </button>
      </div>

      {panel && createPortal(
        <div
          className={`chat-account-float chat-account-float--${panel.kind}`}
          style={panelStyle}
          role="dialog"
        >
          {panel.kind === 'card' && profile ? (
            /* Tu tarjeta de Explore, la misma del grid (sin el botón de seguir). */
            <div className="chat-account-explore-wrap">
              <button
                type="button"
                className="chat-account-explore-close"
                onClick={closePanel}
                aria-label={t('common.close')}
              >
                <FaTimes />
              </button>
              <ExploreCard
                profile={profile}
                counts={counts}
                isOwnProfile
                showAccent={showAccent}
              />
            </div>
          ) : (
            <>
              <div className="chat-account-modal-header">
                <Avatar
                  src={profile?.avatar_url}
                  alt={username || '?'}
                  className="chat-account-modal-avatar"
                />
                <div className="chat-account-modal-identity">
                  <span className="chat-account-modal-name">{name}</span>
                  {username && <span className="chat-account-modal-username">@{username}</span>}
                </div>
                <button
                  type="button"
                  className="chat-account-modal-close"
                  onClick={closePanel}
                  aria-label={t('common.close')}
                >
                  <FaTimes />
                </button>
              </div>

              <div className="chat-account-modal-body">
                {rows.map(({ label, value }) => (
                  <div className="chat-account-modal-row" key={label}>
                    <span className="chat-account-modal-label">{label}</span>
                    <span className="chat-account-modal-value">{value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}

      {menu && createPortal(
        <div
          className="fc-dropdown chat-account-menu"
          role="menu"
          style={{ position: 'fixed', bottom: `${menu.bottom}px`, right: `${menu.right}px`, zIndex: 9999 }}
        >
          <button type="button" className="fc-dropdown-btn" onClick={handleShareProfile} role="menuitem">
            <FaShareAlt />
            {t('profile.share_profile') || 'Share profile'}
          </button>

          <div className="fc-dropdown-divider" />
          <div className="fc-dropdown-label">{t('status.set_status') || 'Set status'}</div>

          {[
            { value: 'online', label: t('status.set_online') || 'Online' },
            { value: 'idle', label: t('status.set_idle') || 'Idle' },
            { value: 'dnd', label: t('status.set_dnd') || 'Do Not Disturb' },
          ].map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={myStatus === value}
              className={`fc-dropdown-btn${myStatus === value ? ' fc-dropdown-btn--active' : ''}`}
              onClick={() => { setMyStatus(value); setMenu(null); }}
            >
              <span className={`fc-dropdown-status-dot fc-dropdown-status-dot--${value}`} />
              {label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
