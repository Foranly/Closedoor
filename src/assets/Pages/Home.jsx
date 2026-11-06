import { Link } from 'react-router-dom';
import { useState, useEffect, useCallback, useRef } from 'react';
import { IconNewspaper } from '../Resources/Components/ShellIcons';
import { useI18n } from '../services/i18n/useI18n';
import '../Resources/Styles/Home.css';
import '../Resources/Styles/post.css';
import '../Resources/Styles/skeleton.css';
import { useAuth } from '../../hooks/useAuth';
import usePageTitle from '../../hooks/usePageTitle';
import { supabase, dbPublic } from '../services/supabaseclient';
import { getBlockedUserIds, getUsersWhoBlockedMeIds, clearBlockedListsCache, subscribeBlockChanges } from '../services/blockService';
import {
  getFeed,
  getLikedPostIds,
  getRepostedPostIds,
  getSavedPostIds,
  getDislikedPostIds,
  setCachedFeed,
  getCachedFeed,
  clearFeedCache,
  getScheduledPosts,
} from '../services/postService';
import { getFollowing } from '../services/followService';
import { rankFeedForUser } from '../services/feedRanking';
import VirtualPostList from '../Resources/Components/VirtualPostList';
import CreatePostModal from '../Resources/Components/CreatePostModal';
import FloatingActionButton from '../Resources/Components/FloatingActionButton';

// Lote acotado por petición: suficiente para el ranking y la virtualización,
// sin traer todo el histórico (respeta recursos de servidor).
const FEED_LIMIT = 150;

