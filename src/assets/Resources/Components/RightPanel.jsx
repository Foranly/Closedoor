import React, { useEffect, useState, useCallback } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { supabase } from '../../services/supabaseclient';
import { getUserProfile, getUserProfileByUsername, getCachedProfileByUsername, getCachedProfile, setCachedProfile, setCachedProfileByUsername } from '../../services/userService';
import { getTrendingHashtags, getTrendingWords, getCachedTrendingWords, getCachedTrendingHashtags, deduplicateTrending } from '../../services/hashtagService';
import { getTrendingCategory } from '../../services/trendingDictionary';
import ProfileSidebar from './ProfileSidebar';
import CommunitySidebar from './CommunitySidebar';
import { getContrastText, isUUID } from '../../services/helpers';
import useBgContrast from '../../../hooks/useBgContrast';
import { IconFire, IconHashtag, IconArrowRight } from './ShellIcons';
import './css/rightPanel.css';

const PROFILE_ROUTE = '/profile';
const PROFILE_ROUTE_PREFIX = '/profile/';

export default function RightPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const { user, profile: ownProfile } = useAuth();
  const path = location.pathname.toLowerCase();

  // ── Sin sesión o auth pages: hidden ──
  if (!user || path === '/login' || path === '/register') return null;

  // ── Community page: render community sidebar ──
  const isCommunityPage = path.startsWith('/c/');
  // Solo /profile toma la superficie del perfil (ver rightPanel.css).
  const isProfileRoute = path === PROFILE_ROUTE || path.startsWith(PROFILE_ROUTE_PREFIX);

  return (
    <aside className={`right-panel${isProfileRoute ? ' right-panel--profile' : ''}`}>
      {isCommunityPage ? (
        <CommunitySidebar />
      ) : (
        <ProfileContent path={path} ownProfile={ownProfile} user={user} t={t} />
      )}
    </aside>
  );
}

// ── Trending widget: dos secciones ──
const REFRESH_INTERVAL = 1000 * 60 * 5; // 5 min

// Cache en memoria del módulo: sobrevive a remounts del componente
// al navegar entre rutas (profile → home, chat → home, etc.)
let trendingMemoryCache = { words: null, hashtags: null };

