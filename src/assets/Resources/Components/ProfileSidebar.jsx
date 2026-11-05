import React, { useEffect, useState } from 'react';
import { FaLock, FaHeart, FaHeartBroken, FaComment, FaRetweet, FaTags, FaFeather, FaBookmark, FaEye, FaUser, FaBan } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { supabase, dbPublic } from '../../services/supabaseclient';
import { useAuth } from '../../../hooks/useAuth';
import { getCachedBlockStatus, subscribeBlockChanges } from '../../services/blockService';
import { getItem, setItem, removeItem } from '../../services/secureStorage';
import SongCard from './SongCard';
import ActivityCard from './ActivityCard';
import './css/profileSidebar.css';
import { IoStatsChart } from "react-icons/io5";

// ── Stats cache ──
const STATS_CACHE_PREFIX = 'fc_stats_';
const STATS_CACHE_TTL = 1000 * 60 * 5; // 5 minutos

function getCachedStats(profileId) {
  try {
    const payload = getItem(STATS_CACHE_PREFIX + profileId);
    if (!payload?.ts) return null;
    if (Date.now() - payload.ts > STATS_CACHE_TTL) {
      removeItem(STATS_CACHE_PREFIX + profileId);
      return null;
    }
    return payload.stats;
  } catch {
    return null;
  }
}

function setCachedStats(profileId, stats) {
  try {
    const payload = { ts: Date.now(), stats };
    setItem(STATS_CACHE_PREFIX + profileId, payload);
  } catch {
    /* ignore */
  }
}

