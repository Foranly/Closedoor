import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { NotificationContext } from '../../context/NotificationContext';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../services/i18n/useI18n';
import { acceptFollowRequest, rejectFollowRequest } from '../services/followService';
import { FaUserPlus, FaHeart, FaHeartBroken, FaComment, FaRetweet, FaBullhorn, FaBell, FaLock, FaPoll, FaCheck, FaTimes, FaChevronDown } from 'react-icons/fa';
import Avatar from '../Resources/Components/Avatar';
import Tooltip from '../Resources/Components/Tooltip';
import VirtualPostList from '../Resources/Components/VirtualPostList';
import '../Resources/Styles/post.css';
import '../Resources/Styles/notifications.css';
import usePageTitle from '../../hooks/usePageTitle';
import '../Resources/Styles/skeleton.css';

function getIcon(type) {
  switch (type) {
    case 'follow':
    case 'follow_request':
    case 'follow_request_accepted':
    case 'follow_request_rejected':
      return <FaUserPlus />;
    case 'like':
      return <FaHeart />;
    case 'dislike':
      return <FaHeartBroken />;
    case 'comment':
    case 'comment_reply':
      return <FaComment />;
    case 'repost':
      return <FaRetweet />;
    case 'comment_like':
      return <FaHeart />;
    case 'mention':
    case 'comment_mention':
      return <FaBullhorn />;
    case 'encrypted_add':
      return <FaLock />;
    case 'poll_vote':
      return <FaPoll />;
    default:
      return <FaBell />;
  }
}

function getNotificationMessage(t, type, username) {
  switch (type) {
    case 'follow':
      return <><strong>{username}</strong> {t('notifications.followed')}</>;
    case 'follow_request':
      return <><strong>{username}</strong> {t('notifications.follow_request')}</>;
    case 'follow_request_accepted':
      return <><strong>{username}</strong> {t('notifications.follow_request_accepted')}</>;
    case 'follow_request_rejected':
      return <><strong>{username}</strong> {t('notifications.follow_request_rejected')}</>;
    case 'like':
      return <><strong>{username}</strong> {t('notifications.liked')}</>;
    case 'dislike':
      return <><strong>{username}</strong> {t('notifications.disliked')}</>;
    case 'comment':
      return <><strong>{username}</strong> {t('notifications.commented')}</>;
    case 'repost':
      return <><strong>{username}</strong> {t('notifications.reposted')}</>;
    case 'comment_like':
      return <><strong>{username}</strong> {t('notifications.comment_liked')}</>;
    case 'mention':
      return <><strong>{username}</strong> {t('notifications.mentioned')}</>;
    case 'comment_mention':
      return <><strong>{username}</strong> {t('notifications.comment_mentioned')}</>;
    case 'comment_reply':
      return <><strong>{username}</strong> {t('notifications.comment_replied')}</>;
    case 'encrypted_add':
      return <><strong>{username}</strong> {t('notifications.encrypted_add')}</>;
    case 'poll_vote':
      return <><strong>{username}</strong> {t('notifications.poll_vote')}</>;
    default:
      return <><strong>{username}</strong> {t('notifications.default')}</>;
  }
}

function getNotificationLink(notification) {
  const actor = notification.actor || {};
  const username = actor.username || '';

  // Notificaciones relacionadas a un post → link al post (y al comentario si aplica)
  if (['like', 'dislike', 'comment', 'repost', 'comment_like', 'comment_reply', 'mention', 'comment_mention', 'encrypted_add', 'poll_vote'].includes(notification.type) && notification.reference_id) {
    const base = `/post/${notification.reference_id}`;
    // Si la notificación referencia un comentario específico, deep-link a él
    return notification.comment_id ? `${base}?comment=${notification.comment_id}` : base;
  }
  // Seguidores → link al perfil del actor
  return `/profile/${username}`;
}