function TrendingHashtags({ t, surfaceStyle }) {
  const [words, setWords] = useState(() => trendingMemoryCache.words ?? getCachedTrendingWords());
  const [hashtags, setHashtags] = useState(() => trendingMemoryCache.hashtags ?? getCachedTrendingHashtags());

  const fetchTrending = useCallback(() => {
    Promise.all([
      getTrendingWords(6).catch(() => []),
      getTrendingHashtags(6).catch(() => []),
    ]).then(([newWords, newHashtags]) => {
      // Deduplicar: remover de palabras las que ya aparecen como hashtags
      const deduped = deduplicateTrending(newWords, newHashtags);
      trendingMemoryCache.words = deduped;
      trendingMemoryCache.hashtags = newHashtags;
      setWords(deduped);
      setHashtags(newHashtags);
    });
  }, []);

  useEffect(() => {
    // Usar el cache en memoria primero (evita skeleton flash en remounts).
    // Si no hay datos en memoria ni en localStorage, hace fetch.
    const hasCache = (!!trendingMemoryCache.words && !!trendingMemoryCache.hashtags) ||
      (!!getCachedTrendingWords() && !!getCachedTrendingHashtags());
    if (!hasCache) {
      fetchTrending();
    }
    // El intervalo mantiene los datos frescos periódicamente
    const interval = setInterval(fetchTrending, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchTrending]);

  const isLoading = words === null || hashtags === null;
  const isEmpty = (!words?.length && !hashtags?.length);

  return (
    <div className="right-panel-card right-panel-card--noborder" style={surfaceStyle}>
      {isLoading ? (
        <div className="right-panel-trending-skeleton">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton right-panel-trending-pill" />
          ))}
        </div>
      ) : isEmpty ? (
        <p className="right-panel-placeholder">{t('right_panel.coming_soon')}</p>
      ) : (
        <>
          {/* ── Sección: Lo que se habla ── */}
          {words?.length > 0 && (
            <div className="right-panel-trending-section">
              <h4 className="right-panel-trending-subtitle">
                <IconFire className="right-panel-trending-subicon" />
                {t('right_panel.trending_words')}
              </h4>
              <div className="right-panel-trending-list">                  {words.slice(0, 3).map((item, i) => (
                  <Link
                    key={`word-${i}`}
                    to={`/hashtag/${encodeURIComponent(item.word)}?text=1`}
                    className="right-panel-trending-item"
                  >
                    <span className="right-panel-trending-category">{getTrendingCategory(item.word) || 'Varios'}</span>
                    <span className="right-panel-trending-item-row">
                      <span className="right-panel-trending-rank">#{i + 1}</span>
                      <span className="right-panel-trending-name">{item.word}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* ── Sección: Hashtags populares ── */}
          {hashtags?.length > 0 && (
            <div className="right-panel-trending-section">
              <h4 className="right-panel-trending-subtitle">
                <IconHashtag className="right-panel-trending-subicon" />
                {t('right_panel.trending_hashtags')}
              </h4>
              <div className="right-panel-trending-list">                  {hashtags.slice(0, 3).map((item, i) => (
                  <Link
                    key={`hash-${i}`}
                    to={`/hashtag/${encodeURIComponent(item.name)}`}
                    className="right-panel-trending-item"
                  >
                    <span className="right-panel-trending-category">{getTrendingCategory(item.name) || 'Varios'}</span>
                    <span className="right-panel-trending-item-row">
                      <span className="right-panel-trending-rank">#{i + 1}</span>
                      <span className="right-panel-trending-name">{item.name}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* ── Link a todas las tendencias ── */}
          <Link to="/Trending" className="right-panel-trending-all">
            <IconArrowRight className="right-panel-trending-all-icon" />
            {t('right_panel.view_all') || 'Ver todas las tendencias'}
          </Link>
        </>
      )}
    </div>
  );
}

// ── Subcomponente que maneja la carga del perfil ──
function ProfileContent({ path, ownProfile, user, t }) {
  const isOwnProfilePage = path === PROFILE_ROUTE;
  const isOtherProfilePage = path.startsWith(PROFILE_ROUTE_PREFIX) && path.length > PROFILE_ROUTE_PREFIX.length;
  const isHomePage = path === '/';

  const [viewedProfile, setViewedProfile] = useState(() => {
    if (!isOtherProfilePage) return null;
    const username = path.replace(PROFILE_ROUTE_PREFIX, '');
    if (isUUID(username)) return getCachedProfile(username);
    return getCachedProfileByUsername(username);
  });
  const [loading, setLoading] = useState(() => {
    if (!isOtherProfilePage) return false;
    const username = path.replace(PROFILE_ROUTE_PREFIX, '');
    if (isUUID(username)) return !getCachedProfile(username);
    return !getCachedProfileByUsername(username);
  });

  useEffect(() => {
    if (!isOtherProfilePage) {
      setViewedProfile(null);
      setLoading(false);
      return;
    }

    const username = path.replace(PROFILE_ROUTE_PREFIX, '');
    if (!username) {
      setViewedProfile(null);
      setLoading(false);
      return;
    }

    // Si hay cache, mostrar inmediatamente (el refresh en background se hace desde profile.jsx)
    const hasCache = isUUID(username)
      ? getCachedProfile(username)
      : getCachedProfileByUsername(username);
    if (hasCache) {
      setViewedProfile(hasCache);
      setLoading(false);
      return;
    }

    setLoading(true);

    const fetchFn = isUUID(username)
      ? getUserProfile(username)
      : getUserProfileByUsername(username);

    fetchFn
      .then((profile) => setViewedProfile(profile))
      .catch(() => setViewedProfile(null))
      .finally(() => setLoading(false));
  }, [path, isOtherProfilePage, isUUID]);

  // ── Live: mantener el perfil del sidebar al día mientras siga abierto ──
  // El efecto de arriba solo corre al cambiar de ruta (o una vez por cache miss),
  // así que la ActivityCard de ProfileSidebar se quedaba con la actividad del
  // primer render y el estado de conexión congelado hasta recargar. Aquí se
  // escucha la fila del perfil y se mezcla lo que llega (activity,
  // activity_updated_at, program_activity, user_status, user_status_updated_at…).
  useEffect(() => {
    const id = viewedProfile?.id;
    if (!isOtherProfilePage || !id) return undefined;

    const channel = supabase
      .channel(`right-panel-profile-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${id}` }, (payload) => {
        const updated = payload.new;
        if (!updated?.id) return;
        // El payload de Realtime trae la fila completa; email no debe acabar en
        // el cache local del visitante (misma política que PROFILE_PUBLIC_COLUMNS).
        const safe = { ...updated };
        delete safe.email;
        setViewedProfile((prev) => (prev && prev.id === safe.id ? { ...prev, ...safe } : prev));
        setCachedProfile(safe);
        if (safe.username) setCachedProfileByUsername(safe.username, safe);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isOtherProfilePage, viewedProfile?.id]);

  const { showAccent, accentVisibility, showInterests, showProfileStats } = useI18n();

  // ── Extract bg URL early for useBgContrast (must be before any early returns) ──
  const bgUrlRight = (isOwnProfilePage ? ownProfile : viewedProfile)?.profile_background_url;
  const autoBgContrastColor = useBgContrast(bgUrlRight);

  // ── Home page y otras rutas no-perfil: trending siempre visible ──
  if (isHomePage || (!isOwnProfilePage && !isOtherProfilePage)) {
    return <TrendingHashtags t={t} />;
  }

  // ── Profile page ──
  const activeProfile = isOwnProfilePage ? ownProfile : viewedProfile;
  const isPrivate = activeProfile?.is_private === true;
  const statsPrivate = activeProfile?.stats_private === true;
  // statsVisibility directo desde el perfil (puede ser null = legacy)
  // El control individual se maneja en ProfileSidebar, y el toggle general
  // en Settings sincroniza stats_visibility automáticamente.
  const resolvedStatsVisibility = activeProfile?.stats_visibility ?? null;

  if (loading) {
    return (
      <div className="right-panel-card">
        <div className="skeleton right-panel-skeleton-title" />
        <div className="skeleton right-panel-skeleton-pill" style={{ width: '70%' }} />
        <div className="skeleton right-panel-skeleton-pill" style={{ width: '50%' }} />
        <div className="skeleton right-panel-skeleton-pill" style={{ width: '60%' }} />
      </div>
    );
  }

  if (!activeProfile) return null;

  const surfColor = activeProfile?.accent_surface_color;
  const surfGlass = activeProfile?.accent_surface_glass === true;
  const hasBgRight = !!activeProfile?.profile_background_url;
  const isOwnProfileRight = isOwnProfilePage;

  // Para perfiles ajenos: usar las preferencias guardadas en la BD del dueño del perfil
  // Para perfil propio: siempre mostrar (el toggle es para controlar qué ven los demás)
  const ownerShowAccentProfile = isOwnProfileRight
    ? true
    : (activeProfile?.show_accent_profile ?? true);
  const ownerAccentVisibility = isOwnProfileRight
    ? accentVisibility
    : (activeProfile?.accent_visibility ?? 'both');

  // Preferencias de visibilidad de cards:
  // - Perfil propio: usa la preferencia local (lo que el usuario configuró)
  // - Perfiles ajenos: usa la preferencia del DUEÑO del perfil (de Supabase)
  //   La preferencia local NO afecta lo que ves en perfiles ajenos
  const ownerShowInterests = isOwnProfileRight
    ? showInterests
    : (activeProfile?.show_interests ?? true);
  const ownerShowStats = isOwnProfileRight
    ? showProfileStats
    : (activeProfile?.show_profile_stats ?? true);

  const accentVisibleRight = showAccent && ownerShowAccentProfile && (
    ownerAccentVisibility === 'both' ||
    (ownerAccentVisibility === 'me' && isOwnProfileRight) ||
    (ownerAccentVisibility === 'others' && !isOwnProfileRight)
  );
  const surfaceStyle = accentVisibleRight ? {
    '--accent-surface-rgba': surfGlass ? 'rgba(255, 255, 255, 0.04)' : (surfColor || 'var(--color-surface, #1a1a1a)'),
    '--accent-surface-rgba-hover': surfGlass ? 'rgba(255, 255, 255, 0.07)' : (surfColor ? `color-mix(in srgb, ${surfColor} 85%, #000)` : 'var(--color-surface-hover, #252525)'),
    '--accent-surface-blur': surfGlass ? 'blur(20px)' : 'none',
    '--accent-surface-border': 'none',
    // ── Glass mode text contrast: auto-detect from background image ──
    '--accent-surface-text-color': activeProfile?.profile_text_color
      ? activeProfile.profile_text_color
      : 'var(--color-text, #ffffff)',
    '--accent-surface-text-secondary': activeProfile?.profile_text_color
      ? activeProfile.profile_text_color
      : 'var(--color-text-secondary, #9ca3af)',
    '--accent-surface-text-muted': activeProfile?.profile_text_color
      ? activeProfile.profile_text_color
      : 'var(--color-text-muted, #6b7280)',
    // ── When text is dark (light bg detected), use dark overlays so pills/buttons are visible ──
    ...((!surfGlass && surfColor ? getContrastText(surfColor) : hasBgRight ? autoBgContrastColor : null) === '#111111' ? {
      '--overlay-bg-subtle': 'rgba(0, 0, 0, 0.06)',
      '--overlay-bg-hover': 'rgba(0, 0, 0, 0.12)',
      '--overlay-bg-active': 'rgba(0, 0, 0, 0.16)',
      '--overlay-bg': 'rgba(0, 0, 0, 0.08)',
    } : {}),
  } : {};

  // Derive CSS vars from accent-surface-text-* for the containers
  // IMPORTANT: Only set --color-text-* when the accent value is a CONCRETE color,
  // NOT a CSS variable reference (starts with 'var('). Setting a var reference
  // creates a circular dependency: child resolves --color-text-muted → finds it on
  // parent with value 'var(--color-text-muted, #6b7280)' → tries to resolve it on
  // same element → circular → fallback to #6b7280. The override never takes effect.
  const isConcrete = (v) => typeof v === 'string' && !v.startsWith('var(');
  const resolvedSurfaceStyle = Object.keys(surfaceStyle).length > 0 ? {
    ...surfaceStyle,
    ...(isConcrete(surfaceStyle['--accent-surface-text-color'])
      ? { '--color-text': surfaceStyle['--accent-surface-text-color'] } : {}),
    ...(isConcrete(surfaceStyle['--accent-surface-text-secondary'])
      ? { '--color-text-secondary': surfaceStyle['--accent-surface-text-secondary'] } : {}),
    ...(isConcrete(surfaceStyle['--accent-surface-text-muted'])
      ? { '--color-text-muted': surfaceStyle['--accent-surface-text-muted'] } : {}),
  } : {};

  return (
    <>
      <ProfileSidebar
        profile={activeProfile}
        isPrivate={isPrivate}
        canViewContent={isOwnProfilePage || !isPrivate}
        statsVisibility={resolvedStatsVisibility}
        isOwnProfile={isOwnProfilePage}
        showInterests={ownerShowInterests}
        showStats={ownerShowStats}
        surfaceStyle={resolvedSurfaceStyle}
      />
    </>
  );
}
