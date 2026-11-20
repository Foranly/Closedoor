import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from "react";
import ModalShell from './ModalShell';
import { useNavigate } from "react-router-dom";
import { useI18n } from "../../services/i18n/useI18n";
import { useAuth } from "../../../hooks/useAuth";
import { getFollowers, getFollowing, getFollowersCounts, getCachedFollowers, getCachedFollowing, setCachedFollowers, setCachedFollowing } from "../../services/followService";
import { getNicknames, getCachedNicknames, cacheNicknames } from "../../services/chatService";
import { FaChevronDown } from "react-icons/fa";
import FollowButton from "./FollowButton";
import Avatar from "./Avatar";
import Badge from "./Badge";
import "./css/modal.css";
import "./css/followersModal.css";

function FollowersModalItem({ user, onClose }) {
  const navigate = useNavigate();

  const handleClick = useCallback((e) => {
    if (e.target.closest('.followers-modal-action')) return;
    onClose();
    navigate(`/profile/${user.username}`);
  }, [navigate, onClose, user.username]);

  return (
    <div className="followers-modal-item" onClick={handleClick}>
      <Avatar
        className="followers-modal-avatar"
        src={user.avatar_url}
        alt={user.username}
        frame={user.avatar_frame_url}
        framePosition={user.avatar_frame_position}
      />

      <div className="followers-modal-info">
        <div className="followers-modal-name-row">
          <span className="followers-modal-username">{user.username}</span>
          {Array.isArray(user.roles) && user.roles.some(r => r !== 'user') && (
            <span className="followers-modal-badges">
              <Badge roles={user.roles} />
            </span>
          )}
        </div>
      </div>

      <div className="followers-modal-action">
        <FollowButton targetUserId={user.id} />
      </div>
    </div>
  );
}