// Agrupación de tipos para los filtros. Cada filtro puede abarcar varios
// tipos (p. ej. "likes" incluye likes, dislikes y likes en comentarios).
const NOTIFICATION_FILTERS = [
  { id: 'all', types: null },
  { id: 'follows', types: ['follow', 'follow_request', 'follow_request_accepted', 'follow_request_rejected'] },
  { id: 'likes', types: ['like', 'dislike', 'comment_like'] },
  { id: 'comments', types: ['comment', 'comment_reply'] },
  { id: 'reposts', types: ['repost'] },
  { id: 'mentions', types: ['mention', 'comment_mention'] },
  { id: 'polls', types: ['poll_vote'] },
  { id: 'encrypted', types: ['encrypted_add'] },
];

function matchesFilter(notification, filterId) {
  const def = NOTIFICATION_FILTERS.find((f) => f.id === filterId);
  if (!def || !def.types) return true;
  return def.types.includes(notification.type);
}

function timeAgo(t, locale, dateString) {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return t('post.just_now');
  if (diffMins < 60) return t('post.minutes_ago', { n: diffMins });
  if (diffHours < 24) return t('post.hours_ago', { n: diffHours });
  if (diffDays < 7) return t('post.days_ago', { n: diffDays });
  return date.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', {
    day: 'numeric',
    month: 'short',
  });
}