export default function ProfileSidebar({ profile, isPrivate, canViewContent, statsVisibility, isOwnProfile, surfaceStyle, showStats = true }) {
  const showInterests = true;
  const { t } = useI18n();
  const { user } = useAuth();
  const isBlockedByMe = user?.id && profile?.id && !isOwnProfile
    ? getCachedBlockStatus(user.id, profile.id) ?? false
    : false;
  const isBlockedByThem = user?.id && profile?.id && !isOwnProfile
    ? getCachedBlockStatus(profile.id, user.id) ?? false
    : false;
  const isBlocked = isBlockedByMe || isBlockedByThem;
  // ── Forzar re-render cuando cambia el estado de bloqueo (cacheBlockStatus() se llamó en otro componente) ──
  const [blockRevision, setBlockRevision] = useState(0);
  useEffect(() => {
    return subscribeBlockChanges(() => setBlockRevision(v => v + 1));
  }, []);

  const [expanded, setExpanded] = useState(false);
  const [stats, setStats] = useState(() => {
    if (!profile?.id) return null;
    // Perfil ajeno: cargar stats solo si hay al menos una visible
    if (!isOwnProfile) {
      // null = legacy (stats_private controlaba): cargar siempre
      const hasAnyVisible = statsVisibility == null || Object.values(statsVisibility).some(v => v === true);
      if (!hasAnyVisible) return null;
    }
    return getCachedStats(profile.id);
  });
  const interests = profile?.interests || [];
  const visibleInterests = expanded ? interests : interests.slice(0, 8);
  const hasMore = interests.length > 8;

  // ── Reset stats cuando cambia el perfil (navegación entre perfiles) ──
  useEffect(() => {
    if (profile?.id) {
      setStats(getCachedStats(profile.id));
    }
  }, [profile?.id]);

  // ── Fetch aggregated stats (cache-first, background-refresh) ──
  useEffect(() => {
    if (!profile?.id) return;

    const fetchStats = async () => {
      if (!isOwnProfile) {
        // null = legacy: cargar siempre (stats_private controlaba)
        // Objeto: cargar solo si al menos una stat es visible
        const hasAnyVisible = statsVisibility == null || Object.values(statsVisibility).some(v => v === true);
        if (!hasAnyVisible) {
          setStats(null);
          return;
        }
      }

      try {
        const { data: posts } = await dbPublic
          .from('posts')
          .select('id, likes_count, dislikes_count, comments_count, reposts_count, views_count')
          .neq('is_encrypted', true)
          .eq('user_id', profile.id);

        if (posts) {
          const total = posts.reduce(
            (acc, p) => ({
              posts: acc.posts + 1,
              likes: acc.likes + (p.likes_count || 0),
              dislikes: acc.dislikes + (p.dislikes_count || 0),
              comments: acc.comments + (p.comments_count || 0),
              reposts: acc.reposts + (p.reposts_count || 0),
              views: acc.views + (p.views_count || 0),
            }),
            { posts: 0, likes: 0, dislikes: 0, comments: 0, reposts: 0, views: 0 }
          );

          // Contar saves totales en los posts de este perfil
          const postIds = posts.map(p => p.id);
          let saves = 0;
          if (postIds.length > 0) {
            const { count } = await supabase
              .from('saved_posts')
              .select('id', { count: 'exact', head: true })
              .in('post_id', postIds);
            saves = count || 0;
          }

          // Obtener vistas del perfil (resiliente a columna faltante)
          let profileViews = 0;
          try {
            const { data: profileData } = await dbPublic
              .from('profiles')
              .select('profile_views_count')
              .eq('id', profile.id)
              .single();
            if (profileData) {
              profileViews = profileData.profile_views_count || 0;
            }
          } catch (e) {
            console.warn('profile_views_count not available:', e?.message || e);
          }

          setStats({ ...total, saves, profileViews });
          setCachedStats(profile.id, { ...total, saves, profileViews });
        }
      } catch (err) {
        console.warn('Error fetching profile stats:', err);
      }
    };

    fetchStats();

    // ── Realtime unificado: refrescar stats al cambiar posts o saves ──
    const channel = supabase
      .channel(`profile-sidebar-stats-${profile.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts', filter: `user_id=eq.${profile.id}` }, () => fetchStats())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts', filter: `user_id=eq.${profile.id}` }, () => fetchStats())
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts', filter: `user_id=eq.${profile.id}` }, () => fetchStats())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'saved_posts' }, () => fetchStats())
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'saved_posts' }, () => fetchStats())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile?.id, isOwnProfile]);

  // Las cards de intereses siempre se muestran (ya no se puede ocultar)
  // El sidebar solo se oculta si no hay perfil
  if (!profile) return null;

  // Determinar si todas las stats están intencionalmente ocultas
  // (statsVisibility es un objeto no-null sin ninguna stat en true)
  const isStatsHidden = !isOwnProfile && statsVisibility != null && !Object.values(statsVisibility).some(v => v === true);

  // Determinar si una estadística es visible
  function isStatVisible(statKey) {
    // statsVisibility = null: legacy (stats_private controlaba), mostrar todas
    if (statsVisibility == null) return true;
    // statsVisibility = {}: todas ocultas
    // statsVisibility = {likes: true}: solo likes visible
    // Si la key no está definida (stats agregadas después), mostrar por defecto
    if (statsVisibility[statKey] === undefined) return true;
    // Si el usuario explícitamente ocultó esta stat, ocultarla incluso en su propio perfil
    if (statsVisibility[statKey] === false) return false;
    // Perfil propio: visible si no se ocultó explícitamente
    if (isOwnProfile) return true;
    return statsVisibility[statKey] === true;
  }

  function renderStat(statKey, Icon, iconClass, value, label) {
    if (!isStatVisible(statKey)) return null;
    return (
      <div className="profile-sidebar-stat" key={statKey}>
        <Icon className={`profile-sidebar-stat-icon ${iconClass}`} />
        <span className="profile-sidebar-stat-value">{value}</span>
        <span className="profile-sidebar-stat-label">{label}</span>
      </div>
    );
  }

  return (
    <aside className="profile-sidebar">
      {/* ── Mi canción (arriba de intereses) ── */}
      {!isBlocked && (isOwnProfile || canViewContent) && (
        <SongCard
          song={profile?.song || null}
          isOwnProfile={isOwnProfile}
          surfaceStyle={surfaceStyle}
          owner={profile || null}
        />
      )}

      {/* ── Actividad ahora ──*/}
      {!isBlocked && (isOwnProfile || canViewContent) && (
        <ActivityCard
          profile={profile}
          isOwnProfile={isOwnProfile}
          surfaceStyle={surfaceStyle}
        />
      )}

      {/* ── Interests (siempre visible) ── */}
      <div className="profile-sidebar-card" style={surfaceStyle}>
        <h3 className="profile-sidebar-title">
          <FaTags className="profile-sidebar-title-icon" />
          {t('profile.interests')}
        </h3>

        {isBlocked ? (
          <div className="profile-sidebar-private">
            <FaBan className="profile-sidebar-private-icon" />
            <span>{t('block.interests_hidden')}</span>
          </div>
        ) : !canViewContent && !isOwnProfile ? (
          <div className="profile-sidebar-private">
            <FaLock className="profile-sidebar-private-icon" />
            <span>{t('profile.private_interests_hidden')}</span>
          </div>
        ) : interests.length === 0 ? (
          <p className="profile-sidebar-empty">
            {isOwnProfile ? t('profile.no_interests_own') : t('profile.no_interests_other')}
          </p>
        ) : (
          <>
            <div className="profile-sidebar-interests">
              {visibleInterests.map((interest, i) => (
                <span key={i} className="profile-sidebar-interest-pill">
                  {interest}
                </span>
              ))}
            </div>
            {hasMore && (
              <button
                type="button"
                className="profile-sidebar-expand-btn"
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? t('profile.show_less') : t('profile.show_more', { count: interests.length - 8 })}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Stats ── */}
      {showStats && (
        <div className="profile-sidebar-card" style={surfaceStyle}>
        <h3 className="profile-sidebar-title">
          <IoStatsChart className="profile-sidebar-title-icon" />
          {t('profile.stats_title')}</h3>
        {isBlocked ? (
          <div className="profile-sidebar-private">
            <FaBan className="profile-sidebar-private-icon" />
            <span>{t('block.stats_hidden')}</span>
          </div>
        ) : isStatsHidden ? (
          <div className="profile-sidebar-private">
            <FaLock className="profile-sidebar-private-icon" />
            <span>{t('profile.stats_private_label')}</span>
          </div>
        ) : !stats ? (
          <div className="profile-sidebar-stats-skeleton">
            <div className="skeleton profile-sidebar-skeleton-row" />
            <div className="skeleton profile-sidebar-skeleton-row" />
            <div className="skeleton profile-sidebar-skeleton-row" />
            <div className="skeleton profile-sidebar-skeleton-row" />
          </div>
        ) : (
          <div className="profile-sidebar-stats">
            {renderStat('posts', FaFeather, 'profile-sidebar-stat-icon--posts', stats.posts, t('profile.posts_tab'))}
            {renderStat('likes', FaHeart, 'profile-sidebar-stat-icon--likes', stats.likes, t('profile.stats_likes'))}
            {renderStat('dislikes', FaHeartBroken, 'profile-sidebar-stat-icon--dislikes', stats.dislikes, t('profile.stats_dislikes'))}
            {renderStat('comments', FaComment, 'profile-sidebar-stat-icon--comments', stats.comments, t('profile.stats_comments'))}
            {renderStat('reposts', FaRetweet, 'profile-sidebar-stat-icon--reposts', stats.reposts, t('profile.stats_reposts'))}
            {renderStat('views', FaEye, 'profile-sidebar-stat-icon--views', stats.views, t('profile.stats_views'))}
            {renderStat('profileViews', FaUser, 'profile-sidebar-stat-icon--profile-views', stats.profileViews, t('profile.stats_profile_views'))}
            {renderStat('saves', FaBookmark, 'profile-sidebar-stat-icon--saves', stats.saves, t('profile.stats_saved'))}
          </div>
        )}
      </div>
      )}
    </aside>
  );
}