export default function FollowersModal({ isOpen = true, userId, type, onClose }) {
  const { t } = useI18n();
  const { user } = useAuth();
  // Los nicknames son por-usuario (cada quien tiene su propio mapa de apodos),
  // así que se cargan con el usuario AUTENTICADO, no con el dueño del perfil.
  const nicknameOwnerId = user?.id || userId;

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const searchTimeoutRef = useRef(null);

  // Orden de la lista: 'relevant' (badges + más seguidos primero) | 'date' (más recientes primero)
  const [sortMode, setSortMode] = useState('relevant');
  // Dirección del orden: 'desc' (default) | 'asc'
  const [sortDir, setSortDir] = useState('desc');
  // Dropdown de orden (una sola opción combina modo + dirección)
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef(null);
  // Map { userId: followerCount } para el orden por relevancia (popularidad)
  const [followerCounts, setFollowerCounts] = useState({});

  // Debounce 200ms antes de actualizar el filtro
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!searchQuery) {
      setDebouncedQuery('');
      return;
    }
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 200);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchQuery]);

  const isFollowers = type === "followers";
  const title = isFollowers ? t('followers.title') : t('following.title');

  // ── Nicknames (display name override from chat_nicknames, cache-first) ──
  const [nicknames, setNicknames] = useState(() => {
    if (nicknameOwnerId) {
      const cached = getCachedNicknames(nicknameOwnerId);
      if (cached) return cached;
    }
    return {};
  });
  useEffect(() => {
    if (!nicknameOwnerId) return;
    getNicknames(nicknameOwnerId).then((map) => {
      setNicknames(map);
      cacheNicknames(nicknameOwnerId, map);
    }).catch(() => {});
  }, [nicknameOwnerId]);

  // Scroll locking, Escape handling: manejado por ModalShell (<dialog> nativo)

  // Restaurar cache síncrono en useState para evitar flicker
  const [users, setUsers] = useState(() => {
    if (!userId) return [];
    return isFollowers
      ? getCachedFollowers(userId) || []
      : getCachedFollowing(userId) || [];
  });
  const [loading, setLoading] = useState(() => {
    if (!userId) return true;
    const cached = isFollowers
      ? getCachedFollowers(userId)
      : getCachedFollowing(userId);
    return !cached;
  });

  // useLayoutEffect: restaura la cache del tipo actual ANTES del paint, para que
  // al cambiar followers↔following no haya un frame mostrando la lista del tipo
  // anterior (el modal está siempre montado; el estado inicial solo aplica al
  // primer montaje). El fetch sigue en background.
  useLayoutEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const cached = isFollowers
      ? getCachedFollowers(userId)
      : getCachedFollowing(userId);
    setUsers(cached || []);
    // Solo mostrar loader si no hay nada que mostrar todavía
    if (!cached) setLoading(true);

    const fetchUsers = async () => {
      try {
        const data = isFollowers
          ? await getFollowers(userId)
          : await getFollowing(userId);
        if (cancelled) return;
        setUsers(data || []);
        // Actualizar cache
        if (isFollowers) {
          setCachedFollowers(userId, data || []);
        } else {
          setCachedFollowing(userId, data || []);
        }
      } catch (err) {
        console.warn(`Error fetching ${type}:`, err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // Siempre hacer fetch en background para refrescar datos
    fetchUsers();
    return () => { cancelled = true; };
  }, [userId, type, isFollowers]);

  // ── Counts de seguidores (solo cuando se ordena por relevancia) ──
  // El ref guarda el set de ids ya consultado para no re-fetch cuando `users`
  // cambia de identidad (cache → fetch) con los mismos ids; el chequeo en .then
  // evita aplicar resultados de una lista obsoleta.
  const countsFetchedForRef = useRef(null);
  useEffect(() => {
    if (sortMode !== 'relevant' || users.length === 0) {
      setFollowerCounts({});
      countsFetchedForRef.current = null;
      return;
    }
    const idsKey = users.map((u) => u.id).sort().join(',');
    if (countsFetchedForRef.current === idsKey) return;
    countsFetchedForRef.current = idsKey;
    getFollowersCounts(users.map((u) => u.id)).then((map) => {
      if (countsFetchedForRef.current === idsKey) setFollowerCounts(map);
    }).catch(() => {
      if (countsFetchedForRef.current === idsKey) setFollowerCounts({});
    });
  }, [sortMode, users]);

  // ── Dropdown: cerrar al hacer clic fuera ──
  useEffect(() => {
    if (!sortMenuOpen) return;
    const handleClick = (e) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target)) {
        setSortMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [sortMenuOpen]);

  // ── Dropdown: Escape cierra solo el menú (no el modal) ──
  useEffect(() => {
    if (!sortMenuOpen) return;
    const menuEl = sortMenuRef.current;
    if (!menuEl) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setSortMenuOpen(false);
      }
    };
    menuEl.addEventListener('keydown', onKeyDown);
    return () => menuEl.removeEventListener('keydown', onKeyDown);
  }, [sortMenuOpen]);

  const hasBadge = (u) => Array.isArray(u.roles) && u.roles.some((r) => r !== 'user');

  // Opciones del dropdown: cada una combina modo + dirección
  const sortOptions = useMemo(() => {
    const relevant = t('followers.sort_relevant') || 'Relevantes';
    const date = t('followers.sort_date') || 'Fecha de seguimiento';
    const ascLabel = t('followers.sort_asc') || 'Ascendente';
    const descLabel = t('followers.sort_desc') || 'Descendente';
    return [
      { mode: 'relevant', dir: 'desc', modeLabel: relevant, label: `${relevant} ↓`, a11y: `${relevant} ${descLabel}` },
      { mode: 'relevant', dir: 'asc', modeLabel: relevant, label: `${relevant} ↑`, a11y: `${relevant} ${ascLabel}` },
      { mode: 'date', dir: 'desc', modeLabel: date, label: `${date} ↓`, a11y: `${date} ${descLabel}` },
      { mode: 'date', dir: 'asc', modeLabel: date, label: `${date} ↑`, a11y: `${date} ${ascLabel}` },
    ];
  }, [t]);

  const currentSort = sortOptions.find((o) => o.mode === sortMode && o.dir === sortDir) || sortOptions[0];

  // Filtro por búsqueda + orden según el modo activo
  const sortedUsers = useMemo(() => {
    const base = debouncedQuery
      ? users.filter((u) => {
          const q = debouncedQuery.toLowerCase();
          const uname = (u.username || '').toLowerCase();
          const nick = (nicknames[u.id] || '').toLowerCase();
          return uname.includes(q) || nick.includes(q);
        })
      : users;

    // desc (default) → +1 preserva el orden original (nuevos/más seguidos primero);
    // asc → -1 lo invierte (antiguos/menos seguidos primero).
    const dir = sortDir === 'asc' ? -1 : 1;

    if (sortMode === 'date') {
      return [...base].sort((a, b) =>
        dir * (new Date(b.followed_since || 0) - new Date(a.followed_since || 0))
      );
    }

    // Relevantes: primero los que tienen badges, luego por popularidad (más seguidores),
    // con tie-break por fecha (determinístico). La dirección invierte popularidad/fecha,
    // pero los badges siempre van primero.
    return [...base].sort((a, b) => {
      const badgeA = hasBadge(a) ? 1 : 0;
      const badgeB = hasBadge(b) ? 1 : 0;
      if (badgeA !== badgeB) return badgeB - badgeA;
      const countDiff = (followerCounts[b.id] || 0) - (followerCounts[a.id] || 0);
      if (countDiff !== 0) return dir * countDiff;
      return dir * (new Date(b.followed_since || 0) - new Date(a.followed_since || 0));
    });
  }, [debouncedQuery, users, nicknames, sortMode, sortDir, followerCounts]);

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} onEscape={onClose} className="followers-modal">
        <div className="followers-modal-header">
          <h3 className="fc-modal-title">{title}</h3>
          <button
            type="button"
            className="followers-modal-close"
            onClick={onClose}
            aria-label={t('followers.close')}
          >
            ×
          </button>
        </div>

        {loading ? (
          <div className="followers-modal-loading">{t('common.loading')}</div>
        ) : users.length === 0 && !searchQuery ? (
          <div className="followers-modal-empty">
            <p>
              {isFollowers
                ? t('followers.empty')
                : t('following.empty')}
            </p>
          </div>
        ) : (<>
          <div className="followers-modal-search">
            <div className="followers-modal-search-wrap">
              <svg className="followers-modal-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                className="followers-modal-search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={isFollowers ? t('followers.search_placeholder') || 'Buscar seguidor...' : t('following.search_placeholder') || 'Buscar siguiendo...'}
              />
            </div>
          </div>
          <div className="followers-modal-sort" ref={sortMenuRef}>
            <button
              type="button"
              className="followers-modal-sort-btn"
              onClick={() => setSortMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={sortMenuOpen}
            >
              <span className="followers-modal-sort-btn-label">{currentSort.modeLabel}</span>
              <FaChevronDown className="followers-modal-sort-btn-chevron" />
            </button>
            {sortMenuOpen && (
              <div className="followers-modal-sort-menu fc-dropdown" role="menu">
                {sortOptions.map((opt) => {
                  const active = opt.mode === sortMode && opt.dir === sortDir;
                  return (
                    <button
                      key={`${opt.mode}-${opt.dir}`}
                      type="button"
                      role="menuitem"
                      aria-pressed={active}
                      aria-label={opt.a11y}
                      className={`fc-dropdown-btn${active ? ' fc-dropdown-btn--active' : ''}`}
                      onClick={() => {
                        setSortMode(opt.mode);
                        setSortDir(opt.dir);
                        setSortMenuOpen(false);
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {sortedUsers.length === 0 ? (
            <div className="followers-modal-empty">
              <p>{t('followers.search_empty') || 'Sin resultados'}</p>
            </div>
          ) : (
            <div className="followers-modal-list">
              {sortedUsers.map((u) => (
                <FollowersModalItem key={u.id} user={u} onClose={onClose} />
              ))}
            </div>
          )}
        </>)
        }
    </ModalShell>
  );
}
