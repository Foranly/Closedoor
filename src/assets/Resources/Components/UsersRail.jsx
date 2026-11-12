import { Link } from 'react-router-dom';
import { Fragment, useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import './css/header.css';
import './css/usersRail.css';
import { IconBars, IconUsers } from './ShellIcons';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { subscribePresence } from '../../services/presenceService';
import {
  getConversationMembersWithProfiles,
  subscribeToConversationParticipants,
  subscribeToProfilesUpdates,
} from '../../services/chatService';
import { getItem, setItem } from '../../services/secureStorage';
import Tooltip from './Tooltip';
import Avatar from './Avatar';
import ProfileHoverCard from './ProfileHoverCard';

/**
 * UsersRail — panel derecho con los miembros del grupo abierto en /chat,
 * separados por rol (creador, administradores y miembros).
 *
 * Copia del sidebar (Header.jsx) con otro contenido: mismas clases (`sidebar`,
 * `sidebar-link`, `sidebar-nav`, `sidebar-footer`, `sidebar-mode-menu`…), así
 * que superficie, anchos, animación de colapso, hover y menú de modos vienen de
 * header.css; usersRail.css solo lo espeja a la derecha.
 *
 * Se monta únicamente desde Chat.jsx cuando la conversación activa es un grupo,
 * y solo en escritorio.
 */

const RAIL_MODE_KEY = 'fc_users_rail_mode';
const MODES = ['expanded', 'collapsed', 'hover'];
const DESKTOP_QUERY = '(min-width: 1025px)';

function getInitialMode() {
  try {
    const stored = getItem(RAIL_MODE_KEY);
    if (MODES.includes(stored)) return stored;
  } catch { /* ignore */ }
  return 'collapsed';
}

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e) => setIsDesktop(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}

