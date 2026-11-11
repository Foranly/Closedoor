import React, { useEffect, useState, useRef, useMemo, useCallback, useContext } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { supabase } from "../services/supabaseclient";
import {
    updateUserProfile,
    updateAuthUserMetadata,
    isUsernameAvailable,
    getUserProfileByUsername,
    getUserProfile,
    setCachedProfile,
    setCachedProfileByUsername,
    getCachedProfileByUsername,
    getCachedProfile,
    clearCachedProfile,
    clearCachedProfileByUsername,
    trackProfileView,
    USERNAME_MIN,
    USERNAME_MAX,
    USERNAME_RE,
} from "../services/userService";
import {
    getFollowCounts,
    setCachedFollowCounts,
    getCachedFollowCounts,
    clearCachedFollowCounts,
    isFollowing,
    setCachedFollowStatus,
    getCachedFollowStatus,
} from "../services/followService";
import {
    getProfileContent,
    getLikedPostIds,
    getRepostedPostIds,
    getSavedPostIds,
    getSavedPosts,
    getLikedPosts,
    getScheduledPosts,
    getDislikedPostIds,
    getUserComments,
    isCommentLiked,
    isCommentDisliked,
    setCachedFeed,
    getCachedFeed,
    clearFeedCache,
    sortProfilePosts,
    clearVisibleIdsCache,
} from "../services/postService";
import "../Resources/Styles/profiles.css";
import "../Resources/Styles/skeleton.css";
import "../Resources/Styles/post.css";
import Modal from "../Resources/Components/Modal";
import Badge from "../Resources/Components/Badge";
import Avatar from "../Resources/Components/Avatar";
import Tooltip from "../Resources/Components/Tooltip";
import { getPlatformIcon, getPlatformName } from "../services/socialPlatforms";
import { FaFeather, FaBookmark, FaLock, FaEllipsisH, FaBan, FaClock, FaHeart, FaRetweet, FaChevronDown, FaShareAlt, FaComment, FaCommentDots, FaTag, FaPlus } from 'react-icons/fa';
import FollowButton from "../Resources/Components/FollowButton";
import { blockUser, unblockUser, isBlocked, cacheBlockStatus, getCachedBlockStatus, unfollowBothWays } from "../services/blockService";
import { useI18n } from "../services/i18n/useI18n";
import { getContrastText, isUUID, getTimeAgo, getImageStyle, sanitizeUrl } from "../services/helpers";
import usePageMeta from "../../hooks/usePageMeta";
import useBgContrast from "../../hooks/useBgContrast";
import FollowersModal from "../Resources/Components/FollowersModal";
import ModalShell from "../Resources/Components/ModalShell";
import ConfirmModal from "../Resources/Components/ConfirmModal";
import CreatePostModal from "../Resources/Components/CreatePostModal";
import FloatingActionButton from "../Resources/Components/FloatingActionButton";
import { toast } from 'react-toastify';
import { getCdnUrl } from '../services/cdnService';
import { useUserStatus } from '../services/useUserStatus';
import { useRegisterUserStatus, UserStatusContext } from '../../context/UserStatusContext';
import { getNicknames, getCachedNicknames, cacheNicknames } from "../services/chatService";
import NicknameModal from "../Resources/Components/NicknameModal";
import VirtualPostList from "../Resources/Components/VirtualPostList";

function Profile() {
    const { t, showAccent, accentVisibility, showBadges, locale } = useI18n();
    const { username: profileUsername } = useParams();
    const navigate = useNavigate();
    const { user, profile: ownProfile, refreshProfile, isAuthenticated, loading } = useAuth();

    const isOwnProfile = !profileUsername || profileUsername === ownProfile?.username;

    const [viewedProfile, setViewedProfile] = useState(() => {
        if (isOwnProfile) return null;
        const cached = isUUID(profileUsername)
            ? getCachedProfile(profileUsername)
            : getCachedProfileByUsername(profileUsername);
        return cached || null;
    });
    const [viewedProfileLoading, setViewedProfileLoading] = useState(() => {
        if (isOwnProfile) return false;
        const cached = isUUID(profileUsername)
            ? getCachedProfile(profileUsername)
            : getCachedProfileByUsername(profileUsername);
        return !cached;
    });
    const [profileError, setProfileError] = useState(null);

    const activeProfile = isOwnProfile ? ownProfile : viewedProfile;
    // ── Extract early for useBgContrast hook (must be before any early returns) ──
    const bgUrlEarly = activeProfile?.profile_background_url;
    const autoBgContrastColor = useBgContrast(bgUrlEarly);
    usePageMeta({
        title: activeProfile?.username ? `@${activeProfile.username}` : t('profile.title'),
        description: activeProfile?.bio ? (activeProfile.bio.length > 200 ? activeProfile.bio.slice(0, 200) + '...' : activeProfile.bio) : `Check out ${activeProfile?.username ? `@${activeProfile.username}` : ''} on Closedoor!`,
        image: activeProfile?.banner_url || activeProfile?.avatar_url || undefined,
        url: activeProfile?.username ? `${window.location.origin}/profile/${activeProfile.username}` : undefined,
    });
    const isPrivate = activeProfile?.is_private === true;

    // ── Obtener userId incluso cuando activeProfile aún no cargó ──
    const resolveUserId = () => {
        if (activeProfile?.id) return activeProfile.id;
        if (profileUsername && !isOwnProfile) {
            const cached = isUUID(profileUsername)
                ? getCachedProfile(profileUsername)
                : getCachedProfileByUsername(profileUsername);
            if (cached) return cached.id;
        }
        return null;
    };
    const resolvedUserId = resolveUserId();

    const [isFollower, setIsFollower] = useState(() => {
        const targetId = activeProfile?.id || resolveUserId();
        if (user?.id && targetId && !isOwnProfile) {
            return getCachedFollowStatus(user.id, targetId) ?? null;
        }
        return null;
    });
    const [isFollowedBy, setIsFollowedBy] = useState(() => {
        // Si el perfil visitado sigue al usuario actual
        const targetId = activeProfile?.id || resolveUserId();
        if (user?.id && targetId && !isOwnProfile) {
            return getCachedFollowStatus(targetId, user.id) ?? null;
        }
        return null;
    });
    const canViewContent = isOwnProfile || !isPrivate || isFollower === true;

    // ── Track profile view (once per visitor) ──
    useEffect(() => {
        if (activeProfile?.id) {
            trackProfileView(activeProfile.id, user?.id);
        }
    }, [activeProfile?.id, user?.id]);

    const [followCounts, setFollowCounts] = useState(() => {
        const targetId = activeProfile?.id || resolveUserId();
        const cached = targetId ? getCachedFollowCounts(targetId) : null;
        return cached || null;
    });
    const [countsLoading, setCountsLoading] = useState(() => {
        const targetId = activeProfile?.id || resolveUserId();
        return targetId ? !getCachedFollowCounts(targetId) : true;
    });

  // ── User status ──
  const { myStatus, setMyStatus } = useUserStatus(isOwnProfile ? user?.id : null);
  // ── Observar estado del perfil visitado en el contexto global (persiste entre rutas) ──
  useRegisterUserStatus(!isOwnProfile ? activeProfile?.id : null);
  // Estado del perfil visitado — del contexto global (polling 3s batch) + Realtime
  const globalStatuses = useContext(UserStatusContext);
  const contextStatus = !isOwnProfile && activeProfile?.id ? (globalStatuses[activeProfile.id] || null) : null;
  const [profileStatus, setProfileStatus] = useState(() => activeProfile?.user_status || null);
  // Sync profileStatus when activeProfile changes (initial load / cache restore)
  useEffect(() => {
    if (activeProfile?.user_status !== undefined && activeProfile.user_status !== profileStatus) {
      setProfileStatus(activeProfile.user_status);
    }
  }, [activeProfile?.user_status]);
  // Actualizar profileStatus desde el contexto global (UserStatusContext polling 3s)
  useEffect(() => {
    if (contextStatus !== null && contextStatus !== profileStatus) {
      setProfileStatus(contextStatus);
    }
  }, [contextStatus]);

  // ── Block / context menu state ──
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [blockLoading, setBlockLoading] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState({});
  const contextMenuRef = useRef(null);
  const dropdownRef = useRef(null);
  // Cache-first approach: useMemo reads localStorage synchronously during render (no flash)
  // useState holds the DB-confirmed value from async check
  const [isBlockedByMeDb, setIsBlockedByMeDb] = useState(null);

  const isBlockedByMe = useMemo(() => {
    if (user?.id && activeProfile?.id && !isOwnProfile) {
      const cached = getCachedBlockStatus(user.id, activeProfile.id);
      if (cached !== null) return cached;
    }
    return isBlockedByMeDb;
  }, [user?.id, activeProfile?.id, isOwnProfile, isBlockedByMeDb]);

    // ── Fetch other user's profile (refresh en background) ──
    useEffect(() => {
        if (isOwnProfile) {
            setViewedProfile(null);
            setProfileError(null);
            return;
        }

        const isUuidParam = isUUID(profileUsername);
        // Cache ya se leyó en useState — solo fetch en background para refrescar

        const loadProfile = async () => {
            setProfileError(null);
            try {
                const userProfile = isUuidParam
                    ? await getUserProfile(profileUsername)
                    : await getUserProfileByUsername(profileUsername);
                if (!userProfile) {
                    setProfileError(t('profile.not_found'));
                    setViewedProfile(null);
                } else {
                    setViewedProfile(userProfile);
                    setCachedProfile(userProfile);
                    if (!isUuidParam) {
                        setCachedProfileByUsername(profileUsername, userProfile);
                    }
                }
            } catch (err) {
                setProfileError(t('common.error'));
                setViewedProfile(null);
            } finally {
                setViewedProfileLoading(false);
            }
        };

        loadProfile();
    }, [profileUsername, isOwnProfile, t]);

    // ── Fetch follow counts inicial (cache-first, refresh en background) ──
    useEffect(() => {
        const userId = activeProfile?.id;
        if (!userId) return;

        const refreshCounts = () => {
            getFollowCounts(userId)
                .then((counts) => {
                    setFollowCounts(counts);
                    setCachedFollowCounts(userId, counts);
                    setCountsLoading(false);
                })
                .catch((err) => {
                    console.warn("Error refreshing follow counts:", err);
                    setCountsLoading(false);
                });
        };

        // Restaurar cache inmediatamente (síncrono)
        const cached = getCachedFollowCounts(userId);
        setFollowCounts(cached || null);
        setCountsLoading(!cached);

        // Fetch inicial en segundo plano
        refreshCounts();
    }, [activeProfile?.id]);

      // ── Check if current user has blocked this profile ──
  useEffect(() => {
    if (!user?.id || !activeProfile?.id || isOwnProfile) {
      setIsBlockedByMeDb(false);
      return;
    }
    // Async DB check; cache-first already handled in useMemo during render
    isBlocked(user.id, activeProfile.id)
      .then((blocked) => {
        setIsBlockedByMeDb(blocked);
        cacheBlockStatus(user.id, activeProfile.id, blocked);
      })
      .catch((err) => console.warn('Error checking block status:', err));
  }, [user?.id, activeProfile?.id, isOwnProfile]);

  // ── Check if this profile has blocked the current user ──
  const [isBlockedByThemDb, setIsBlockedByThemDb] = useState(null);
  const isBlockedByThem = useMemo(() => {
    if (user?.id && activeProfile?.id && !isOwnProfile) {
      const cached = getCachedBlockStatus(activeProfile.id, user.id);
      if (cached !== null) return cached;
    }
    return isBlockedByThemDb;
  }, [user?.id, activeProfile?.id, isOwnProfile, isBlockedByThemDb]);

  useEffect(() => {
    if (!user?.id || !activeProfile?.id || isOwnProfile) {
      setIsBlockedByThemDb(false);
      return;
    }
    // Async DB check; cache-first already handled in useMemo during render
    isBlocked(activeProfile.id, user.id)
      .then((blocked) => {
        setIsBlockedByThemDb(blocked);
        cacheBlockStatus(activeProfile.id, user.id, blocked);
      })
      .catch((err) => console.warn('Error checking reverse block:', err));
  }, [user?.id, activeProfile?.id, isOwnProfile]);

  // ── Close context menu on outside click or scroll ──
  useEffect(() => {
    if (!contextMenuOpen) {
      setDropdownStyle(null);
      return;
    }
    const handleClick = (e) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target)
          && dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setContextMenuOpen(false);
      }
    };
    const closeOnScroll = () => setContextMenuOpen(false);
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('scroll', closeOnScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('scroll', closeOnScroll, { capture: true });
    };
  }, [contextMenuOpen]);