function Home() {
    const { t } = useI18n();
    usePageTitle(t('home.title'));
    const { user, isAuthenticated, profile } = useAuth();

    // 'for_you' (algoritmo de relevancia) | 'following' (solo seguidos)
    const [tab, setTab] = useState('for_you');

    const [posts, setPosts] = useState(() => {
        const cached = getCachedFeed('home_feed');
        return cached?.items || [];
    });
    const [likedPostIds, setLikedPostIds] = useState(() => {
        const cached = getCachedFeed('home_feed');
        return cached?.likedIds || [];
    });
    const [repostedPostIds, setRepostedPostIds] = useState(() => {
        const cached = getCachedFeed('home_feed');
        return cached?.repostedIds || [];
    });
    const [savedPostIds, setSavedPostIds] = useState(() => {
        const cached = getCachedFeed('home_feed');
        return cached?.savedIds || [];
    });
    const [dislikedPostIds, setDislikedPostIds] = useState(() => {
        const cached = getCachedFeed('home_feed');
        return cached?.dislikedIds || [];
    });
    const [postsLoading, setPostsLoading] = useState(() => {
        return !getCachedFeed('home_feed');
    });
    const [showCreatePost, setShowCreatePost] = useState(false);
    const [editingPost, setEditingPost] = useState(null);

    // Cambia cuando se crea un post: re-arma el timer de posts programados.
    const [schedTick, setSchedTick] = useState(0);

    // Lista de seguidos (para el tab "Siguiendo" y el filtro realtime)
    const [followingIds, setFollowingIds] = useState([]);
    const followingIdsRef = useRef(followingIds);
    useEffect(() => { followingIdsRef.current = followingIds; }, [followingIds]);
    // Tab activo visible para el listener realtime (no re-suscribir por tab)
    const tabRef = useRef(tab);
    useEffect(() => { tabRef.current = tab; }, [tab]);

    const cacheKeyFor = (whichTab) =>
        whichTab === 'following' ? 'home_feed_following' : 'home_feed';

    // Dep estable para el ranking: el objeto profile de AuthContext se actualiza
    // por realtime (status, etc.) y su referencia a interests cambia; si usáramos
    // profile?.interests directo, el callback se recrearía y refetchearía el feed.
    const interestsKey = JSON.stringify(profile?.interests || []);

    // ── Carga el feed del tab indicado (con cache, ranking y filtros) ──
    const loadFeedForTab = useCallback(async (whichTab) => {
        const key = cacheKeyFor(whichTab);
        try {
            let data = [];
            if (whichTab === 'following') {
                if (!user?.id) {
                    setPosts([]);
                    setPostsLoading(false);
                    return;
                }
                const following = await getFollowing(user.id);
                const ids = (following || []).map((f) => f.id);
                setFollowingIds(ids);
                // El tab "Siguiendo" también muestra los posts propios: se añade
                // el propio id a authorIds. followingIds queda igual (solo se usa
                // para el filtro realtime de autores ajenos).
                const authorIds = ids.includes(user.id) ? ids : [...ids, user.id];
                if (authorIds.length > 0) {
                    data = await getFeed({ limit: FEED_LIMIT, userId: user?.id, authorIds });
                }
            } else {
                data = await getFeed({ limit: FEED_LIMIT, userId: user?.id });
                // Algoritmo "Para ti": puntúa por intereses del autor, hashtags y engagement
                data = rankFeedForUser(data, profile?.interests || []);
            }

            // Filtrar posts de usuarios bloqueados (ambas direcciones, con cache 5min)
            if (user?.id && data.length > 0) {
                try {
                    const [blockedIds, blockedMeIds] = await Promise.all([
                        getBlockedUserIds(user.id),
                        getUsersWhoBlockedMeIds(user.id),
                    ]);
                    const excludedIds = new Set([...blockedIds, ...blockedMeIds]);
                    data = data.filter(p => !excludedIds.has(p.user_id));
                } catch (e) {
                    console.warn('Could not filter blocked posts:', e);
                }
            }
            // Guard anti-race: si el usuario cambió de tab mientras se resolvía
            // el fetch, descartar este resultado (un fetch lento del tab anterior
            // no debe pisar el feed del tab activo).
            if (tabRef.current !== whichTab) return;

            setPosts(data);

            let likedIds = [], repostedIds = [], savedIds = [], dislikedIds = [];
            if (user?.id && data.length > 0) {
                const postIds = data.map((p) => p.id);
                [likedIds, repostedIds, savedIds, dislikedIds] = await Promise.all([
                    getLikedPostIds(postIds, user.id),
                    getRepostedPostIds(postIds, user.id),
                    getSavedPostIds(postIds, user.id),
                    getDislikedPostIds(postIds, user.id),
                ]);
                setLikedPostIds(likedIds);
                setRepostedPostIds(repostedIds);
                setSavedPostIds(savedIds);
                setDislikedPostIds(dislikedIds);
            }
            setCachedFeed(key, data, likedIds, repostedIds, savedIds, dislikedIds);
        } catch (err) {
            console.error('Error loading feed:', err);
        } finally {
            // No apagar el skeleton si este fetch es de un tab que ya no está activo
            if (tabRef.current === whichTab) setPostsLoading(false);
        }
    }, [user?.id, interestsKey]);

    // ── Load feed (con cache, refresca al cambiar tab) ──
    useEffect(() => {
        const key = cacheKeyFor(tab);
        const cached = getCachedFeed(key);
        if (cached) {
            setPosts(cached.items || []);
            setLikedPostIds(cached.likedIds || []);
            setRepostedPostIds(cached.repostedIds || []);
            setSavedPostIds(cached.savedIds || []);
            setDislikedPostIds(cached.dislikedIds || []);
            setPostsLoading(false);
        }
        setPostsLoading(!getCachedFeed(key));
        loadFeedForTab(tab);
    }, [tab, loadFeedForTab]);

    // ── Realtime: actualizar contadores + insertar nuevos posts en vivo ──
    useEffect(() => {
        const channel = supabase
            .channel('home-feed-updates')
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'posts' },
                (payload) => {
                    const updated = payload.new;
                    setPosts((prev) =>
                        prev.map((p) =>
                            p.id === updated.id
                                ? { ...p, likes_count: updated.likes_count, dislikes_count: updated.dislikes_count, reposts_count: updated.reposts_count, comments_count: updated.comments_count, views_count: updated.views_count }
                                : p
                        )
                    );
                }
            )
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'posts' },
                async (payload) => {
                    // Ignorar posts propios (ya los agrega handlePostCreated)
                    const newPost = payload.new;
                    if (newPost.user_id === user?.id) return;

                    // Ignorar posts programados (scheduled_at en futuro)
                    if (newPost.scheduled_at && new Date(newPost.scheduled_at) > new Date()) return;

                    // Ignorar posts encriptados: invisibles en feeds (solo perfil/notificación)
                    if (newPost.is_encrypted) return;

                    // En tab "Siguiendo", solo autores que sigo
                    if (tabRef.current === 'following' && !followingIdsRef.current.includes(newPost.user_id)) return;

                    try {
                        // Fetch post completo con perfil del autor
                        const { data, error } = await dbPublic
                            .from('posts')
                            .select('*, profiles!posts_user_id_fkey (id, username, displayname, avatar_url, roles, is_private, avatar_position, interests)')
                            .eq('id', newPost.id)
                            .single();

                        if (error || !data) return;

                        // Normalizar URLs del CDN (imagenes, avatar)
                        const { getCdnUrl } = await import('../services/cdnService');
                        if (data.image_url) data.image_url = getCdnUrl(data.image_url);
                        if (Array.isArray(data.image_urls)) {
                            data.image_urls = data.image_urls.map(u => getCdnUrl(u));
                        }
                        if (data.profiles?.avatar_url) {
                            data.profiles.avatar_url = getCdnUrl(data.profiles.avatar_url);
                        }

                        // Verificar si el autor está bloqueado
                        if (user?.id) {
                            const [blockedIds, blockedMeIds] = await Promise.all([
                                getBlockedUserIds(user.id).catch(() => []),
                                getUsersWhoBlockedMeIds(user.id).catch(() => []),
                            ]);
                            const excludedIds = new Set([...blockedIds, ...blockedMeIds]);
                            if (excludedIds.has(data.user_id)) return;
                        }

                        setPosts((prev) => {
                            // Evitar duplicados (si ya está en el feed)
                            if (prev.some((p) => p.id === data.id)) return prev;
                            // Insertar al inicio
                            return [data, ...prev];
                        });
                    } catch (err) {
                        // Silencioso — Realtime no debe romper la UI
                    }
                }
            )
            .subscribe();

        return () => { supabase.removeChannel(channel); };
    }, [user?.id]);

    // ── Re-filtrar posts cuando cambia el estado de bloqueo ──
    useEffect(() => {
      if (!user?.id) return;
      const unsub = subscribeBlockChanges(async () => {
        try {
          // Limpiar cache para forzar fetch fresco (el cache es para navegacion, no para Realtime)
          clearBlockedListsCache(user.id);
          const [blockedIds, blockedMeIds] = await Promise.all([
            getBlockedUserIds(user.id),
            getUsersWhoBlockedMeIds(user.id),
          ]);
          const excludedIds = new Set([...blockedIds, ...blockedMeIds]);
          setPosts((prev) => prev.filter(p => !excludedIds.has(p.user_id)));
        } catch (e) {
          console.warn('Could not re-filter blocked posts:', e);
        }
      });
      return unsub;
    }, [user?.id]);

    const handlePostCreated = useCallback(() => {
        loadFeedForTab(tab);
        // Un post recién programado cambia el próximo vencimiento a vigilar.
        setSchedTick((n) => n + 1);
    }, [loadFeedForTab, tab]);

    // ── Posts programados que se publican (no hay evento de DB) ──
    // El post se vuelve visible cuando su scheduled_at ya pasó (los feeds filtran
    // por fecha), pero la fila no cambia y no llega nada por Realtime. Se arma un
    // timer para el siguiente post programado propio y, al vencer, se recarga el
    // feed activo para que aparezca en su tab sin refrescar la página.
    useEffect(() => {
        if (!user?.id) return;
        let cancelled = false;
        let timer;
        const MAX_DELAY = 24 * 60 * 60 * 1000;

        const armTimer = async () => {
            const items = await getScheduledPosts(user.id).catch(() => []);
            if (cancelled || !items?.length) return;
            const nextTs = items
                .map((p) => new Date(p.scheduled_at).getTime())
                .filter((ts) => Number.isFinite(ts))
                .sort((a, b) => a - b)[0];
            if (!nextTs) return;
            const delay = nextTs - Date.now();
            timer = setTimeout(() => {
                if (cancelled) return;
                if (delay > MAX_DELAY) {
                    // Espera más larga que el máximo de setTimeout: re-armar.
                    armTimer();
                    return;
                }
                loadFeedForTab(tabRef.current);
                armTimer();
            }, Math.max(0, Math.min(delay, MAX_DELAY)));
        };

        armTimer();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [user?.id, loadFeedForTab, schedTick]);

    const handlePostUpdate = useCallback((updatedPost) => {
        if (updatedPost._editing) {
            setEditingPost(updatedPost);
            setShowCreatePost(true);
            return;
        }
        setPosts((prev) =>
            prev.map((p) => (p.id === updatedPost.id ? { ...p, ...updatedPost } : p))
        );
    }, []);

    const handleLikeToggle = useCallback((postId, nowLiked) => {
        setLikedPostIds((prev) =>
            nowLiked ? [...prev, postId] : prev.filter((id) => id !== postId)
        );
    }, []);

    const handleSaveToggle = useCallback((postId, nowSaved) => {
        setSavedPostIds((prev) =>
            nowSaved ? [...prev, postId] : prev.filter((id) => id !== postId)
        );
    }, []);

    const handleRepostToggle = useCallback((postId, nowReposted) => {
        setRepostedPostIds((prev) =>
            nowReposted ? [...prev, postId] : prev.filter((id) => id !== postId)
        );
    }, []);

    const handleDislikeToggle = useCallback((postId, nowDisliked) => {
        setDislikedPostIds((prev) =>
            nowDisliked ? [...prev, postId] : prev.filter((id) => id !== postId)
        );
    }, []);

    const handlePostDelete = useCallback((postId) => {
        setPosts((prev) => prev.filter((p) => p.id !== postId));
    }, []);

    // ── Handle blocking a user: remove their posts from feed + clear cache ──
    const handleBlockUser = useCallback((blockedUserId) => {
        if (!blockedUserId) return;
        setPosts((prev) => prev.filter((p) => p.user_id !== blockedUserId));
        clearFeedCache('home_feed');
        clearFeedCache('home_feed_following');
    }, []);

    return (
        <div className="home-page">
            {!isAuthenticated ? (
                <div className="home-hero">
                    <h1 className="home-hero-title">{t('home.hero_title')}</h1>
                    <p className="home-hero-subtitle">
                        {t('home.hero_subtitle')}
                    </p>
                    <p className="home-hero-subtitle">
                        {t('home.hero_subtitle2')}
                    </p>
                    <div className="home-hero-actions">
                        <Link to="/Register" className="home-hero-btn home-hero-btn--primary">
                            {t('auth.register_btn')}
                        </Link>
                        <Link to="/Login" className="home-hero-btn home-hero-btn--secondary">
                            {t('auth.login_btn')}
                        </Link>
                    </div>
                </div>
            ) : (
                <div className="posts-section posts-section--home">
                    <div className="posts-section-header">
                        <div className="posts-section-tabs">
                            <button
                                className={`posts-section-tab ${tab === 'for_you' ? 'posts-section-tab--active' : ''}`}
                                onClick={() => setTab('for_you')}
                            >
                                {t('home.tab_for_you')}
                            </button>
                            <button
                                className={`posts-section-tab ${tab === 'following' ? 'posts-section-tab--active' : ''}`}
                                onClick={() => setTab('following')}
                            >
                                {t('home.tab_following')}
                            </button>
                        </div>
                        <button
                            className="posts-section-action"
                            onClick={() => setShowCreatePost(true)}
                        >
                            {t('home.new_post')}
                        </button>
                    </div>

                    {postsLoading ? (
                        <div className="posts-skeleton">
                            {[1, 2, 3, 4, 5].map((i) => (
                                <div key={i} className="posts-skeleton-card">
                                    <div className="skeleton posts-skeleton-avatar" />
                                    <div className="posts-skeleton-lines">
                                        <div className="posts-skeleton-line posts-skeleton-line--short" />
                                        <div className="posts-skeleton-line" />
                                        <div className="posts-skeleton-line posts-skeleton-line--medium" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : posts.length === 0 ? (
                        <div className="posts-empty">
                            <span className="posts-empty-icon"><IconNewspaper /></span>
                            <p className="posts-empty-text">
                                {tab === 'following'
                                    ? t('home.no_posts_following')
                                    : t('home.no_posts_first')}
                            </p>
                        </div>
                    ) : (
                        <VirtualPostList
                            posts={posts}
                            likedIds={likedPostIds}
                            dislikedIds={dislikedPostIds}
                            repostedIds={repostedPostIds}
                            savedIds={savedPostIds}
                            onUpdate={handlePostUpdate}
                            onDelete={handlePostDelete}
                            onSaveToggle={handleSaveToggle}
                            onLikeToggle={handleLikeToggle}
                            onDislikeToggle={handleDislikeToggle}
                            onRepostToggle={handleRepostToggle}
                            onBlockUser={handleBlockUser}
                        />
                    )}
                </div>
            )}

            {/* FAB for mobile */}
            {isAuthenticated && (
              <FloatingActionButton onClick={() => {
                setEditingPost(null);
                setShowCreatePost(true);
              }} />
            )}

            <CreatePostModal
                isOpen={showCreatePost}
                onClose={() => {
                    setShowCreatePost(false);
                    setEditingPost(null);
                }}
                onSuccess={handlePostCreated}
                editPost={editingPost}
                userId={user?.id}
            />
        </div>
    );
}

export default Home;