function UsersRail({ conversationId, memberVersion = 0 }) {
  const { user } = useAuth();
  const { t, showGlobalBg } = useI18n();
  const isDesktop = useIsDesktop();
  const [mode, setMode] = useState(getInitialMode);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  // { [userId]: 'online' | 'dnd' | 'idle' } — el canal global ya lo abre AuthContext.
  const [statuses, setStatuses] = useState({});
  // Participantes con su rol y perfil (incluye a uno mismo). `null` = cargando.
  const [rows, setRows] = useState(null);
  // Se incrementa para volver a pedir la lista (realtime o al recuperar foco).
  const [refreshTick, setRefreshTick] = useState(0);
  const menuRef = useRef(null);
  const asideRef = useRef(null);
  const closeMenuTimer = useRef(null);

  // Modo 'hover': colapsado por defecto; se expande mientras el ratón pasa por
  // encima O mientras el foco del teclado esté dentro (accesibilidad).
  const collapsed = mode === 'collapsed' || (mode === 'hover' && !hovering && !focused);

  // Persistir preferencia del modo del rail
  useEffect(() => {
    try {
      setItem(RAIL_MODE_KEY, mode);
    } catch { /* ignore */ }
  }, [mode]);

  // Al entrar en modo 'hover': si el cursor ya está sobre el rail (p.ej. tras
  // pulsar el botón del footer, que está DENTRO del rail) o el foco está dentro,
  // expandir de inmediato. Se resuelve en el handler `applyMode` en vez de en un
  // efecto para no encadenar renders (regla react-hooks/set-state-in-effect).
  const applyMode = (nextMode) => {
    const el = asideRef.current;
    setMode(nextMode);
    setHovering(nextMode === 'hover' && !!el && el.matches(':hover'));
    setFocused(nextMode === 'hover' && !!el &&
      el.contains(document.activeElement) && document.activeElement !== document.body);
    setMenuOpen(false);
  };

  // Cerrar el menú de modos al hacer clic fuera o con Escape
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const handleKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  // Abre el menú de modos junto al botón (position: fixed, fuera del scroll del
  // rail). Al estar anclado a la derecha, el menú sale hacia la izquierda.
  const openSidebarMenu = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const MENU_W = 168;
    const MENU_H = 124;
    let x = r.left - MENU_W - 8;
    let y = r.bottom - MENU_H;
    x = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - MENU_H - 8));
    setMenuPos({ x, y });
    setMenuOpen((s) => !s);
  };

  const modeLabelFor = (m) =>
    m === 'expanded' ? t('nav.sidebar_expanded') :
    m === 'collapsed' ? t('nav.sidebar_collapsed') :
    t('nav.sidebar_hover');

  // El menú de modos se renderiza en un portal a <body>: igual que en el
  // sidebar, el rail usa backdrop-filter y overflow-y, así que dentro quedaría
  // recortado. Al ser hijo de <body>, el mouseleave del aside dispara antes que
  // el mouseenter del menú: el cierre se retrasa y se cancela al entrar.
  const cancelMenuClose = () => {
    if (closeMenuTimer.current) {
      clearTimeout(closeMenuTimer.current);
      closeMenuTimer.current = null;
    }
  };
  const closeMenuSoon = () => {
    cancelMenuClose();
    closeMenuTimer.current = setTimeout(() => {
      closeMenuTimer.current = null;
      setHovering(false);
      setFocused(false);
      setMenuOpen(false);
    }, 150);
  };

  useEffect(() => () => {
    if (closeMenuTimer.current) clearTimeout(closeMenuTimer.current);
  }, []);

  const onMouseEnter = mode === 'hover' ? () => setHovering(true) : undefined;
  const onMouseLeave = mode === 'hover' ? () => {
    if (menuOpen) { closeMenuSoon(); return; }
    setHovering(false);
    setFocused(false);
  } : undefined;
  const onFocus = mode === 'hover' ? () => setFocused(true) : undefined;
  const onBlur = mode === 'hover' ? () => setFocused(false) : undefined;

  // En modo 'hover' no hay tooltips: basta pasar el ratón (o tabular) para ver las etiquetas
  const tooltipText = (labelKey) => (collapsed && mode !== 'hover' ? t(labelKey) : '');
  // Filas: plegado sin hover, el tooltip muestra el nombre del usuario.
  const rowsTooltip = collapsed && mode !== 'hover';

  const modeLabel = modeLabelFor(mode);

  // ── Estado (punto del avatar) de los miembros, desde el canal global ──
  useEffect(() => {
    if (!user) return undefined;
    return subscribePresence((snapshot) => {
      const next = {};
      Object.keys(snapshot).forEach((id) => {
        next[id] = snapshot[id]?.user_status || 'online';
      });
      setStatuses(next);
    });
  }, [user]);

  // ── Miembros del grupo con su rol ──
  // Se recarga cuando cambia la conversación, cuando `memberVersion` cambia
  // (altas/bajas desde Chat.jsx) y en cada `refreshTick` (realtime / foco).
  useEffect(() => {
    if (!conversationId) return undefined;
    let cancelled = false;
    (async () => {
      const data = await getConversationMembersWithProfiles(conversationId).catch(() => []);
      if (cancelled) return;
      setRows((data || []).filter((m) => m.profile && m.profile.username));
    })();
    return () => { cancelled = true; };
  }, [conversationId, memberVersion, refreshTick]);

  // Altas, bajas y cambios de rol de los participantes, en vivo.
  useEffect(() => {
    if (!conversationId) return undefined;
    return subscribeToConversationParticipants(
      conversationId,
      () => setRefreshTick((t) => t + 1)
    );
  }, [conversationId]);

  // Ediciones de perfil de los miembros (nick, @usuario, avatar…), en vivo.
  // La clave evita re-suscribirse cuando el refetch devuelve los mismos ids.
  const memberIdsKey = useMemo(
    () => (rows ? rows.map((m) => m.user_id).filter(Boolean).sort().join(',') : ''),
    [rows]
  );
  useEffect(() => {
    if (!memberIdsKey) return undefined;
    return subscribeToProfilesUpdates(
      memberIdsKey.split(','),
      () => setRefreshTick((t) => t + 1)
    );
  }, [memberIdsKey]);

  // Red de seguridad: al volver a la pestaña se refresca (por si Realtime de
  // `profiles` no estuviera habilitado en el proyecto).
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) setRefreshTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // Agrupados por rol: creador → administradores → miembros.
  const groups = useMemo(() => {
    const byRole = (role) => (rows || [])
      .filter((m) => (m.role || 'member') === role)
      .map((m) => m.profile)
      .sort((a, b) => (a.displayname || a.username).localeCompare(b.displayname || b.username));
    return [
      { role: 'owner', label: t('users_rail.group_owner'), members: byRole('owner') },
      { role: 'admin', label: t('users_rail.group_admin'), members: byRole('admin') },
      { role: 'member', label: t('users_rail.group_member'), members: byRole('member') },
    ].filter((g) => g.members.length > 0);
  }, [rows, t]);

  if (!user || !isDesktop) return null;

  // `sidebar--chat`: el rail solo existe en /chat (card flotante del tema).
  return (
    <aside
      ref={asideRef}
      className={`sidebar sidebar--users sidebar--chat${collapsed ? ' sidebar--collapsed' : ''}${!showGlobalBg ? ' sidebar--solid' : ''}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="sidebar-brand">
        <div className="minicard_profile">
          <span className="sidebar-icon"><IconUsers /></span>
          <div className="user_nick">
            <p>{t('users_rail.title')}</p>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {rows === null ? null : groups.length === 0 ? (
          <p className="users-rail-empty">{t('users_rail.empty')}</p>
        ) : groups.map((group) => (
          <Fragment key={group.role}>
            <p className="users-rail-group-title">{group.label}</p>
            {group.members.map((member) => {
              const label = member.displayname || member.username;
              return (
                <ProfileHoverCard
                  key={`${group.role}-${member.id}`}
                  userId={member.id}
                  className="users-rail-item-wrap"
                  placement="left"
                >
                  <Tooltip text={rowsTooltip ? label : ''} placement="left" className="users-rail-item-wrap">
                    <Link
                      to={`/profile/${encodeURIComponent(member.username)}`}
                      className="sidebar-link"
                    >
                      <span className="sidebar-icon users-rail-icon">
                        <Avatar
                          src={member.avatar_url}
                          alt={label}
                          status={statuses[member.id]}
                          className="users-rail-avatar"
                        />
                      </span>
                      <div className="users-rail-text">
                        <p className="users-rail-nick">{label}</p>
                        <p className="users-rail-handle">@{member.username}</p>
                      </div>
                    </Link>
                  </Tooltip>
                </ProfileHoverCard>
              );
            })}
          </Fragment>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-mode-wrap">
          <Tooltip text={tooltipText('nav.sidebar_cycle')} placement="left">
            <button
              type="button"
              className="sidebar-link"
              onClick={openSidebarMenu}
              aria-label={`${modeLabel} — ${t('nav.sidebar_cycle')}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="sidebar-icon"><IconBars /></span>
              <span className="sidebar-footer-label">{modeLabel}</span>
            </button>
          </Tooltip>
          {menuOpen && createPortal(
            <div
              className="sidebar-mode-menu"
              style={{ left: menuPos.x, top: menuPos.y }}
              ref={menuRef}
              role="menu"
              onMouseEnter={cancelMenuClose}
              onMouseLeave={() => {
                if (mode === 'hover') { setHovering(false); setFocused(false); setMenuOpen(false); }
              }}
            >
              {MODES.map((m) => {
                const isActive = m === mode;
                return (
                  <button
                    key={m}
                    type="button"
                    role="menuitem"
                    className={`sidebar-mode-menu-item${isActive ? ' sidebar-mode-menu-item--active' : ''}`}
                    onClick={() => applyMode(m)}
                  >
                    <span className="sidebar-icon"><IconBars /></span>
                    <span>{modeLabelFor(m)}</span>
                    {isActive && (
                      <svg className="sidebar-mode-menu-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>,
            document.body
          )}
        </div>
      </div>
    </aside>
  );
}

export default UsersRail;