// ── Check if current user follows this profile (solo una vez, cache + Realtime) ──
    useEffect(() => {
        if (!user?.id || !activeProfile?.id || isOwnProfile) {
            setIsFollower(null);
            return;
        }

        // Cache: si ya existe, usarlo sin re-consultar
        const cached = getCachedFollowStatus(user.id, activeProfile.id);
        if (cached !== null) {
            setIsFollower(cached);
            return;
        }

        // Primera vez: consultar y cachear
        isFollowing(user.id, activeProfile.id)
            .then((status) => {
                setIsFollower(status);
                setCachedFollowStatus(user.id, activeProfile.id, status);
            })
            .catch((err) => {
                console.warn('Error checking follower status:', err);
                setIsFollower(false);
            });
    }, [user?.id, activeProfile?.id, isOwnProfile]);

    // ── Check if this profile follows the current user ("Te sigue") ──
    useEffect(() => {
        if (!user?.id || !activeProfile?.id || isOwnProfile) {
            setIsFollowedBy(null);
            return;
        }

        const cached = getCachedFollowStatus(activeProfile.id, user.id);
        if (cached !== null) {
            setIsFollowedBy(cached);
            return;
        }

        isFollowing(activeProfile.id, user.id)
            .then((status) => {
                setIsFollowedBy(status);
                setCachedFollowStatus(activeProfile.id, user.id, status);
            })
            .catch((err) => {
                console.warn('Error checking if profile follows you:', err);
                setIsFollowedBy(false);
            });
    }, [user?.id, activeProfile?.id, isOwnProfile]);

    // ── Followers modal state ──
    const [followersModal, setFollowersModal] = useState({ open: false, type: "followers" });
    // ── Social Links modal state ──
    const [socialLinksModal, setSocialLinksModal] = useState(false);
    // ── Credits toggle state ──
    const [showBannerCredits, setShowBannerCredits] = useState(false);
    const [showAvatarCredits, setShowAvatarCredits] = useState(false);

    const openFollowersModal = (type) => {
        if (activeProfile?.id && canViewContent) {
            setFollowersModal({ open: true, type });
        }
    };

    const closeFollowersModal = () => {
        setFollowersModal({ open: false, type: "followers" });
        // Refresh counts + cache when modal closes
        if (activeProfile?.id) {
            getFollowCounts(activeProfile.id)
                .then((counts) => {
                    setFollowCounts(counts);
                    setCachedFollowCounts(activeProfile.id, counts);
                })
                .catch((err) => console.warn("Error refreshing follow counts:", err));
        }
    };

    // ── Posts state (con cache, usando resolvedUserId aunque activeProfile sea null) ──
    const cacheKey = resolvedUserId ? `profile_posts_${resolvedUserId}` : null;
    const getCachedPosts = () => (cacheKey ? getCachedFeed(cacheKey) : null);
    const [profilePosts, setProfilePosts] = useState(() => getCachedPosts()?.items || []);
    const [likedPostIds, setLikedPostIds] = useState(() => getCachedPosts()?.likedIds || []);
    const [repostedPostIds, setRepostedPostIds] = useState(() => getCachedPosts()?.repostedIds || []);
    const [dislikedPostIds, setDislikedPostIds] = useState(() => getCachedPosts()?.dislikedIds || []);
    const [savedPostIds, setSavedPostIds] = useState(() => getCachedPosts()?.savedIds || []);
    const [postsLoading, setPostsLoading] = useState(() => !getCachedPosts());

    // ── Clear profile post cache on browser reload (like Chat.jsx) ──
    useEffect(() => {
        const FLAG = 'fc_profile_reload_clear_done';
        if (!sessionStorage.getItem(FLAG)) {
            sessionStorage.setItem(FLAG, '1');
            try {
                const toRemove = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    if (key && key.startsWith('fc_feed_profile_posts_')) toRemove.push(key);
                }
                toRemove.forEach(k => sessionStorage.removeItem(k));
            } catch (e) { /* silent */ }
        }
    }, []);

    const [showCreatePost, setShowCreatePost] = useState(false);
    const [editingPost, setEditingPost] = useState(null);
    const [tab, setTab] = useState('posts'); // 'posts' | 'likes' | 'saved' | 'scheduled' | 'replies'
    const [postSubFilter, setPostSubFilter] = useState('all'); // 'all' | 'reposts'
    const [postFilterOpen, setPostFilterOpen] = useState(false);
    const [postFilterDropdownStyle, setPostFilterDropdownStyle] = useState(null);
    const postFilterRef = useRef(null);
    const postFilterDropdownRef = useRef(null);

  // ── Close post filter dropdown on outside click ──
  useEffect(() => {
    if (!postFilterOpen) return;
    const handleClick = (e) => {
      const inTrigger = postFilterRef.current && postFilterRef.current.contains(e.target);
      const inDropdown = postFilterDropdownRef.current && postFilterDropdownRef.current.contains(e.target);
      if (!inTrigger && !inDropdown) {
        setPostFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [postFilterOpen]);

    // Resetear a 'posts' al navegar a un perfil ajeno
    useEffect(() => {
        if (!isOwnProfile) setTab('posts');
    }, [isOwnProfile]);
    // ── Para likes/saves: usar el ID del perfil activo (propio o ajeno) ──
    const likesUserId = isOwnProfile ? user?.id : activeProfile?.id;
    const savesUserId = isOwnProfile ? user?.id : activeProfile?.id;
    const [scheduledPosts, setScheduledPosts] = useState([]);
    const [scheduledPostsLoading, setScheduledPostsLoading] = useState(true);
    const repliesCacheKey = activeProfile?.id ? `replies_${activeProfile.id}` : null;
    const [replies, setReplies] = useState(() => {
        const cached = repliesCacheKey ? getCachedFeed(repliesCacheKey) : null;
        return cached?.items || [];
    });
    const [repliesLoading, setRepliesLoading] = useState(() => {
        return repliesCacheKey ? !getCachedFeed(repliesCacheKey) : false;
    });
    const [repliesLikedIds, setRepliesLikedIds] = useState(() => {
        const cached = repliesCacheKey ? getCachedFeed(repliesCacheKey) : null;
        return cached?.likedIds || [];
    });
    const [repliesDislikedIds, setRepliesDislikedIds] = useState(() => {
        const cached = repliesCacheKey ? getCachedFeed(repliesCacheKey) : null;
        return cached?.dislikedIds || [];
    });
    const savedCacheKey = savesUserId ? `saved_posts_${savesUserId}` : null;
    const [savedPosts, setSavedPosts] = useState(() => {
        const cached = savedCacheKey ? getCachedFeed(savedCacheKey) : null;
        return cached?.items || [];
    });
    const [savedLikedIds, setSavedLikedIds] = useState(() => {
        const cached = savedCacheKey ? getCachedFeed(savedCacheKey) : null;
        return cached?.likedIds || [];
    });
    const [savedRepostedIds, setSavedRepostedIds] = useState(() => {
        const cached = savedCacheKey ? getCachedFeed(savedCacheKey) : null;
        return cached?.repostedIds || [];
    });
    const [savedDislikedIds, setSavedDislikedIds] = useState(() => {
        const cached = savedCacheKey ? getCachedFeed(savedCacheKey) : null;
        return cached?.dislikedIds || [];
    });
    const [savedPostsLoading, setSavedPostsLoading] = useState(() => {
        const cached = savedCacheKey ? getCachedFeed(savedCacheKey) : null;
        return !cached;
    });
    const likedCacheKey = likesUserId ? `liked_posts_${likesUserId}` : null;
    const [likedPosts, setLikedPosts] = useState(() => {
        const cached = likedCacheKey ? getCachedFeed(likedCacheKey) : null;
        return cached?.items || [];
    });
    const [likedLikedIds, setLikedLikedIds] = useState(() => {
        const cached = likedCacheKey ? getCachedFeed(likedCacheKey) : null;
        return cached?.likedIds || [];
    });
    const [likedRepostedIds, setLikedRepostedIds] = useState(() => {
        const cached = likedCacheKey ? getCachedFeed(likedCacheKey) : null;
        return cached?.repostedIds || [];
    });
    const [likedSavedIds, setLikedSavedIds] = useState(() => {
        const cached = likedCacheKey ? getCachedFeed(likedCacheKey) : null;
        return cached?.savedIds || [];
    });
    const [likedDislikedIds, setLikedDislikedIds] = useState(() => {
        const cached = likedCacheKey ? getCachedFeed(likedCacheKey) : null;
        return cached?.dislikedIds || [];
    });
    const [likedPostsLoading, setLikedPostsLoading] = useState(() => {
        const cached = likedCacheKey ? getCachedFeed(likedCacheKey) : null;
        return !cached;
    });

    // ── Fetch posts + reposts for active profile (con cache) ──
    useEffect(() => {
        const userId = activeProfile?.id;
        if (!userId || !canViewContent) return;

        const newCacheKey = `profile_posts_${userId}`;
        const cached = getCachedFeed(newCacheKey);
        if (cached) {
            setProfilePosts(cached.items || []);
            setLikedPostIds(cached.likedIds || []);
            setRepostedPostIds(cached.repostedIds || []);
            setSavedPostIds(cached.savedIds || []);
            setDislikedPostIds(cached.dislikedIds || []);
            setPostsLoading(false);
        } else {
            setPostsLoading(true);
        }
        const loadPosts = async () => {
            try {
                const items = await getProfileContent(userId, user?.id);
                setProfilePosts(items);
                // Batch check likes/reposts/saves for current user
                let likedIds = [], repostedIds = [], savedIds = [], dislikedIds = [];
                if (user?.id && items.length > 0) {
                    const postIds = items.map((p) => p.id);
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
                setCachedFeed(`profile_posts_${userId}`, items, likedIds, repostedIds, savedIds, dislikedIds);
            } catch (err) {
                console.error('Error loading posts:', err);
            } finally {
                setPostsLoading(false);
            }
        };

        loadPosts();
    }, [activeProfile?.id, activeProfile?.username, user?.id, canViewContent]);



    // ── Realtime unificado: sigue cambios en follows, perfil y posts ──
    useEffect(() => {
        const profileId = activeProfile?.id;
        if (!profileId || !user?.id || isOwnProfile) return;

        // Refresh follow counts
        const refreshCounts = () => {
            getFollowCounts(profileId)
                .then((counts) => {
                    setFollowCounts(counts);
                    setCachedFollowCounts(profileId, counts);
                })
                .catch((err) => console.warn("Error refreshing follow counts:", err));
        };

        // Refresh posts after insert/delete (fetch all)
        const refreshAfterChange = async () => {
            if (!canViewContent) return;
            try {
                const items = await getProfileContent(profileId, user?.id);
                setProfilePosts(items);
                let likedIds = [], repostedIds = [], savedIds = [], dislikedIds = [];
                if (user?.id && items.length > 0) {
                    const postIds = items.map((p) => p.id);
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
                setCachedFeed(`profile_posts_${profileId}`, items, likedIds, repostedIds, savedIds, dislikedIds);
            } catch (err) {
                console.warn('Error refreshing after change:', err);
            }
        };

        const channel = supabase
            .channel(`profile-${profileId}`)
            // ── Follow counts ──
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'follows', filter: `following_id=eq.${profileId}` }, () => refreshCounts())
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'follows', filter: `following_id=eq.${profileId}` }, () => refreshCounts())
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'follows', filter: `follower_id=eq.${profileId}` }, () => refreshCounts())
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'follows', filter: `follower_id=eq.${profileId}` }, () => refreshCounts())
            // ── Follow status (current user's follows) ──
            .on('postgres_changes', { event: '*', schema: 'public', table: 'follows', filter: `follower_id=eq.${user.id}` }, async (payload) => {
                const affectedId = payload.new?.following_id || payload.old?.following_id;
                if (affectedId !== profileId) return;
                try {
                    const { data, error } = await supabase
                        .from('follows')
                        .select('follower_id')
                        .eq('follower_id', user.id)
                        .eq('following_id', profileId)
                        .eq('status', 'accepted')
                        .maybeSingle();
                    if (!error) {
                        const isNowFollowing = !!data;
                        setIsFollower(isNowFollowing);
                        setCachedFollowStatus(user.id, profileId, isNowFollowing);
                        refreshCounts();
                    }
                } catch (err) {
                    console.warn('Error in follow status Realtime handler:', err);
                }
            })
            // ── Reverse follow status (profile follows/unfollows current user → "Follows you") ──
            .on('postgres_changes', { event: '*', schema: 'public', table: 'follows', filter: `following_id=eq.${user.id}` }, async (payload) => {
                const affectedId = payload.new?.follower_id || payload.old?.follower_id;
                if (affectedId !== profileId) return;
                try {
                    const { data, error } = await supabase
                        .from('follows')
                        .select('follower_id')
                        .eq('follower_id', profileId)
                        .eq('following_id', user.id)
                        .eq('status', 'accepted')
                        .maybeSingle();
                    if (!error) {
                        const isNowFollowingYou = !!data;
                        setIsFollowedBy(isNowFollowingYou);
                        setCachedFollowStatus(profileId, user.id, isNowFollowingYou);
                        refreshCounts();
                    }
                } catch (err) {
                    console.warn('Error in reverse follow Realtime handler:', err);
                }
            })
            // ── Block status (current user blocks/unblocks profile) ──
            // Con REPLICA IDENTITY FULL, payload.old en DELETE tiene todos los campos
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'blocks', filter: `blocker_id=eq.${user.id}` }, (payload) => {
                if (payload.new.blocked_id !== profileId) return;
                setIsBlockedByMeDb(true);
                cacheBlockStatus(user.id, profileId, true);
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'blocks', filter: `blocker_id=eq.${user.id}` }, (payload) => {
                if (payload.old.blocked_id !== profileId) return;
                setIsBlockedByMeDb(false);
                cacheBlockStatus(user.id, profileId, false);
            })
            // ── Block status (profile blocks/unblocks current user) ──
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'blocks', filter: `blocked_id=eq.${user.id}` }, (payload) => {
                if (payload.new.blocker_id !== profileId) return;
                setIsBlockedByThemDb(true);
                cacheBlockStatus(profileId, user.id, true);
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'blocks', filter: `blocked_id=eq.${user.id}` }, (payload) => {
                if (payload.old.blocker_id !== profileId) return;
                setIsBlockedByThemDb(false);
                cacheBlockStatus(profileId, user.id, false);
            })
            // ── Profile updates (is_private, avatar, bio, user_status, etc.) ──
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${profileId}` }, (payload) => {
                const updated = payload.new;
                const merged = { ...activeProfile, ...updated };
                setViewedProfile(merged);
                setCachedProfile(merged);
                if (profileUsername && !isUUID(profileUsername)) {
                    setCachedProfileByUsername(profileUsername, merged);
                }
                // Update profile status in real-time from any profile update
                // (activeProfile in the closure is stale, so we skip the comparison)
                if (updated.user_status !== undefined) {
                    setProfileStatus(updated.user_status);
                }
                const prevIsPrivate = payload.old?.is_private === true;
                const newIsPrivate = updated?.is_private === true;
                if (prevIsPrivate !== newIsPrivate) {
                    clearVisibleIdsCache(user?.id);
                    // Si cambió a privado, invalidar cache de follow counts para que no quede stale
                    if (!prevIsPrivate && newIsPrivate) {
                        clearCachedFollowCounts(profileId);
                        clearCachedProfile(profileId);
                        if (profileUsername && !isUUID(profileUsername)) {
                            clearCachedProfileByUsername(profileUsername);
                        }
                        setFollowCounts(null);
                    }
                }
            })
            // ── Posts / Reposts ──
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts', filter: `user_id=eq.${profileId}` }, () => canViewContent && refreshAfterChange())
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts', filter: `user_id=eq.${profileId}` }, () => canViewContent && refreshAfterChange())
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reposts', filter: `user_id=eq.${profileId}` }, () => canViewContent && refreshAfterChange())
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reposts', filter: `user_id=eq.${profileId}` }, () => canViewContent && refreshAfterChange())
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts', filter: `user_id=eq.${profileId}` }, (payload) => {
                if (!canViewContent) return;
                const updated = payload.new;
                setProfilePosts((prev) => {
                    const idx = prev.findIndex((p) => p.id === updated.id);
                    if (idx === -1) return prev;
                    // ⚠️ Perf: reemplazar SOLO el post afectado manteniendo la
                    // referencia de los demás → React.memo de PostCard salta el
                    // re-render de los otros 96 posts. Antes se re-mapeaba y
                    // re-ordenaba TODA la lista en cada UPDATE (like/comentario/vista).
                    const next = prev.slice();
                    next[idx] = {
                        ...prev[idx],
                        likes_count: updated.likes_count ?? prev[idx].likes_count,
                        dislikes_count: updated.dislikes_count ?? prev[idx].dislikes_count,
                        reposts_count: updated.reposts_count ?? prev[idx].reposts_count,
                        comments_count: updated.comments_count ?? prev[idx].comments_count,
                        views_count: updated.views_count ?? prev[idx].views_count,
                        is_pinned: updated.is_pinned ?? prev[idx].is_pinned,
                        pinned_at: updated.pinned_at ?? prev[idx].pinned_at,
                    };
                    // Solo re-ordenar si cambió el pin (afecta sortProfilePosts);
                    // los contadores (likes/views/comments) no cambian el orden.
                    if (next[idx].is_pinned !== prev[idx].is_pinned || next[idx].pinned_at !== prev[idx].pinned_at) {
                        return next.sort(sortProfilePosts);
                    }
                    return next;
                });
            })
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [activeProfile?.id, user?.id, isOwnProfile, profileUsername, canViewContent]);

    // ── Load scheduled posts (solo perfil propio) ──
    useEffect(() => {
        if (!user?.id) return;
        setScheduledPostsLoading(true);
        getScheduledPosts(user.id)
            .then((items) => {
                setScheduledPosts(items);
            })
            .catch((err) => {
                console.error('Error loading scheduled posts:', err);
            })
            .finally(() => {
                setScheduledPostsLoading(false);
            });
    }, [user?.id]);

    // ── Load saved posts (con cache + background refresh, solo perfil propio) ──
    useEffect(() => {
        if (!savesUserId || !isOwnProfile) return;
        const cacheKey = `saved_posts_${savesUserId}`;

        // Restaurar cache inmediatamente (síncrono)
        const cached = getCachedFeed(cacheKey);
        if (cached) {
            setSavedPosts(cached.items || []);
            setSavedLikedIds(cached.likedIds || []);
            setSavedRepostedIds(cached.repostedIds || []);
            setSavedPostsLoading(false);
        } else {
            setSavedPostsLoading(true);
        }

        // Fetch en segundo plano
        const loadSaved = async () => {
            try {
                const items = await getSavedPosts(savesUserId);
                setSavedPosts(items);
                // Check liked/reposted/disliked state for these posts
                let likedIds = [], repostedIds = [], dislikedIds = [];
                if (items.length > 0) {
                    const postIds = items.map((p) => p.id);
                    [likedIds, repostedIds, dislikedIds] = await Promise.all([
                        getLikedPostIds(postIds, user.id),
                        getRepostedPostIds(postIds, user.id),
                        getDislikedPostIds(postIds, user.id),
                    ]);
                    setSavedLikedIds(likedIds);
                    setSavedRepostedIds(repostedIds);
                    setSavedDislikedIds(dislikedIds);
                }
                setCachedFeed(cacheKey, items, likedIds, repostedIds, [], dislikedIds);
            } catch (err) {
                console.error('Error loading saved posts:', err);
            } finally {
                setSavedPostsLoading(false);
            }
        };

        loadSaved();
    }, [savesUserId]);

    // ── Load replies (comments by this user, con cache) ──
    useEffect(() => {
        const userId = activeProfile?.id;
        if (!userId || tab !== 'replies') return;
        const cacheKey = `replies_${userId}`;

        // Restaurar cache inmediatamente (síncrono)
        const cached = getCachedFeed(cacheKey);
        if (cached) {
            setReplies(cached.items || []);
            setRepliesLikedIds(cached.likedIds || []);
            setRepliesDislikedIds(cached.dislikedIds || []);
            setRepliesLoading(false);
        } else {
            setRepliesLoading(true);
        }

        // Fetch en segundo plano
        getUserComments(userId)
            .then(async (items) => {
                setReplies(items);
                let likedIds = [], dislikedIds = [];
                if (user?.id && items.length > 0) {
                    const commentIds = items.map(c => c.id);
                    const [likedResults, dislikedResults] = await Promise.all([
                        Promise.allSettled(commentIds.map(id => isCommentLiked(id, user.id))),
                        Promise.allSettled(commentIds.map(id => isCommentDisliked(id, user.id))),
                    ]);
                    commentIds.forEach((id, idx) => {
                        if (likedResults[idx].status === 'fulfilled' && likedResults[idx].value) likedIds.push(id);
                        if (dislikedResults[idx].status === 'fulfilled' && dislikedResults[idx].value) dislikedIds.push(id);
                    });
                    setRepliesLikedIds(likedIds);
                    setRepliesDislikedIds(dislikedIds);
                }
                setCachedFeed(cacheKey, items, likedIds, dislikedIds, [], []);
            })
            .catch((err) => {
                console.error('Error loading replies:', err);
            })
            .finally(() => {
                setRepliesLoading(false);
            });
    }, [tab, activeProfile?.id, user?.id]);

    // ── Load liked posts (con cache + background refresh) ──
    useEffect(() => {
        if (!likesUserId) return;
        const cacheKey = `liked_posts_${likesUserId}`;

        // Restaurar cache inmediatamente (síncrono)
        const cached = getCachedFeed(cacheKey);
        if (cached) {
            setLikedPosts(cached.items || []);
            setLikedLikedIds(cached.likedIds || []);
            setLikedRepostedIds(cached.repostedIds || []);
            setLikedSavedIds(cached.savedIds || []);
            setLikedPostsLoading(false);
        } else {
            setLikedPostsLoading(true);
        }

        // Fetch en segundo plano
        const loadLiked = async () => {
            try {
                const items = await getLikedPosts(likesUserId);
                setLikedPosts(items);
                // Check liked/reposted/saved state for these posts (solo si hay usuario logueado)
                let likedIds = [], repostedIds = [], savedIds = [], dislikedIds = [];
                if (items.length > 0 && user?.id) {
                    const postIds = items.map((p) => p.id);
                    [likedIds, repostedIds, savedIds, dislikedIds] = await Promise.all([
                        getLikedPostIds(postIds, user.id),
                        getRepostedPostIds(postIds, user.id),
                        getSavedPostIds(postIds, user.id),
                        getDislikedPostIds(postIds, user.id),
                    ]);
                    setLikedLikedIds(likedIds);
                    setLikedRepostedIds(repostedIds);
                    setLikedSavedIds(savedIds);
                    setLikedDislikedIds(dislikedIds);
                }
                setCachedFeed(cacheKey, items, likedIds, repostedIds, savedIds, dislikedIds);
            } catch (err) {
                console.error('Error loading liked posts:', err);
            } finally {
                setLikedPostsLoading(false);
            }
        };

        loadLiked();
    }, [likesUserId, user?.id]);

    // ── Refresh saved posts when switching to Saved tab ──
    useEffect(() => {
        if (tab !== 'saved' || !savesUserId) return;
        const cacheKey = `saved_posts_${savesUserId}`;
        (async () => {
            try {
                const items = await getSavedPosts(savesUserId);
                setSavedPosts(items);
                let likedIds = [], repostedIds = [], dislikedIds = [];
                if (items.length > 0) {
                    const postIds = items.map((p) => p.id);
                    [likedIds, repostedIds, dislikedIds] = await Promise.all([
                        getLikedPostIds(postIds, user.id),
                        getRepostedPostIds(postIds, user.id),
                        getDislikedPostIds(postIds, user.id),
                    ]);
                    setSavedLikedIds(likedIds);
                    setSavedRepostedIds(repostedIds);
                    setSavedDislikedIds(dislikedIds);
                }
                setCachedFeed(cacheKey, items, likedIds, repostedIds, [], dislikedIds);
            } catch (err) {
                console.warn('Error refreshing saved posts:', err);
            }
        })();
    }, [tab, savesUserId]);

    // ── Refresh liked posts when switching to Likes tab ──
    useEffect(() => {
        if (tab !== 'likes' || !likesUserId) return;
        const cacheKey = `liked_posts_${likesUserId}`;
        (async () => {
            try {
                const items = await getLikedPosts(likesUserId);
                setLikedPosts(items);
                let likedIds = [], repostedIds = [], savedIds = [], dislikedIds = [];
                if (items.length > 0) {
                    const postIds = items.map((p) => p.id);
                    [likedIds, repostedIds, savedIds, dislikedIds] = await Promise.all([
                        getLikedPostIds(postIds, user.id),
                        getRepostedPostIds(postIds, user.id),
                        getSavedPostIds(postIds, user.id),
                        getDislikedPostIds(postIds, user.id),
                    ]);
                    setLikedLikedIds(likedIds);
                    setLikedRepostedIds(repostedIds);
                    setLikedSavedIds(savedIds);
                    setLikedDislikedIds(dislikedIds);
                }
                setCachedFeed(cacheKey, items, likedIds, repostedIds, savedIds, dislikedIds);
            } catch (err) {
                console.warn('Error refreshing liked posts:', err);
            }
        })();
    }, [tab, likesUserId]);

    // ── Handlers for like/repost/dislike sync ──
    // Solo actualizan arrays booleanos de IDs. Los contadores los maneja PostCard localmente
    // y Realtime los sincroniza desde la DB.
    // useCallback: identidad estable → React.memo de PostCard puede saltar re-renders.
    const handleLikeToggle = useCallback((postId, nowLiked) => {
      setLikedPostIds((prev) =>
        nowLiked ? [...prev, postId] : prev.filter((id) => id !== postId)
      );
      setSavedLikedIds((prev) =>
        nowLiked ? [...prev, postId] : prev.filter((id) => id !== postId)
      );
      setLikedLikedIds((prev) =>
        nowLiked ? [...prev, postId] : prev.filter((id) => id !== postId)
      );
    }, []);

    const handleRepostToggle = useCallback((postId, nowReposted) => {
      setRepostedPostIds((prev) =>
        nowReposted ? [...prev, postId] : prev.filter((id) => id !== postId)
      );
      setSavedRepostedIds((prev) =>
        nowReposted ? [...prev, postId] : prev.filter((id) => id !== postId)
      );
      setLikedRepostedIds((prev) =>
        nowReposted ? [...prev, postId] : prev.filter((id) => id !== postId)
      );
    }, []);

    const handleDislikeToggle = useCallback((postId, nowDisliked) => {
      setDislikedPostIds((prev) =>
        nowDisliked ? [...prev, postId] : prev.filter((id) => id !== postId)
      );
      setSavedDislikedIds((prev) =>
        nowDisliked ? [...prev, postId] : prev.filter((id) => id !== postId)
      );
      setLikedDislikedIds((prev) =>
        nowDisliked ? [...prev, postId] : prev.filter((id) => id !== postId)
      );
    }, []);

    // ── Handlers for post actions ──
    const handlePostCreated = useCallback(async () => {
        const userId = activeProfile?.id;
        if (!userId) return;
        try {
            // Refrescar posts normales (fetch all)
            const items = await getProfileContent(userId, user?.id);
            setProfilePosts(items);
            let likedIds = [], repostedIds = [], savedIds = [], dislikedIds = [];
            if (user?.id && items.length > 0) {
                const postIds = items.map((p) => p.id);
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
            setCachedFeed(`profile_posts_${userId}`, items, likedIds, repostedIds, savedIds, dislikedIds);
            // Refrescar posts programados (aparecen al instante en la tab "Programados")
            if (user?.id) {
                const schedItems = await getScheduledPosts(user.id);
                setScheduledPosts(schedItems);
            }
        } catch (err) {
            console.error('Error refreshing posts:', err);
        }
    }, [activeProfile?.id, user?.id]);

    // ── Publicación de posts programados (no hay evento de DB) ──
    // Un post programado solo "se publica" porque los feeds incluyen las filas
    // con scheduled_at <= now: la fila nunca cambia, así que no llega ningún
    // evento de Realtime y además, en el perfil propio, no hay suscripción a
    // posts. Se arma un timer local para el siguiente post programado y, al
    // vencer, se refresca el contenido: sale de "Programados" y aparece en su
    // tab normal.
    useEffect(() => {
        if (!isOwnProfile || !user?.id || scheduledPosts.length === 0) return;
        const MAX_DELAY = 24 * 60 * 60 * 1000;
        const nextTs = scheduledPosts
            .map((p) => new Date(p.scheduled_at).getTime())
            .filter((ts) => Number.isFinite(ts))
            .sort((a, b) => a - b)[0];
        if (!nextTs) return;
        const delay = nextTs - Date.now();
        const timer = setTimeout(() => {
            if (delay > MAX_DELAY) {
                // Espera más larga que el máximo de setTimeout: re-armar el timer
                // cambiando la identidad de la lista (el efecto se ejecuta otra vez).
                setScheduledPosts((prev) => [...prev]);
                return;
            }
            // Quitar de la lista los que ya vencieron y recargar posts + programados.
            setScheduledPosts((prev) =>
                prev.filter((p) => new Date(p.scheduled_at).getTime() > Date.now())
            );
            handlePostCreated();
        }, Math.max(0, Math.min(delay, MAX_DELAY)));
        return () => clearTimeout(timer);
    }, [isOwnProfile, user?.id, scheduledPosts, handlePostCreated]);

    const handlePostUpdate = useCallback((updatedPost) => {
        if (updatedPost._editing) {
            setEditingPost(updatedPost);
            setShowCreatePost(true);
            return;
        }
        setProfilePosts((prev) => {
            const updated = prev.map((p) =>
                p.id === updatedPost.id ? { ...p, ...updatedPost } : p
            );
            return [...updated].sort(sortProfilePosts);
        });
    }, []);

    const handlePostDelete = useCallback((postId) => {
        setProfilePosts((prev) => prev.filter((p) => p.id !== postId));
        setScheduledPosts((prev) => prev.filter((p) => p.id !== postId));
    }, []);

    // ── Sincronizar saved state desde PostCard ──
    const handleSaveToggle = useCallback((postId, nowSaved) => {
        // Actualizar savedPostIds inmediatamente (para icono bookmark en Posts tab)
        setSavedPostIds((prev) =>
            nowSaved ? [...prev, postId] : prev.filter((id) => id !== postId)
        );
        setLikedSavedIds((prev) =>
            nowSaved ? [...prev, postId] : prev.filter((id) => id !== postId)
        );
        // Refrescar la lista de guardados en background, incluyendo liked/reposted IDs
        if (user?.id && nowSaved) {
            (async () => {
                try {
                    const items = await getSavedPosts(user.id);
                    setSavedPosts(items);
                    if (items.length > 0) {
                        const postIds = items.map((p) => p.id);
                        const [likedIds, repostedIds] = await Promise.all([
                            getLikedPostIds(postIds, user.id),
                            getRepostedPostIds(postIds, user.id),
                        ]);
                        setSavedLikedIds(likedIds);
                        setSavedRepostedIds(repostedIds);
                        setCachedFeed(`saved_posts_${user.id}`, items, likedIds, repostedIds, []);
                    }
                } catch (err) {
                    console.warn('Error refreshing saved posts:', err);
                }
            })();
        } else if (user?.id && !nowSaved) {
            // Quitar de savedPosts sin refetch
            setSavedPosts((prev) => prev.filter((p) => p.id !== postId));
            // También remover el postId de savedLikedIds/savedRepostedIds
            setSavedLikedIds((prev) => prev.filter((id) => id !== postId));
            setSavedRepostedIds((prev) => prev.filter((id) => id !== postId));
        }
    }, [user?.id]);

    // ── Re-fetch counts when follow changes ──
    const handleFollowChange = useCallback(() => {
        if (activeProfile?.id) {
            getFollowCounts(activeProfile.id)
                .then((counts) => {
                    setFollowCounts(counts);
                    setCachedFollowCounts(activeProfile.id, counts);
                    setCountsLoading(false);
                })
                .catch((err) => {
                    console.warn("Error refreshing follow counts:", err);
                    setCountsLoading(false);
                });
        }
    }, [activeProfile?.id]);

    // ── Share profile (copia la URL al portapapeles) ──
    const handleShareProfile = async () => {
        const shareUrl = `${window.location.origin}/profile/${activeProfile?.username}`;
        try {
            await navigator.clipboard.writeText(shareUrl);
            toast.success(t('profile.share_copied') || 'Profile link copied!');
        } catch {
            // Fallback: seleccionar la URL manualmente
            const textarea = document.createElement('textarea');
            textarea.value = shareUrl;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            toast.success(t('profile.share_copied') || 'Profile link copied!');
        }
        setContextMenuOpen(false);
    };

    // ── Edit modal state (own profile only) ──
    const [showModal, setShowModal] = useState(false);
    const [modalUsername, setModalUsername] = useState("");
    const [modalBanner, setModalBanner] = useState("");
    const [modalAvatar, setModalAvatar] = useState("");
    const [modalBio, setModalBio] = useState("");
    const [modalSocialLinks, setModalSocialLinks] = useState([]);
    const [modalAccentColor, setModalAccentColor] = useState('');
    const [modalInterests, setModalInterests] = useState([]);
    const    [modalAccentColorSecondary, setModalAccentColorSecondary] = useState('');
    const [modalAccentSurface, setModalAccentSurface] = useState('');
    const [modalAccentSurfaceGlass, setModalAccentSurfaceGlass] = useState(false);
    const [modalProfileTextColor, setModalProfileTextColor] = useState('');
    const [usernameInput, setUsernameInput] = useState("");
    const [avatarInput, setAvatarInput] = useState("");
    const [bannerInput, setBannerInput] = useState("");
    // Ref para inicializar los inputs solo una vez (evita que Supabase Realtime los reseteé al cambiar de pestaña)
    const profileInitRef = useRef(false);

    useEffect(() => {
        if (isOwnProfile && ownProfile && !profileInitRef.current) {
            profileInitRef.current = true;
            setUsernameInput(ownProfile?.username || user?.user_metadata?.username || "");
            setAvatarInput(ownProfile?.avatar_url || "");
            setBannerInput(ownProfile?.banner_url || "");
            setModalSocialLinks(ownProfile?.social_links || []);
            setModalAccentColor(ownProfile?.accent_color || '');
            setModalAccentColorSecondary(ownProfile?.accent_color_secondary || '');
            setModalAccentSurface(ownProfile?.accent_surface_color || '');
            setModalAccentSurfaceGlass(ownProfile?.accent_surface_glass === true);
            setModalProfileTextColor(ownProfile?.profile_text_color || '');
        }
    }, [ownProfile, user, isOwnProfile]);

    // ── Nicknames (display name override from chat_nicknames, cache-first) ──
    const [nicknames, setNicknames] = useState(() => {
        if (user?.id) {
            const cached = getCachedNicknames(user.id);
            if (cached) return cached;
        }
        return {};
    });    useEffect(() => {
        if (!user?.id) return;
        getNicknames(user.id).then((map) => {
            setNicknames(map);
            cacheNicknames(user.id, map);
        }).catch(() => {});
    }, [user?.id]);



    // ── Nickname modal state (abierto desde el context menu) ──
    const [nicknameModalUser, setNicknameModalUser] = useState(null);

    const handleSavedNickname = useCallback((finalName) => {
        if (!nicknameModalUser?.id) return;
        setNicknames(prev => {
            const next = { ...prev };
            if (finalName) {
                next[nicknameModalUser.id] = finalName;
            } else {
                delete next[nicknameModalUser.id];
            }
            return next;
        });
        setNicknameModalUser(null);
    }, [nicknameModalUser]);

    // ── Block/unblock (confirmación solo al bloquear) ──
    const handleBlockToggle = useCallback(async () => {
        if (!user?.id || !activeProfile?.id) return;
        setBlockLoading(true);
        try {
            if (isBlockedByMe) {
                await unblockUser(user.id, activeProfile.id);
                setIsBlockedByMeDb(false);
                cacheBlockStatus(user.id, activeProfile.id, false);
            } else {
                await blockUser(user.id, activeProfile.id);
                // Auto-unfollow: ambos sentidos via RPC (bypass RLS)
                try {
                    await unfollowBothWays(user.id, activeProfile.id);
                    setIsFollower(false);
                    setCachedFollowStatus(user.id, activeProfile.id, false);
                    setIsFollowedBy(false);
                    setCachedFollowStatus(activeProfile.id, user.id, false);
                } catch (e) {
                    console.warn('Could not unfollow both ways on block:', e);
                }
                // Refrescar follow counts despues de anular seguimiento
                try {
                    const counts = await getFollowCounts(activeProfile.id);
                    setFollowCounts(counts);
                    setCachedFollowCounts(activeProfile.id, counts);
                    setCountsLoading(false);
                } catch (e) {
                    console.warn('Could not refresh follow counts after block:', e);
                }
                setIsBlockedByMeDb(true);
                cacheBlockStatus(user.id, activeProfile.id, true);
            }
            setContextMenuOpen(false);
        } catch (err) {
            console.error('Block/unblock error:', err);
        } finally {
            setBlockLoading(false);
        }
    }, [user?.id, activeProfile?.id, isBlockedByMe]);

    const getDisplayName = (otherProfile) => {
        if (!otherProfile) return t('common.unknown');
        const nick = nicknames[otherProfile.id];
        return nick || otherProfile.displayname || otherProfile.username || t('common.unknown');
    };

    const avatarUrl = activeProfile?.avatar_url || null;
    const bannerUrl = activeProfile?.banner_url || null;
    const rawDisplayName =
        activeProfile?.displayname ||
        activeProfile?.username ||
        user?.user_metadata?.display_name ||
        user?.user_metadata?.displayname ||
        user?.user_metadata?.username ||
        user?.email?.split("@")[0] ||
        "Guest";
    const profileDisplayName = isOwnProfile
        ? rawDisplayName
        : (getDisplayName(activeProfile) || rawDisplayName);

    const roles = activeProfile?.roles || ["user"];

    // ── Filter roles based on badges_visibility (sin useMemo para evitar hooks tras early returns) ──
    const badgeTypes = ['admin', 'dev', 'mod', 'partner', 'verified'];
    const badgesVisibility = activeProfile?.badges_visibility || {};
    const visibleRoles = roles.filter(r => r === 'user' || !badgeTypes.includes(r) || badgesVisibility[r] !== false);

    // ── Save profile (own profile only) ──
    const handleSaveProfile = async ({ username, displayname, avatar_url, banner_url, banner_credits, avatar_credits, bio, pronouns, social_links, accent_color, accent_color_secondary, accent_surface_color, accent_surface_glass, interests, banner_position, avatar_position, profile_background_url, profile_background_position, profile_background_blur, profile_background_dim, banner_dim, profile_text_color }) => {
        if (!user?.id) return;

        const normalizedUsername = (username || "").trim().toLowerCase();
        if (!normalizedUsername || normalizedUsername.length < USERNAME_MIN) {
            toast.error(t('profile.username_short'));
            return;
        }
        if (!USERNAME_RE.test(normalizedUsername)) {
            toast.error(t('auth.username_invalid_chars') || 'Username can only contain letters, numbers and underscores');
            return;
        }
        if (normalizedUsername.length > USERNAME_MAX) {
            toast.error(t('auth.username_length') || `Username must be between ${USERNAME_MIN} and ${USERNAME_MAX} characters`);
            return;
        }

        try {
            if (normalizedUsername !== ownProfile?.username) {
                const available = await isUsernameAvailable(normalizedUsername, user.id);
                if (!available) {
                    toast.error(t('profile.username_taken'));
                    return;
                }
            }

            const updates = {
                displayname: displayname || null,
                avatar_url: avatar_url || null,
                avatar_position: avatar_position || null,
                banner_url: banner_url || null,
                banner_position: banner_position || null,
                banner_credits: banner_credits || null,
                avatar_credits: avatar_credits || null,
                bio: bio || null,
                pronouns: pronouns || null,
                social_links: social_links || [],
                accent_color: accent_color || null,
                accent_color_secondary: accent_color_secondary || null,
                accent_surface_color: accent_surface_color || null,
                accent_surface_glass: accent_surface_glass ?? false,
                interests: interests || [],

                profile_background_url: profile_background_url || null,
                profile_background_position: profile_background_position || '50% 50%',
                profile_background_blur: profile_background_blur ?? 0,
                profile_background_dim: profile_background_dim ?? 50,
                banner_dim: banner_dim ?? 50,
                profile_text_color: profile_text_color || null,
            };

            if (normalizedUsername !== ownProfile?.username) {
                updates.username = normalizedUsername;
            }

            await updateUserProfile(user.id, updates);

            if (normalizedUsername !== ownProfile?.username) {
                try {
                    await updateAuthUserMetadata({
                        username: normalizedUsername,
                        display_name: normalizedUsername,
                    });
                } catch (authErr) {
                    toast.error(t('profile.username_auth_error'));
                    console.error(authErr);
                    return;
                }
            }

            setUsernameInput(normalizedUsername);
            setAvatarInput(avatar_url || null);
            setBannerInput(banner_url || null);

            await refreshProfile(user.id);
            toast.success(t('profile.updated'));
            setShowModal(false);

            // If username changed, navigate to the new profile URL
            if (normalizedUsername !== ownProfile?.username) {
                // Limpiar cache de posts y resetear estado para forzar refetch
                clearFeedCache(`profile_posts_${user.id}`);
                setProfilePosts([]);
                setPostsLoading(true);
                navigate(`/profile/${normalizedUsername}`, { replace: true });
            }
        } catch (err) {
            toast.error(err.message || t('profile.error_generic'));
        }
    };

    // ── Filtered posts (all vs only reposts) ──
    const filteredProfilePosts = useMemo(() => {
        if (postSubFilter === 'reposts') return profilePosts.filter(p => p._repostInfo);
        return profilePosts;
    }, [profilePosts, postSubFilter]);

    // ── Virtualización: la lista se renderiza por VirtualPostList (solo monta cards visibles) ──

    // ── repostInfo memoizado por post (identidad estable → React.memo de PostCard) ──
    const repostInfoByPostId = useMemo(() => {
        const map = new Map();
        for (const post of profilePosts) {
            if (post._repostInfo) {
                map.set(post.id, { ...post._repostInfo, repostedBy: activeProfile?.username });
            }
        }
        return map;
    }, [profilePosts, activeProfile?.username]);

    // ── Replies: posts sintéticos (comentario como card) + replyInfo por id de comentario ──
    // Identidad estable (useMemo) para que React.memo de PostCard salte re-renders
    // al scrollear. getKey en VirtualPostList resuelve por commentId (varias
    // replies al mismo post comparten post_id → no pueden usar post.id como key).
    const repliesPosts = useMemo(() => replies.map((reply) => ({
        id: reply.post_id,
        commentId: reply.id,
        content: reply.content,
        image_urls: reply.image_url ? [reply.image_url] : [],
        image_url: null,
        video_url: reply.video_url,
        likes_count: reply.comment_likes_count || 0,
        dislikes_count: reply.comment_dislikes_count || 0,
        created_at: reply.created_at,
        user_id: reply.profiles?.id || reply.user_id,
        profiles: reply.profiles,
    })), [replies]);

    const replyInfoByPostId = useMemo(() => {
        const map = new Map();
        for (const reply of replies) {
            map.set(reply.id, {
                commentId: reply.id,
                replyTo: reply.posts?.profiles?.username || t('common.unknown'),
            });
        }
        return map;
    }, [replies, t]);

    // ── Extract body background vars early (must be before early returns for hook ordering) ──
    const bgUrl = activeProfile?.profile_background_url;
    const bgDim = (activeProfile?.profile_background_dim ?? 50) / 100;
    const hasBg = !!bgUrl;
    const ownerShowAccentProfile = isOwnProfile
      ? true
      : (activeProfile?.show_accent_profile ?? true);
    const ownerAccentVisibility = isOwnProfile
      ? accentVisibility
      : (activeProfile?.accent_visibility ?? 'both');
    const accentVisible = showAccent && ownerShowAccentProfile && (
      ownerAccentVisibility === 'both' ||
      (ownerAccentVisibility === 'me' && isOwnProfile) ||
      (ownerAccentVisibility === 'others' && !isOwnProfile)
    );

    // ── Parse background position for ::before styling ──
    let bgPos = 'center center';
    let bgSize = 'cover';
    try {
      const p = JSON.parse(activeProfile?.profile_background_position || '{}');
      bgPos = `${p.x ?? 50}% ${p.y ?? 50}%`;
      bgSize = `${Math.max(p.zoom ?? 1, 1.05) * 100}%`;
    } catch {}
    const bgBlur = activeProfile?.profile_background_blur ?? 0;

    const bgVars = hasBg ? {
      '--profile-bg-image': `url(${bgUrl})`,
      '--profile-bg-position': bgPos,
      '--profile-bg-size': bgSize,
      '--profile-bg-blur': `${bgBlur}px`,
    } : {};

    // ── Render ──
    if (!isAuthenticated && !profileUsername) {
        return <p>{t('profile.login.error')}</p>;
    }

    if (profileError) {
        return (
            <div className="profile-page">
                <div className="profile-card" style={{ padding: "40px", textAlign: "center" }}>
                    <p style={{ color: "#6b7280", fontSize: "1.1rem" }}>{profileError}</p>
                </div>
            </div>
        );
    }

    // ── Mostrar skeleton hasta que auth haya resuelto (evita flash de contenido no bloqueado) ──
    if (!isOwnProfile && (viewedProfileLoading || (loading && activeProfile))) {
        return (
            <div className="profile-page">
                <div className="profile-card profile-skeleton-card">
                    <div className="profile-banner-container">
                        <div className="skeleton profile-skeleton-banner" />
                        <div className="skeleton skeleton--circle profile-skeleton-avatar" />
                        <div className="profile-skeleton-info">
                            <div className="skeleton profile-skeleton-username" />
                            <div className="profile-skeleton-stats">
                                <div className="skeleton profile-skeleton-stat" />
                                <div className="skeleton profile-skeleton-stat" />
                            </div>
                            <div className="skeleton profile-skeleton-bio" />
                            <div className="skeleton profile-skeleton-btn" />
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // ── Si el perfil nos ha bloqueado, mostrar mensaje ──
  if (!isOwnProfile && isBlockedByThem) {
    return (
      <div className="profile-page">
        <div className="profile-blocked-card">
          <div className="profile-blocked-icon"><FaBan /></div>
          <h2 className="profile-blocked-title">{t('block.you_are_blocked_title', { user: activeProfile?.username })}</h2>
          <p className="profile-blocked-desc">{t('block.you_are_blocked_desc')}</p>
        </div>
      </div>
    );
  }

    if (!activeProfile) return null;

    const surfColor = activeProfile?.accent_surface_color;
    const surfGlass = activeProfile?.accent_surface_glass === true;

    const styleVars = {
      ...bgVars,
      ...(accentVisible ? {
          ...(activeProfile?.accent_color ? {
            '--accent-color': activeProfile.accent_color,
            '--accent-color-2': activeProfile?.accent_color_secondary || activeProfile.accent_color,
            '--accent-text-color': activeProfile?.profile_text_color || 'var(--color-text, #ffffff)',
          } : {}),
          '--accent-surface-color': surfColor || null,
          // ── Text colors — controlled by profile_text_color when set ──
          '--accent-surface-text-color': activeProfile?.profile_text_color
            ? activeProfile.profile_text_color
            : 'var(--color-text, #ffffff)',
          '--accent-surface-text-secondary': activeProfile?.profile_text_color
            ? activeProfile.profile_text_color
            : 'var(--color-text-secondary, #9ca3af)',
          '--accent-surface-text-muted': activeProfile?.profile_text_color
            ? activeProfile.profile_text_color
            : 'var(--color-text-muted, #6b7280)',
          ...(surfGlass ? {
            '--accent-surface-rgba': 'rgba(255, 255, 255, 0.04)',
            '--accent-surface-rgba-hover': 'rgba(255, 255, 255, 0.07)',
            '--accent-surface-blur': 'blur(20px)',
            '--accent-surface-border': 'none',
          } : surfColor ? {
            '--accent-surface-rgba': surfColor,
            '--accent-surface-rgba-hover': `color-mix(in srgb, ${surfColor} 85%, #000)`,
            '--accent-surface-blur': 'none',
            '--accent-surface-border': 'none',
          } : {
            '--accent-surface-rgba': 'var(--color-surface, #1a1a1a)',
            '--accent-surface-rgba-hover': 'var(--color-surface-hover, #252525)',
            '--accent-surface-blur': 'none',
          }),
          // ── Banner dim vars (still needed for banner overlay gradient) ──
          '--banner-dim-top': String((activeProfile?.banner_dim ?? 50) / 100 * 0.6),
          '--banner-dim-bottom': String(Math.min((activeProfile?.banner_dim ?? 50) / 100 * 1.3, 1.0)),
          '--profile-accent-opacity': hasBg ? '8%' : '18%',
          // ── Profile text color (user-configurable) ──
          ...(activeProfile?.profile_text_color ? {
            '--profile-text-color': activeProfile.profile_text_color,
          } : {}),
          // ── When text is dark (light bg detected), use dark overlays so pills/buttons are visible ──
          ...((!surfGlass && surfColor ? getContrastText(surfColor) : hasBg ? autoBgContrastColor : null) === '#111111' ? {
            '--overlay-bg-subtle': 'rgba(0, 0, 0, 0.06)',
            '--overlay-bg-hover': 'rgba(0, 0, 0, 0.12)',
            '--overlay-bg-active': 'rgba(0, 0, 0, 0.16)',
            '--overlay-bg': 'rgba(0, 0, 0, 0.08)',
          } : {}),
        } : {}),
    };

    return (            <div className="profile-page" style={styleVars}>
            {/* ── Dim & blur overlay for profile background (imagen vía .profile-page::before) ── */}
            {hasBg && (
              <div
                style={{
                  position: 'fixed',
                  inset: 0,
                  background: `linear-gradient(rgba(0,0,0,${bgDim}), rgba(0,0,0,${bgDim}))`,
                  pointerEvents: 'none',
                  zIndex: -1,
                }}
              />
            )}
            <div className="profile-card">                        <div className="profile-banner-container">
                    {bannerUrl ? (
                        <>
                        <img
                            className="profile-banner"
                            src={bannerUrl}
                            alt="Profile Banner"
                            style={getImageStyle(activeProfile?.banner_position)}
                        />
                        {/* ── Credits overlay (banner + avatar) ── */}
                        {(activeProfile?.banner_credits || activeProfile?.avatar_credits) && (
                          <div className="profile-banner-credits">
                            {activeProfile?.banner_credits && (
                              <>
                                <span
                                  className="profile-banner-credits-label"
                                  onClick={(e) => { e.stopPropagation(); setShowBannerCredits((s) => !s); }}
                                  role="button"
                                  tabIndex={0}
                                  onKeyDown={(e) => { if (e.key === 'Enter') setShowBannerCredits((s) => !s); }}
                                >
                                  {t('profile.credits_banner') || 'Banner'}
                                </span>
                                <span className={`profile-banner-credits-text ${!showBannerCredits ? 'profile-banner-credits-text--hidden' : ''}`}>
                                  {activeProfile.banner_credits}
                                </span>
                              </>
                            )}
                            {activeProfile?.avatar_credits && (
                              <>
                                <span
                                  className="profile-banner-credits-label"
                                  onClick={(e) => { e.stopPropagation(); setShowAvatarCredits((s) => !s); }}
                                  role="button"
                                  tabIndex={0}
                                  onKeyDown={(e) => { if (e.key === 'Enter') setShowAvatarCredits((s) => !s); }}
                                >
                                  {t('profile.credits_avatar') || 'Avatar'}
                                </span>
                                <span className={`profile-banner-credits-text ${!showAvatarCredits ? 'profile-banner-credits-text--hidden' : ''}`}>
                                  {activeProfile.avatar_credits}
                                </span>
                              </>
                            )}
                          </div>
                        )}
                        </>
                    ) : (
                        <div className="profile-banner profile-banner--placeholder">
                            {t('profile.no_banner')}
                        </div>
                    )}

                    <div className="profile-avatar-container">
                        <Avatar
                            src={avatarUrl}
                            alt="User Avatar"
                            className="profile-avatar"
                            style={getImageStyle(activeProfile?.avatar_position)}                             status={isOwnProfile ? myStatus : (isFollower === true && isFollowedBy === true ? (contextStatus ?? profileStatus) : null)}
                        />
                    </div>

                    <div className="profile-user-info">
                        <div className="profile-username">
                            <span>{profileDisplayName} <span style={{ fontSize: '0.78rem', fontWeight: 400, opacity: 0.55, verticalAlign: 'middle' }}>· @{activeProfile?.username || user?.user_metadata?.username || ''}</span></span>
                            {showBadges && <Badge roles={visibleRoles} />}
                        </div>

                        {!isOwnProfile && isBlockedByMe ? (
                          <div className="profile-stats">
                            <span className="profile-stat profile-stat--blocked">
                              <FaBan className="profile-stat-ban" />
                              <span className="profile-stat-label">{t('block.stats_hidden')}</span>
                            </span>
                          </div>
                        ) : (
                          <>
                        <div className="profile-stats">
                            {canViewContent ? (
                              <>
                                <button
                                  type="button"
                                  className="profile-stat profile-stat--clickable"
                                  onClick={() => openFollowersModal("followers")}
                                >
                                  {countsLoading || followCounts === null ? (
                                    <span className="profile-stat-skeleton" />
                                  ) : (
                                    <span className="profile-stat-value">{followCounts.followers}</span>
                                  )}
                                  <span className="profile-stat-label">{t('profile.followers')}</span>
                                </button>
                                <button
                                  type="button"
                                  className="profile-stat profile-stat--clickable"
                                  onClick={() => openFollowersModal("following")}
                                >
                                  {countsLoading || followCounts === null ? (
                                    <span className="profile-stat-skeleton" />
                                  ) : (
                                    <span className="profile-stat-value">{followCounts.following}</span>
                                  )}
                                  <span className="profile-stat-label">{t('profile.following')}</span>
                                </button>
                                {!isOwnProfile && isFollowedBy === true && (
                                  <span className="profile-follows-you-badge">{t('profile.follows_you')}</span>
                                )}
                              </>
                            ) : (
                              <span className="profile-stat profile-stat--private">
                                <FaLock className="profile-stat-lock" />
                                <span className="profile-stat-label">{t('profile.private_profile')}</span>
                              </span>
                            )}
                        </div>

                        {activeProfile?.bio ? (
                            <p className="profile-bio">{activeProfile.bio}{activeProfile?.pronouns && <span style={{ fontSize: '0.75rem', fontWeight: 400, opacity: 0.5 }}> · {activeProfile.pronouns}</span>}</p>
                        ) : activeProfile?.pronouns ? (
                            <p className="profile-bio" style={{ opacity: 0.5 }}>{activeProfile.pronouns}</p>
                        ) : (
                            <p className="profile-bio profile-bio--empty">{t('profile.no_bio')}</p>
                        )}

                        {/* ── Mobile social links trigger ("..." after bio) ── */}
                        {activeProfile?.social_links?.length > 0 && (
                            <button
                                type="button"
                                className="profile-social-links-trigger"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setSocialLinksModal(true);
                                }}
                                aria-label={t('profile.social_links') || 'Social links'}
                            >
                                <FaEllipsisH />
                            </button>
                        )}

                        {/* ── Social Links (max 3, then "+N" modal) ── */}
                        {activeProfile?.social_links?.length > 0 && (
                            <div className="profile-social-links">
                                {activeProfile.social_links.slice(0, 3).map((link, i) => (
                                    <Tooltip key={link.url} text={getPlatformName(link.platform)}>
                                    <a
                                        href={sanitizeUrl(link.url)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="profile-social-link"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <span className="profile-social-icon">{React.createElement(getPlatformIcon(link.platform))}</span>
                                    </a>
                                    </Tooltip>
                                ))}
                                {activeProfile.social_links.length > 3 && (
                                    <button
                                        type="button"
                                        className="profile-social-link profile-social-link--more"
                                        title={t('profile.show_more', { count: activeProfile.social_links.length - 3 })}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSocialLinksModal(true);
                                        }}
                                    >
                                        <span className="profile-social-icon">+{activeProfile.social_links.length - 3}</span>
                                    </button>
                                )}
                            </div>
                        )}
                        </>
                        )}

                        <div className="profile-actions">                            {isOwnProfile ? (<>
                                 <button
                                    type="button"
                                    className="profile-edit-button"
                                    onClick={() => {
                                        setModalUsername(usernameInput || ownProfile?.username || "");
                                        setModalAvatar(avatarInput || ownProfile?.avatar_url || "");
                                        setModalBanner(bannerInput || ownProfile?.banner_url || "");
                                        setModalBio(ownProfile?.bio || "");
                                        setModalSocialLinks(ownProfile?.social_links || []);
                                        setModalAccentColor(ownProfile?.accent_color || '');
                                        setModalAccentColorSecondary(ownProfile?.accent_color_secondary || '');
                                        setModalAccentSurface(ownProfile?.accent_surface_color || '');
                                        setModalAccentSurfaceGlass(ownProfile?.accent_surface_glass === true);
                                        setModalInterests(ownProfile?.interests || []);
                                        setModalProfileTextColor(ownProfile?.profile_text_color || '');
                                        setShowModal(true);
                                    }}
                                >
                                    <span className="profile-edit-label">{t('profile.edit')}</span>
                                </button>
                                {/* ── 3-dots context menu (own profile) ── */}
                                {user && (
                                  <div className="profile-actions-menu" ref={contextMenuRef}>
                                    <button
                                      type="button"
                                      className="profile-actions-menu-btn"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        setDropdownStyle({
                                          position: 'fixed',
                                          top: `${rect.bottom + 6}px`,
                                          right: `${window.innerWidth - rect.right}px`,
                                          zIndex: 9999,
                                        });
                                        setContextMenuOpen((s) => !s);
                                      }}
                                      aria-label="More actions"
                                    >
                                      <FaEllipsisH />
                                    </button>
                                  </div>
                                )}
                                </>
                            ) : (<>
                                <FollowButton
                                    targetUserId={activeProfile.id}
                                    isPrivate={isPrivate}
                                    onFollowChange={(action) => {
                                        handleFollowChange();
                                        if (action === 'follow') {
                                            setIsFollower(true);
                                            setCachedFollowStatus(user.id, activeProfile.id, true);
                                        } else if (action === 'unfollow') {
                                            setIsFollower(false);
                                            setCachedFollowStatus(user.id, activeProfile.id, false);
                                        }
                                    }}
                                />
                                {/* Abrir chat con esta persona: el Chat lo recibe por
                                    URL (?u=) y usa una conversación pendiente, así no se
                                    crea nada en la base hasta enviar el primer mensaje. */}
                                {user && !isBlockedByMe && (
                                    <Tooltip text={t('profile.message_btn')}>
                                        <button
                                            type="button"
                                            className="profile-message-btn"
                                            onClick={() => navigate(`/Chat?u=${activeProfile.id}`)}
                                            aria-label={t('profile.message_btn')}
                                        >
                                            <FaCommentDots aria-hidden="true" />
                                        </button>
                                    </Tooltip>
                                )}
                                {/* ── 3-dots context menu ── */}
                                {user && (
                                  <div className="profile-actions-menu" ref={contextMenuRef}>
                                    <button
                                      type="button"
                                      className="profile-actions-menu-btn"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        setDropdownStyle({
                                          position: 'fixed',
                                          top: `${rect.bottom + 6}px`,
                                          right: `${window.innerWidth - rect.right}px`,
                                          zIndex: 9999,
                                        });
                                        setContextMenuOpen((s) => !s);
                                      }}
                                      aria-label="More actions"
                                    >
                                      <FaEllipsisH />
                                    </button>
                                  </div>
                                )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Context Menu Dropdown (fuera de .profile-card para evitar overflow clipping) ── */}
            {contextMenuOpen && dropdownStyle && createPortal(
              <div className="fc-dropdown" ref={dropdownRef} style={dropdownStyle} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="fc-dropdown-btn"
                  onClick={handleShareProfile}
                >
                  <FaShareAlt />
                  {t('profile.share_profile') || 'Share profile'}
                </button>
                {isOwnProfile && (
                  <>
                    <div className="fc-dropdown-divider" />
                    <div className="fc-dropdown-label">{t('status.set_status') || 'Set status'}</div>
                    <button
                      type="button"
                      className={`fc-dropdown-btn ${myStatus === 'online' ? 'fc-dropdown-btn--active' : ''}`}
                      onClick={() => { setMyStatus('online'); setContextMenuOpen(false); }}
                    >
                      <span className="fc-dropdown-status-dot fc-dropdown-status-dot--online" />
                      {t('status.set_online') || 'Online'}
                    </button>
                    <button
                      type="button"
                      className={`fc-dropdown-btn ${myStatus === 'idle' ? 'fc-dropdown-btn--active' : ''}`}
                      onClick={() => { setMyStatus('idle'); setContextMenuOpen(false); }}
                    >
                      <span className="fc-dropdown-status-dot fc-dropdown-status-dot--idle" />
                      {t('status.set_idle') || 'Idle'}
                    </button>
                    <button
                      type="button"
                      className={`fc-dropdown-btn ${myStatus === 'dnd' ? 'fc-dropdown-btn--active' : ''}`}
                      onClick={() => { setMyStatus('dnd'); setContextMenuOpen(false); }}
                    >
                      <span className="fc-dropdown-status-dot fc-dropdown-status-dot--dnd" />
                      {t('status.set_dnd') || 'Do Not Disturb'}
                    </button>
                  </>
                )}
                {!isOwnProfile && (
                  <button
                    type="button"
                    className="fc-dropdown-btn"
                    onClick={() => {
                      setNicknameModalUser({ ...activeProfile, followerCount: followCounts?.followers || 0 });
                      setContextMenuOpen(false);
                    }}
                  >
                    <FaTag />
                    {nicknames[activeProfile.id] ? (t('chat.edit_nickname') || 'Edit nickname') : (t('chat.set_nickname') || 'Set nickname')}
                  </button>
                )}
                {!isOwnProfile && (
                  <button
                    type="button"
                    className="fc-dropdown-btn"
                    onClick={() => {
                      if (isBlockedByMe) {
                        // Desbloquear no requiere confirmación
                        handleBlockToggle();
                      } else {
                        setContextMenuOpen(false);
                        setConfirmBlock(true);
                      }
                    }}
                    disabled={blockLoading}
                  >
                    <FaBan />
                    {isBlockedByMe ? t('block.unblock') : t('block.block')}
                  </button>
                )}
              </div>,
              document.body
            )}

            {/* Edit modal (always mounted, visibility via isOpen) */}
            <Modal
                    isOpen={isOwnProfile && showModal}
                    onClose={() => setShowModal(false)}
                    onSave={handleSaveProfile}
                    initialUsername={modalUsername}
                    initialDisplayname={ownProfile?.displayname || ''}
                    initialAvatar={getCdnUrl(modalAvatar) || ''}
                    initialBanner={getCdnUrl(modalBanner) || ''}
                    initialBio={modalBio}
                    initialSocialLinks={modalSocialLinks}
                    initialAccentColor={modalAccentColor}
                    initialAccentColorSecondary={modalAccentColorSecondary}
                    initialAccentSurface={modalAccentSurface}
                    initialAccentSurfaceGlass={modalAccentSurfaceGlass}
                    initialInterests={modalInterests}
                    initialBannerPosition={ownProfile?.banner_position || '50% 50%'}
                    initialAvatarPosition={ownProfile?.avatar_position || '50% 50%'}

                    initialBannerCredits={ownProfile?.banner_credits || ''}
                    initialAvatarCredits={ownProfile?.avatar_credits || ''}                      
                    initialProfileBg={getCdnUrl(ownProfile?.profile_background_url || '')}
                    initialProfileBgPosition={ownProfile?.profile_background_position || '50% 50%'}
                    initialProfileBgBlur={ownProfile?.profile_background_blur ?? 0}
                    initialProfileBgDim={ownProfile?.profile_background_dim ?? 50}
                    initialBannerDim={ownProfile?.banner_dim ?? 50}
                    initialPronouns={ownProfile?.pronouns || ''}
                    initialProfileTextColor={modalProfileTextColor}
                    initialFollowersCount={followCounts?.followers || 0}
                    userRoles={roles}
                />
            {/* Followers/Following modal (always mounted, visibility via isOpen) */}
            <FollowersModal
                    isOpen={followersModal.open}
                    userId={activeProfile.id}
                    type={followersModal.type}
                    onClose={closeFollowersModal}
            />

            {/* Social Links modal */}
            {activeProfile && (
                <ModalShell isOpen={socialLinksModal} onClose={() => setSocialLinksModal(false)} onEscape={() => setSocialLinksModal(false)} className="social-links-modal">
                    <div className="followers-modal-header">
                        <h3 className="fc-modal-title">{t('modal.social_links')}</h3>
                        <button
                            type="button"
                            className="followers-modal-close"
                            onClick={() => setSocialLinksModal(false)}
                            aria-label={t('common.close')}
                        >
                            ×
                        </button>
                    </div>
                    <div className="social-links-modal-list">
                        {activeProfile.social_links.map((link, i) => (
                            <a
                                key={link.url}
                                href={sanitizeUrl(link.url)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="social-links-modal-item"
                                onClick={() => setSocialLinksModal(false)}
                            >
                                <span className="social-links-modal-icon">{React.createElement(getPlatformIcon(link.platform))}</span>
                                <div className="social-links-modal-info">
                                    <span className="social-links-modal-platform">{getPlatformName(link.platform)}</span>
                                    <span className="social-links-modal-url">{link.url}</span>
                                </div>
                            </a>
                        ))}
                    </div>
                </ModalShell>
            )}

            {/* ── Posts Section ── */}
            {!isOwnProfile && isBlockedByMe ? null : !canViewContent ? (
              <div className="posts-section posts-section--private">
                <div className="posts-empty">
                  <span className="posts-empty-icon"><FaLock /></span>
                  <p className="posts-empty-text">{t('profile.private_posts_hidden')}</p>
                  <p className="posts-empty-subtext">{t('profile.private_posts_hint')}</p>
                </div>
              </div>
            ) : (
            <div className="posts-section">
                <div className="posts-section-header">
                    <div className="posts-section-tabs">
                        <div className="posts-section-tab-with-dropdown" ref={postFilterRef}>
                            <button
                                className={`posts-section-tab ${tab === 'posts' ? 'posts-section-tab--active' : ''}`}
                                onClick={(e) => {
                                    setTab('posts');
                                    if (tab === 'posts') {
                                        e.stopPropagation();
                                        const parentRect = postFilterRef.current?.getBoundingClientRect();
                                        if (parentRect) {
                                            setPostFilterDropdownStyle({
                                                position: 'fixed',
                                                top: `${parentRect.bottom + 4}px`,
                                                left: `${parentRect.left}px`,
                                                zIndex: 9999,
                                            });
                                        }
                                        setPostFilterOpen(prev => !prev);
                                    }
                                }}
                            >
                                {postSubFilter === 'reposts' ? t('profile.filter_reposts') : t('profile.posts_tab')}
                                {tab === 'posts' && (
                                    <span
                                        className={`posts-tab-filter-toggle ${postFilterOpen ? 'posts-tab-filter-toggle--open' : ''}`}
                                    >
                                        <FaChevronDown />
                                    </span>
                                )}
                            </button>
                            {tab === 'posts' && postFilterOpen && postFilterDropdownStyle && createPortal(
                                <div
                                    ref={postFilterDropdownRef}
                                    className="posts-tab-filter-dropdown"
                                    style={postFilterDropdownStyle}
                                >
                                    <button
                                        className={`posts-tab-filter-item ${postSubFilter === 'all' ? 'posts-tab-filter-item--active' : ''}`}
                                        onClick={() => { setPostSubFilter('all'); setPostFilterOpen(false); }}
                                    >
                                        {t('profile.filter_all')}
                                    </button>
                                    <button
                                        className={`posts-tab-filter-item ${postSubFilter === 'reposts' ? 'posts-tab-filter-item--active' : ''}`}
                                        onClick={() => { setPostSubFilter('reposts'); setPostFilterOpen(false); }}
                                    >
                                        <FaRetweet style={{ fontSize: '0.72rem' }} />
                                        {t('profile.filter_reposts')}
                                    </button>
                                </div>,
                                document.body
                            )}
                        </div>
                        {(isOwnProfile || activeProfile?.show_likes) && (
                            <button
                                className={`posts-section-tab ${tab === 'likes' ? 'posts-section-tab--active' : ''}`}
                                onClick={() => setTab('likes')}
                            >
                                {t('profile.likes_tab')}
                            </button>
                        )}
                        {isOwnProfile && (
                            <button
                                className={`posts-section-tab ${tab === 'saved' ? 'posts-section-tab--active' : ''}`}
                                onClick={() => setTab('saved')}
                            >
                                {t('profile.saved_tab')}
                            </button>
                        )}
                        {isOwnProfile && (
                            <button
                                className={`posts-section-tab ${tab === 'scheduled' ? 'posts-section-tab--active' : ''}`}
                                onClick={() => setTab('scheduled')}
                            >
                                {t('profile.scheduled_tab') || 'Programados'}
                            </button>
                        )}
                        <button
                            className={`posts-section-tab ${tab === 'replies' ? 'posts-section-tab--active' : ''}`}
                            onClick={() => setTab('replies')}
                        >
                            {t('profile.replies_tab')}
                        </button>
                    </div>
                    {isOwnProfile && (
                        <button
                            className="posts-section-action"
                            onClick={() => {
                                setEditingPost(null);
                                setShowCreatePost(true);
                            }}
                        >
                            <FaPlus />
                            {t('profile.new_post')}
                        </button>
                    )}
                </div>

                {tab === 'posts' ? (
                    postsLoading ? (
                        <div className="posts-skeleton">
                            {[1, 2, 3].map((i) => (
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
                    ) : profilePosts.length === 0 ? (
                        <div className="posts-empty">
                            <span className="posts-empty-icon"><FaFeather /></span>
                            <p className="posts-empty-text">
                                {isOwnProfile
                                    ? t('profile.no_posts_own')
                                    : t('profile.no_posts_other')}
                            </p>
                        </div>
                    ) : filteredProfilePosts.length === 0 ? (
                        <div className="posts-empty">
                            <span className="posts-empty-icon"><FaRetweet /></span>
                            <p className="posts-empty-text">{t('profile.no_reposts') || 'No hay reposts'}</p>
                        </div>
                    ) : (
                        <VirtualPostList
                            posts={filteredProfilePosts}
                            likedIds={likedPostIds}
                            dislikedIds={dislikedPostIds}
                            repostedIds={repostedPostIds}
                            savedIds={savedPostIds}
                            repostInfoByPostId={repostInfoByPostId}
                            onUpdate={handlePostUpdate}
                            onDelete={handlePostDelete}
                            onSaveToggle={handleSaveToggle}
                            onLikeToggle={handleLikeToggle}
                            onDislikeToggle={handleDislikeToggle}
                            onRepostToggle={handleRepostToggle}
                        />
                    )
                ) : tab === 'saved' ? (
                    savedPostsLoading ? (
                        <div className="posts-skeleton">
                            {[1, 2, 3].map((i) => (
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
                    ) : savedPosts.length === 0 ? (
                        <div className="posts-empty">
                            <span className="posts-empty-icon"><FaBookmark /></span>
                            <p className="posts-empty-text">
                                {t('profile.no_saved')}
                            </p>
                            <p className="posts-empty-subtext">
                                {t('profile.no_saved_sub')}
                            </p>
                        </div>
                    ) : (
                            <VirtualPostList
                                posts={savedPosts}
                                likedIds={savedLikedIds}
                                dislikedIds={savedDislikedIds}
                                repostedIds={savedRepostedIds}
                                savedIds={savedPosts.map((p) => p.id)}
                                onUpdate={handlePostUpdate}
                                onDelete={handlePostDelete}
                                onSaveToggle={handleSaveToggle}
                                onLikeToggle={handleLikeToggle}
                                onDislikeToggle={handleDislikeToggle}
                                onRepostToggle={handleRepostToggle}
                            />
                        )
                ) : tab === 'likes' ? (
                    likedPostsLoading ? (
                        <div className="posts-skeleton">
                            {[1, 2, 3].map((i) => (
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
                    ) : likedPosts.length === 0 ? (
                        <div className="posts-empty">
                            <span className="posts-empty-icon"><FaHeart /></span>
                            <p className="posts-empty-text">
                                {isOwnProfile
                                    ? t('profile.no_likes')
                                    : t('profile.no_likes_other')}
                            </p>
                            <p className="posts-empty-subtext">
                                {isOwnProfile
                                    ? t('profile.no_likes_sub')
                                    : t('profile.no_likes_sub_other')}
                            </p>
                        </div>
                    ) : (isOwnProfile || activeProfile?.show_likes) && (
                            <VirtualPostList
                                posts={likedPosts}
                                likedIds={likedLikedIds}
                                dislikedIds={likedDislikedIds}
                                repostedIds={likedRepostedIds}
                                savedIds={likedSavedIds}
                                onUpdate={handlePostUpdate}
                                onDelete={handlePostDelete}
                                onSaveToggle={handleSaveToggle}
                                onLikeToggle={handleLikeToggle}
                                onDislikeToggle={handleDislikeToggle}
                                onRepostToggle={handleRepostToggle}
                            />
                        )
                ) : tab === 'scheduled' ? (
                    scheduledPostsLoading ? (
                        <div className="posts-skeleton">
                            {[1, 2, 3].map((i) => (
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
                    ) : scheduledPosts.length === 0 ? (
                        <div className="posts-empty">
                            <span className="posts-empty-icon"><FaClock /></span>
                            <p className="posts-empty-text">
                                {t('profile.no_scheduled') || 'No tienes posts programados.'}
                            </p>
                            <p className="posts-empty-subtext">
                                {t('profile.no_scheduled_sub') || 'Programa un post para que se publique automáticamente.'}
                            </p>
                        </div>
                    ) : isOwnProfile && (
                            <VirtualPostList
                                posts={scheduledPosts}
                                likedIds={[]}
                                dislikedIds={[]}
                                repostedIds={[]}
                                savedIds={[]}
                                onUpdate={handlePostUpdate}
                                onDelete={handlePostDelete}
                                onSaveToggle={handleSaveToggle}
                                onLikeToggle={handleLikeToggle}
                                onDislikeToggle={handleDislikeToggle}
                                onRepostToggle={handleRepostToggle}
                            />
                        )
                ) : tab === 'replies' ? (
                    repliesLoading ? (
                        <div className="posts-skeleton">
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="posts-skeleton-card">
                                    <div className="skeleton posts-skeleton-avatar" />
                                    <div className="posts-skeleton-lines">
                                        <div className="skeleton posts-skeleton-line posts-skeleton-line--short" />
                                        <div className="skeleton posts-skeleton-line" />
                                        <div className="skeleton posts-skeleton-line posts-skeleton-line--medium" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : replies.length === 0 ? (
                        <div className="posts-empty">
                            <span className="posts-empty-icon"><FaComment /></span>
                            <p className="posts-empty-text">
                                {isOwnProfile
                                    ? t('profile.no_replies')
                                    : t('profile.no_replies_other')}
                            </p>
                            <p className="posts-empty-subtext">
                                {isOwnProfile
                                    ? t('profile.no_replies_sub')
                                    : t('profile.no_replies_sub_other')}
                            </p>
                        </div>
                    ) : (
                        <VirtualPostList
                            posts={repliesPosts}
                            likedIds={repliesLikedIds}
                            dislikedIds={repliesDislikedIds}
                            repostedIds={[]}
                            savedIds={[]}
                            getKey={(post) => post.commentId || post.id}
                            replyInfoByPostId={replyInfoByPostId}
                        />
                    )
                ) : null}
            </div>
            )}

            {/* FAB for mobile */}
            {isOwnProfile && (
              <FloatingActionButton onClick={() => {
                setEditingPost(null);
                setShowCreatePost(true);
              }} />
            )}

            {/* Create/Edit Post modal */}
            <CreatePostModal
                    isOpen={isOwnProfile && showCreatePost}
                    onClose={() => {
                        setShowCreatePost(false);
                        setEditingPost(null);
                    }}
                    onSuccess={handlePostCreated}
                    editPost={editingPost}
                    userId={user?.id}
                />

            {/* Nickname modal (context menu → set/edit apodo) */}
            <NicknameModal
                    userData={nicknameModalUser}
                    currentName={nicknameModalUser ? (nicknames[nicknameModalUser.id] || '') : ''}
                    onClose={() => setNicknameModalUser(null)}
                    onSaved={handleSavedNickname}
                />

            {/* Block confirmation */}
            {confirmBlock && (
                <ConfirmModal
                    message={t('block.confirm_block', { user: activeProfile?.username || 'user' })}
                    onConfirm={() => { setConfirmBlock(false); handleBlockToggle(); }}
                    onCancel={() => setConfirmBlock(false)}
                />
            )}
        </div>
    );
}

/* ── Credits overlay component (appears on banner hover, click to reveal text) ── */
export default Profile;