export default function Notifications() {
  const { t, locale } = useI18n();
  usePageTitle(t('notifications.title'));
  const {
    notifications,
    unreadCount,
    loading,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    deleteSelected,
  } = useContext(NotificationContext);
  const { user, isAuthenticated } = useAuth();
  const [selectedIds, setSelectedIds] = useState([]);
  const [deletingIds, setDeletingIds] = useState(new Set());
  const [filter, setFilter] = useState('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterDropdownStyle, setFilterDropdownStyle] = useState(null);
  const filterTriggerRef = useRef(null);
  const filterDropdownRef = useRef(null);

  const filteredNotifications = useMemo(
    () => notifications.filter((n) => matchesFilter(n, filter)),
    [notifications, filter]
  );

  const handleFilterChange = (id) => {
    setFilter(id);
    // La selección se reinicia: solo tiene sentido sobre lo que se ve.
    setSelectedIds([]);
  };

  // Reset selection when notifications change (e.g., after delete)
  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => notifications.some((n) => n.id === id)));
  }, [notifications]);

  // Cerrar el dropdown al pulsar fuera (trigger o panel).
  useEffect(() => {
    if (!filterOpen) return undefined;
    const onPointerDown = (e) => {
      const inTrigger = filterTriggerRef.current && filterTriggerRef.current.contains(e.target);
      const inDropdown = filterDropdownRef.current && filterDropdownRef.current.contains(e.target);
      if (!inTrigger && !inDropdown) setFilterOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [filterOpen]);

  // El panel va en portal con position: fixed (igual que el filtro de posts del
  // perfil) para que no lo recorte ningún contenedor con overflow.
  const handleToggleFilter = () => {
    if (!filterOpen) {
      const rect = filterTriggerRef.current?.getBoundingClientRect();
      if (rect) {
        setFilterDropdownStyle({
          position: 'fixed',
          top: `${rect.bottom + 4}px`,
          left: `${rect.left}px`,
          zIndex: 9999,
        });
      }
    }
    setFilterOpen((prev) => !prev);
  };

  if (!isAuthenticated) {
    return (
      <div className="notifications-page">
        <p>{t('notifications.login_prompt')}</p>
      </div>
    );
  }

  const allSelected =
    filteredNotifications.length > 0 &&
    filteredNotifications.every((n) => selectedIds.includes(n.id));

  const handleSelectAll = () => {
    if (allSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredNotifications.map((n) => n.id));
    }
  };

  const handleSelectOne = (id) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const handleDeleteSelectedAction = async () => {
    if (selectedIds.length === 0) return;
    setDeletingIds(new Set(selectedIds));
    await deleteSelected(selectedIds);
    setSelectedIds([]);
    setDeletingIds(new Set());
  };

  const handleDeleteOne = async (id) => {
    setDeletingIds((prev) => new Set(prev).add(id));
    await deleteNotification(id);
    setDeletingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // ── Accept/Reject follow requests ──
  const handleAcceptRequest = async (notif, actorId) => {
    if (!user?.id) return;
    try {
      await acceptFollowRequest(actorId, user.id);
      // Remove the notification after accepting
      deleteNotification(notif.id);
    } catch (err) {
      console.warn('Error accepting follow request:', err);
    }
  };

  const handleRejectRequest = async (notif, actorId) => {
    if (!user?.id) return;
    try {
      await rejectFollowRequest(actorId, user.id);
      deleteNotification(notif.id);
    } catch (err) {
      console.warn('Error rejecting follow request:', err);
    }
  };

  const hasSelection = selectedIds.length > 0;

  return (
    <div className="notifications-page">
      <div className="notifications-header">
        <div className="notifications-header-actions">
          {!loading && notifications.length > 0 && (
            <div className="notifications-filter">
              <button
                type="button"
                ref={filterTriggerRef}
                className="notifications-select-all-btn notifications-filter-btn"
                onClick={handleToggleFilter}
                aria-expanded={filterOpen}
                aria-haspopup="listbox"
              >
                {t(`notifications.filter_${filter}`)}
                <span
                  className={`posts-tab-filter-toggle ${filterOpen ? 'posts-tab-filter-toggle--open' : ''}`}
                >
                  <FaChevronDown />
                </span>
              </button>

              {filterOpen && filterDropdownStyle && createPortal(
                <div
                  ref={filterDropdownRef}
                  className="posts-tab-filter-dropdown notifications-filter-dropdown"
                  style={filterDropdownStyle}
                  role="listbox"
                >
                  {NOTIFICATION_FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="option"
                      aria-selected={filter === f.id}
                      className={`posts-tab-filter-item ${filter === f.id ? 'posts-tab-filter-item--active' : ''}`}
                      onClick={() => {
                        handleFilterChange(f.id);
                        setFilterOpen(false);
                      }}
                    >
                      {t(`notifications.filter_${f.id}`)}
                    </button>
                  ))}
                </div>,
                document.body
              )}
            </div>
          )}

          {notifications.length > 0 && (
            <Tooltip text={t('notifications.select_all')} placement="bottom">
              <button
                type="button"
                className="notifications-select-all-btn"
                onClick={handleSelectAll}
              >
                {t('notifications.select_all')}
              </button>
            </Tooltip>
          )}

          {unreadCount > 0 && !hasSelection && (
            <Tooltip text={t('notifications.mark_all_read')} placement="bottom">
              <button
                type="button"
                className="notifications-mark-all-btn"
                onClick={markAllAsRead}
              >
                {t('notifications.mark_all_read')}
              </button>
            </Tooltip>
          )}

          {hasSelection && (
            <span className="notifications-selected-count">
              {selectedIds.length === 1 ? t('notifications.selected_count', { n: selectedIds.length }) : t('notifications.selected_count_plural', { n: selectedIds.length })}
            </span>
          )}

          {hasSelection && (
            <Tooltip text={t('notifications.delete_selected', { n: selectedIds.length })} placement="bottom">
              <button
                type="button"
                className="notifications-delete-selected-btn"
                onClick={handleDeleteSelectedAction}
              >
                {t('notifications.delete_selected', { n: selectedIds.length })}
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {loading ? (
        <div className="notif-skeleton-list">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="notif-skeleton-item">
              <div className="skeleton skeleton--circle notif-skeleton-avatar" />
              <div className="notif-skeleton-content">
                <div className="skeleton notif-skeleton-line" />
                <div className="skeleton notif-skeleton-line notif-skeleton-line--short" />
              </div>
            </div>
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <div className="notifications-empty">
          <div className="notifications-empty-icon"><FaBell /></div>
          <p className="notifications-empty-text">
            {t('notifications.empty')}
          </p>
          <p className="notifications-empty-subtext">
            {t('notifications.empty_sub')}
          </p>
        </div>
      ) : filteredNotifications.length === 0 ? (
        <div className="notifications-empty">
          <div className="notifications-empty-icon"><FaBell /></div>
          <p className="notifications-empty-text">
            {t('notifications.filter_empty')}
          </p>
        </div>
      ) : (
        <div className="notifications-list">
          <VirtualPostList
            posts={filteredNotifications}
            getKey={(n) => n.id}
            estimateHeight={96}
            renderItem={(notif) => (
              <NotificationItem
                notification={notif}
                isSelected={selectedIds.includes(notif.id)}
                isDeleting={deletingIds.has(notif.id)}
                onSelect={() => handleSelectOne(notif.id)}
                onMarkAsRead={markAsRead}
                onDelete={() => handleDeleteOne(notif.id)}
                onAcceptRequest={handleAcceptRequest}
                onRejectRequest={handleRejectRequest}
              />
            )}
          />
        </div>
      )}
    </div>
  );
}

function NotificationItem({
  notification,
  isSelected,
  isDeleting,
  onSelect,
  onMarkAsRead,
  onDelete,
  onAcceptRequest,
  onRejectRequest,
}) {
  const { t, locale } = useI18n();
  const actor = notification.actor || {};
  const username = actor.username || '';
  const linkTo = getNotificationLink(notification);
  const postRef = notification.post;

  // Truncar contenido del post para preview
  const postPreview = postRef?.content
    ? postRef.content.length > 100
      ? postRef.content.substring(0, 100) + '...'
      : postRef.content
    : null;

  const handleClick = (e) => {
    // Solo evitar propagación para checkbox y delete; 
    // el markAsRead lo maneja el onClick del Link
    if (e.target.closest('.notification-checkbox-area') || e.target.closest('.notification-delete-btn')) {
      return;
    }
  };

  const isPostNotification = ['like', 'dislike', 'comment', 'repost', 'comment_like'].includes(notification.type);

  return (
    <div
      className={`notification-item ${!notification.is_read ? 'notification-item--unread' : ''} ${isSelected ? 'notification-item--selected' : ''} ${isDeleting ? 'notification-item--deleting' : ''}`}
      onClick={handleClick}
    >
      <div className="notification-checkbox-area" onClick={(e) => e.stopPropagation()}>
        <label className="notifications-checkbox-label">
          <input
            type="checkbox"
            className="notifications-checkbox"
            checked={isSelected}
            onChange={onSelect}
          />
        </label>
      </div>

      <div className="notification-type-icon">{getIcon(notification.type)}</div>

      <Link
        to={linkTo}
        className="notification-link"
        onClick={(e) => {
          if (!notification.is_read) {
            onMarkAsRead(notification.id);
          }
        }}
      >
        <Avatar
          className="notification-avatar"
          src={actor.avatar_url}
          alt={username}
        />

        <div className="notification-content">
          <p className="notification-message">
            {getNotificationMessage(t, notification.type, username)}
          </p>
          {/* Preview del contenido del post */}
          {isPostNotification && postPreview && (
            <p className="notification-post-preview">
              &ldquo;{postPreview}&rdquo;
            </p>
          )}
          <span className="notification-time">
            {timeAgo(t, locale, notification.created_at)}
          </span>
        </div>

        {!notification.is_read && (
          <span className="notification-dot" aria-label={t('notifications.unread')} />
        )}
      </Link>

      {/* ── Accept/Reject buttons for follow requests ── */}
      {notification.type === 'follow_request' && (
        <div className="notification-follow-actions">
          <Tooltip text={t('notifications.accept')} placement="bottom">
            <button
              type="button"
              className="notification-accept-btn"
              onClick={(e) => {
                e.stopPropagation();
                onAcceptRequest(notification, notification.actor_id);
              }}
            >
              <FaCheck />
            </button>
          </Tooltip>
          <Tooltip text={t('notifications.reject')} placement="bottom">
            <button
              type="button"
              className="notification-reject-btn"
              onClick={(e) => {
                e.stopPropagation();
                onRejectRequest(notification, notification.actor_id);
              }}
            >
              <FaTimes />
            </button>
          </Tooltip>
        </div>
      )}

      <Tooltip text={t('common.delete')} placement="bottom">
        <button
          type="button"
          className="notification-delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={t('notifications.delete_label')}
        >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>
      </Tooltip>
    </div>
  );
}
