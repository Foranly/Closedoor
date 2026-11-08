import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../services/i18n/useI18n';
import usePageTitle from '../../hooks/usePageTitle';
import useBgContrast from '../../hooks/useBgContrast';
import { supabase, dbPublic } from '../services/supabaseclient';
import { toast } from 'react-toastify';
import { FaUsers, FaLock, FaPlus, FaCheck, FaTimes, FaSpinner, FaCamera, FaLink, FaTrash, FaRegComments, FaEllipsisH, FaCog, FaComment } from 'react-icons/fa';
import {
  getCommunity,
  getCachedCommunity,
  getCachedCommunityMembers,
  getCachedCommunityRoles,
  getCachedCommunityRanking,
  clearCommunityRankingCache,
  getMyMembership,
  joinCommunity,
  leaveCommunity,
  getCommunityMembers,
  getJoinRequests,
  respondJoinRequest,
  getCommunityPosts,
  createCommunityPost,
  deleteCommunityPost,
  getCommunityRoles,
  createCommunityRole,
  deleteCommunityRole,
  setMemberRole,
  createInvite,
  getCommunityInvites,
  deleteInvite,
  getActiveMembersRanking,
  redeemInvite,
  clearCommunityCache,
  clearCommunitiesListCache,
} from '../services/communityService';
import {
  getLikedPostIds,
  getRepostedPostIds,
  getSavedPostIds,
  getDislikedPostIds,
  getCachedFeed,
  setCachedFeed,
  clearFeedCache,
} from '../services/postService';
import { uploadWithLocalPreview } from '../services/cdnService';
import { getFollowing } from '../services/followService';
import { getOrCreateConversation, sendMessage } from '../services/chatService';
import { getCachedBlockStatus } from '../services/blockService';
import { COMMUNITY_MEMBERS_EVENT } from '../services/communityEvents';
import VirtualPostList from '../Resources/Components/VirtualPostList';
import Avatar from '../Resources/Components/Avatar';
import ConfirmModal from '../Resources/Components/ConfirmModal';
import ModalShell from '../Resources/Components/ModalShell';
import CommunitySettingsModal from '../Resources/Components/CommunitySettingsModal';
import '../Resources/Components/css/profileSidebar.css';
// Buscador de usuarios: se reutiliza el mismo que el modal de seguidores.
import '../Resources/Components/css/followersModal.css';
import './styles/communities.css';

const BUILTIN_MODERATOR_ROLES = ['owner', 'admin', 'moderator'];
const SORT_OPTIONS = ['recent', 'relevance', 'likes', 'comments', 'dislikes', 'reposts'];
const TIME_OPTIONS = ['all', 'today', 'week', 'month'];

// Clave de cache del feed de una comunidad (mismo patrón que profile_posts_${userId},
// pero con variantes de orden y rango de fecha).
const communityFeedKey = (cId, sort, time) => `community_posts_${cId}_${sort}_${time}`;

export default function CommunityPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { user } = useAuth();

  // Cache-first: la comunidad + miembros/roles/ranking cacheados se muestran
  // al instante (loading=false) y se refrescan en segundo plano.
  const [seed] = useState(() => getCachedCommunity(slug));
  const [community, setCommunity] = useState(() => seed);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(() => !seed);
  const [membership, setMembership] = useState(null); // null | { role, status }
  const [members, setMembers] = useState(() => (seed ? getCachedCommunityMembers(seed.id) || [] : []));
  const [requests, setRequests] = useState([]);
  const [roles, setRoles] = useState(() => (seed ? getCachedCommunityRoles(seed.id) || [] : []));
  const [invites, setInvites] = useState([]);
  const [ranking, setRanking] = useState(() => (seed ? getCachedCommunityRanking(seed.id) || [] : []));

  // Feed (cache-first, mismo patrón que el feed del perfil): la cache siembra
  // posts + estados de interacción al instante y se refresca en segundo plano.
  const [feedSeed] = useState(() => (seed ? getCachedFeed(communityFeedKey(seed.id, 'recent', 'all')) : null));
  const [posts, setPosts] = useState(() => feedSeed?.items || []);
  const [likedIds, setLikedIds] = useState(() => feedSeed?.likedIds || []);
  const [repostedIds, setRepostedIds] = useState(() => feedSeed?.repostedIds || []);
  const [savedIds, setSavedIds] = useState(() => feedSeed?.savedIds || []);
  const [dislikedIds, setDislikedIds] = useState(() => feedSeed?.dislikedIds || []);
  const [feedLoading, setFeedLoading] = useState(() => !feedSeed);
  const [sort, setSort] = useState('recent');
  const [timeRange, setTimeRange] = useState('all');
  // Ref con la vista actual del feed (sort/timeRange) para los handlers de
  // Realtime, que se suscriben con deps [community.id, user.id] y no deben
  // depender de closures stale.
  const feedViewRef = useRef({ sort, timeRange });
  useEffect(() => { feedViewRef.current = { sort, timeRange }; }, [sort, timeRange]);

  // Composer
  const [composerText, setComposerText] = useState('');
  const [composerImage, setComposerImage] = useState('');
  const [composerUploading, setComposerUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [composerError, setComposerError] = useState(null);

  // UI
  const [showSettings, setShowSettings] = useState(false);
  // Banner roto (el archivo del CDN ya no existe → 404 para todos). Se oculta
  // con elegancia y se limpia la cache del detalle para que el refetch sane.
  const [bannerBroken, setBannerBroken] = useState(false);
  const [showCreateRole, setShowCreateRole] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [headerMenuPos, setHeaderMenuPos] = useState(null); // { top, right } fixed
  const headerMenuRef = useRef(null);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleColor, setNewRoleColor] = useState('#6366f1');
  const [newRolePerms, setNewRolePerms] = useState([]);
  const [showInvites, setShowInvites] = useState(false);
  const [deletingPost, setDeletingPost] = useState(null);
  const [showMembersModal, setShowMembersModal] = useState(false);
  // Modal de miembros: mismo esquema que el de seguidores del perfil
  // (buscador + dropdown de orden + lista de filas).
  const [memberSearch, setMemberSearch] = useState('');
  const [memberRoleFilter, setMemberRoleFilter] = useState('all');
  // 'date' (por antigüedad en la comunidad) | 'role' (jerarquía de roles)
  const [memberSortMode, setMemberSortMode] = useState('date');
  const [memberSortDir, setMemberSortDir] = useState('desc');
  const [memberSortMenuOpen, setMemberSortMenuOpen] = useState(false);
  const memberSortMenuRef = useRef(null);
  const [memberRoleMenuOpen, setMemberRoleMenuOpen] = useState(false);
  const memberRoleMenuRef = useRef(null);
  const [leavePending, setLeavePending] = useState(false);
  const [inviteToken, setInviteToken] = useState(() => new URLSearchParams(window.location.search).get('invite') || null);
  const [inviteRedeeming, setInviteRedeeming] = useState(false);
  // Share community invite to chat
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareFollowing, setShareFollowing] = useState([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const [shareSendingTo, setShareSendingTo] = useState(new Set());

  const membershipRef = useRef(null);
  useEffect(() => { membershipRef.current = membership; }, [membership]);

  // Al navegar a otra comunidad se resetea el estado de banner roto (los
  // borradores de imagen viven ahora dentro de CommunitySettingsModal y se
  // reinician solos al abrirse con otra comunidad).
  useEffect(() => {
    setBannerBroken(false);
  }, [slug]);

  // ── Cerrar menú de 3 puntos al hacer clic fuera o scrollear ──
  useEffect(() => {
    if (!headerMenuOpen) return;
    const handleClick = (e) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target)) {
        setHeaderMenuOpen(false);
      }
    };
    const closeOnScroll = () => setHeaderMenuOpen(false);
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('scroll', closeOnScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('scroll', closeOnScroll, { capture: true });
    };
  }, [headerMenuOpen]);

  // ── Abrir el diálogo de miembros desde el panel derecho ──
  // La card de miembros del sidebar pide el diálogo con un CustomEvent; solo
  // responde la página de esa comunidad.
  useEffect(() => {
    if (!slug) return undefined;
    const handleRequest = (e) => {
      if (e.detail?.slug !== slug) return;
      setMemberSearch('');
      setMemberRoleFilter('all');
      setMemberSortMenuOpen(false);
      setMemberRoleMenuOpen(false);
      setShowMembersModal(true);
    };
    window.addEventListener(COMMUNITY_MEMBERS_EVENT, handleRequest);
    return () => window.removeEventListener(COMMUNITY_MEMBERS_EVENT, handleRequest);
  }, [slug]);

  // ── Menús del modal de miembros (orden y rol): cerrar al clic fuera ──
  useEffect(() => {
    if (!memberSortMenuOpen && !memberRoleMenuOpen) return;
    const handleClick = (e) => {
      if (memberSortMenuRef.current && !memberSortMenuRef.current.contains(e.target)) {
        setMemberSortMenuOpen(false);
      }
      if (memberRoleMenuRef.current && !memberRoleMenuRef.current.contains(e.target)) {
        setMemberRoleMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [memberSortMenuOpen, memberRoleMenuOpen]);

  const bannerUrl = community?.banner_url || '';
  const contrastColor = useBgContrast(bannerUrl);
  const isMember = membership?.status === 'active';
  const isModerator = isMember && (
    BUILTIN_MODERATOR_ROLES.includes(membership?.role)
    || (membership?.role && roles.some((r) => r.name === membership.role && r.permissions.includes('manage_posts')))
  );
  const isOwner = membership?.role === 'owner';

  usePageTitle(community ? `c/${community.slug} · ${community.name}` : 'Community');

  // ── Carga inicial (cache-first + refresco en segundo plano) ──
  const loadCommunity = useCallback(async () => {
    if (!slug) return;
    // Re-seed del estado con la cache del slug actual (al navegar entre
    // comunidades el useState inicial no se re-ejecuta, y así nunca se ve
    // la comunidad anterior mientras carga la nueva). Miembros/roles/ranking
    // se re-seedean (o se vacían) para el slug actual por lo mismo.
    const cached = getCachedCommunity(slug);
    if (cached) setCommunity(cached);
    if (!cached) setLoading(true);
    setMembers(cached ? getCachedCommunityMembers(cached.id) || [] : []);
    setRoles(cached ? getCachedCommunityRoles(cached.id) || [] : []);
    setRanking(cached ? getCachedCommunityRanking(cached.id) || [] : []);
    setRequests([]);
    setInvites([]);
    try {
      const c = await getCommunity(slug, { refresh: true });
      if (!c) {
        setNotFound(true);
        return;
      }
      setCommunity(c);
      let m = null;
      if (user?.id) {
        m = await getMyMembership(c.id, user.id);
        setMembership(m);
      }
      const [membersRes, rolesRes, rankingRes] = await Promise.all([
        // refresh: true → los datos cacheados se muestran ya, y aquí se
        // actualizan en segundo plano (y se re-cachean).
        getCommunityMembers(c.id, { refresh: true }).catch(() => []),
        getCommunityRoles(c.id, { refresh: true }).catch(() => []),
        getActiveMembersRanking(c.id, { refresh: true }).catch(() => []),
      ]);
      setMembers(membersRes);
      setRoles(rolesRes);
      setRanking(rankingRes);
      if (user?.id && m?.status === 'active') {
        getJoinRequests(c.id).then(setRequests).catch(() => setRequests([]));
        getCommunityInvites(c.id).then(setInvites).catch(() => setInvites([]));
      }
    } catch (err) {
      console.error('[Community] Error loading:', err);
      setNotFound(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, user?.id]);

  useEffect(() => { loadCommunity(); }, [loadCommunity]);

  // ── Feed (cache-first + refresco en segundo plano, como el feed del perfil) ──
  const loadFeed = useCallback(async (cId, whichSort, whichTime) => {
    if (!cId) return;
    const key = communityFeedKey(cId, whichSort, whichTime);
    // Restaurar la cache al instante (skeleton solo si no hay cache válida)
    const cached = getCachedFeed(key);
    if (cached) {
      setPosts(cached.items || []);
      setLikedIds(cached.likedIds || []);
      setRepostedIds(cached.repostedIds || []);
      setSavedIds(cached.savedIds || []);
      setDislikedIds(cached.dislikedIds || []);
      setFeedLoading(false);
    } else {
      setFeedLoading(true);
    }
    try {
      const data = await getCommunityPosts(cId, { sort: whichSort, timeRange: whichTime, limit: 50 });
      setPosts(data);
      let l = [], r = [], s = [], d = [];
      if (user?.id && data.length > 0) {
        const ids = data.map((p) => p.id);
        [l, r, s, d] = await Promise.all([
          getLikedPostIds(ids, user.id),
          getRepostedPostIds(ids, user.id),
          getSavedPostIds(ids, user.id),
          getDislikedPostIds(ids, user.id),
        ]);
        setLikedIds(l); setRepostedIds(r); setSavedIds(s); setDislikedIds(d);
      }
      setCachedFeed(key, data, l, r, s, d);
    } catch (err) {
      console.error('[Community] Error loading feed:', err);
    } finally {
      setFeedLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (community?.id) loadFeed(community.id, sort, timeRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.id, sort, timeRange]);

  // ── Realtime: contadores de posts + nuevos posts ──
  useEffect(() => {
    if (!community?.id) return;
    const channel = supabase
      .channel(`community-${community.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts' }, (payload) => {
        const u = payload.new;
        setPosts((prev) => prev.map((p) =>
          p.id === u.id
            ? { ...p, likes_count: u.likes_count, dislikes_count: u.dislikes_count, reposts_count: u.reposts_count, comments_count: u.comments_count, views_count: u.views_count }
            : p
        ));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, async (payload) => {
        const np = payload.new;
        if (np.community_id !== community.id) return;
        if (np.user_id === user?.id) return;
        if (np.scheduled_at && new Date(np.scheduled_at) > new Date()) return;
        if (np.is_encrypted) return;
        if (community.is_private && membershipRef.current?.status !== 'active') return;
        try {
          const { data } = await dbPublic
            .from('posts')
            .select('*, profiles!posts_user_id_fkey (id, username, displayname, avatar_url, roles, is_private, avatar_position)')
            .eq('id', np.id)
            .single();
          if (!data) return;
          const { getCdnUrl } = await import('../services/cdnService');
          if (data.image_url) data.image_url = getCdnUrl(data.image_url);
          if (Array.isArray(data.image_urls)) data.image_urls = data.image_urls.map((u) => getCdnUrl(u));
          if (data.profiles?.avatar_url) data.profiles.avatar_url = getCdnUrl(data.profiles.avatar_url);
          setPosts((prev) => (prev.some((p) => p.id === data.id) ? prev : [data, ...prev]));
        } catch { /* silencioso */ }
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, (payload) => {
        const oldId = payload.old?.id;
        if (oldId) setPosts((prev) => prev.filter((p) => p.id !== oldId));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_members' }, async (payload) => {
        if (payload.new.community_id !== community.id) return;
        // El contador lo mantiene el trigger en DB; aquí solo sincronizamos la UI
        if (payload.new.status === 'active') {
          setCommunity((prev) => (prev ? { ...prev, member_count: (prev.member_count || 0) + 1 } : prev));
        }
        if (payload.new.status === 'pending') {
          // Refrescar solicitudes (no-moderadores recibirán [] por RLS, sin romper)
          getJoinRequests(community.id).then(setRequests).catch(() => {});
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'community_members' }, (payload) => {
        if (payload.new.community_id !== community.id) return;
        const from = payload.old?.status;
        const to = payload.new.status;
        if (from === to) return;
        const delta = (to === 'active' ? 1 : 0) - (from === 'active' ? 1 : 0);
        if (delta !== 0) {
          setCommunity((prev) => (prev ? { ...prev, member_count: Math.max((prev.member_count || 0) + delta, 0) } : prev));
        }
        if (to === 'pending') {
          getJoinRequests(community.id).then(setRequests).catch(() => {});
        }
        // El propio usuario fue aprobado estando en la página (pending → active):
        // su feed ahora es visible → invalidar la cache actual y recargarlo.
        if (to === 'active' && from === 'pending' && payload.new.user_id === user?.id) {
          const v = feedViewRef.current;
          clearFeedCache(communityFeedKey(community.id, v.sort, v.timeRange));
          loadFeed(community.id, v.sort, v.timeRange);
        }
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'community_members' }, (payload) => {
        if (payload.old?.community_id !== community.id) return;
        if (payload.old?.status === 'active') {
          setCommunity((prev) => (prev ? { ...prev, member_count: Math.max((prev.member_count || 0) - 1, 0) } : prev));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.id, user?.id]);

  // ── Acciones de membresía ──
  const handleJoin = async () => {
    if (!user?.id) { navigate('/Login'); return; }
    try {
      const res = await joinCommunity(community.id, user.id);
      setMembership({ role: res.role, status: res.status });
      // member_count se sincroniza vía realtime (INSERT/UPDATE de community_members)
      if (!res.isPending) {
        getCommunityMembers(community.id).then(setMembers).catch(() => {});
        // La visibilidad del feed puede cambiar (privada) → invalidar la cache
        // del feed actual y recargarlo para que no sirva la lista vacía vieja
        clearFeedCache(communityFeedKey(community.id, sort, timeRange));
        loadFeed(community.id, sort, timeRange);
      }
      toast.success(res.isPending ? t('comunidades.request_sent') : t('comunidades.joined'));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    }
  };

  // ── Canje de invitación (?invite=token) ──
  const handleRedeemInvite = async () => {
    if (!inviteToken) return;
    if (!user?.id) { navigate('/Login'); return; }
    setInviteRedeeming(true);
    try {
      const res = await redeemInvite(inviteToken, user.id);
      setInviteToken(null);
      setMembership({ role: res.role || 'member', status: res.status || 'active' });
      // member_count se sincroniza vía realtime
      getCommunityMembers(community.id).then(setMembers).catch(() => {});
      // El alta cambia la visibilidad del feed → invalidar cache y recargar
      clearFeedCache(communityFeedKey(community.id, sort, timeRange));
      loadFeed(community.id, sort, timeRange);
      toast.success(t('comunidades.joined'));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.invite_invalid'));
    } finally {
      setInviteRedeeming(false);
    }
  };

  const handleLeave = async () => {
    // El dueño no puede irse y dejar la comunidad sin líder
    if (membership?.role === 'owner') {
      toast.error(t('comunidades.owner_cannot_leave'));
      return;
    }
    try {
      await leaveCommunity(community.id, user.id);
      setMembership(null);
      // member_count se sincroniza vía realtime (DELETE de community_members)
      setMembers((prev) => prev.filter((m) => m.user_id !== user?.id));
      setPosts([]);
      // Ya no se ve el contenido de la comunidad → invalidar cache del feed
      clearFeedCache(communityFeedKey(community.id, sort, timeRange));
      toast.success(t('comunidades.left'));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    }
  };

  // ── Moderación de solicitudes ──
  const handleRequest = async (userId, approve) => {
    try {
      await respondJoinRequest(community.id, userId, { approve });
      setRequests((prev) => prev.filter((r) => r.user_id !== userId));
      if (approve) {
        // member_count se sincroniza vía realtime (UPDATE pending → active)
        getCommunityMembers(community.id).then(setMembers).catch(() => {});
      }
      toast.success(approve ? t('comunidades.request_approved') : t('comunidades.request_rejected'));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    }
  };

  // ── Roles ──
  const handleCreateRole = async () => {
    const roleName = newRoleName.trim();
    if (!roleName) return;
    try {
      await createCommunityRole(community.id, { name: roleName, color: newRoleColor, permissions: newRolePerms });
      setRoles(await getCommunityRoles(community.id));
      setShowCreateRole(false);
      setNewRoleName('');
      setNewRolePerms([]);
      toast.success(t('comunidades.role_created'));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    }
  };

  const handleDeleteRole = async (role) => {
    try {
      await deleteCommunityRole(community.id, role.id, role.name);
      setRoles(await getCommunityRoles(community.id));
      toast.success(t('comunidades.role_deleted'));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    }
  };

  const handleSetRole = async (targetUserId, role) => {
    try {
      await setMemberRole(community.id, targetUserId, role);
      setMembers((prev) => prev.map((m) => (m.user_id === targetUserId ? { ...m, role } : m)));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    }
  };

  // ── Invitaciones ──
  // Regla: 1 invitación activa por usuario y comunidad (índice único en DB).
  const myInvite = invites.find((inv) => inv.created_by === user?.id);

  const handleCreateInvite = async () => {
    try {
      await createInvite(community.id, user.id);
      setInvites(await getCommunityInvites(community.id));
      toast.success(t('comunidades.invite_created'));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    }
  };

  const handleDeleteInvite = async (inviteId) => {
    try {
      await deleteInvite(inviteId);
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    }
  };

  const inviteUrl = (invite) => `${window.location.origin}/c/${community.slug}?invite=${invite.token}`;

  const copyInvite = async (invite) => {
    try {
      await navigator.clipboard.writeText(inviteUrl(invite));
      toast.success(t('comunidades.invite_copied'));
    } catch {
      toast.error(t('comunidades.error'));
    }
  };

  // ── Composer ──
  const composerImageMetaRef = useRef({});

  const handleComposerImage = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('modal.invalid_image_type'));
      return;
    }
    setComposerUploading(true);
    try {
      const { localUrl, realUrlPromise, realResultPromise } = uploadWithLocalPreview(file, user.id, 'post');
      setComposerImage(localUrl);
      const realUrl = await realUrlPromise;
      setComposerImage(realUrl);
      realResultPromise.then((result) => {
        if (result?.width > 0 && result?.height > 0) {
          composerImageMetaRef.current[realUrl] = { u: realUrl, w: result.width, h: result.height };
        }
      }).catch(() => {});
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    } finally {
      setComposerUploading(false);
      e.target.value = '';
    }
  };

  const handlePost = async () => {
    const text = composerText.trim();
    if (!text && !composerImage) {
      setComposerError(t('create_post.empty_error'));
      return;
    }
    const finalImageUrls = composerImage ? [composerImage] : [];
    const finalImageMeta = finalImageUrls
      .map((u) => composerImageMetaRef.current[u])
      .filter(Boolean);
    setPosting(true);
    setComposerError(null);
    try {
      const post = await createCommunityPost({
        userId: user.id,
        communityId: community.id,
        content: text || undefined,
        imageUrls: finalImageUrls.length > 0 ? finalImageUrls : undefined,
        imageMeta: finalImageMeta.length > 0 ? finalImageMeta : undefined,
      });
      // Insertar al inicio del feed
      const { data } = await dbPublic
        .from('posts')
        .select('*, profiles!posts_user_id_fkey (id, username, displayname, avatar_url, roles, is_private, avatar_position)')
        .eq('id', post.id)
        .single();
      if (data) {
        const { getCdnUrl } = await import('../services/cdnService');
        if (data.image_url) data.image_url = getCdnUrl(data.image_url);
        if (Array.isArray(data.image_urls)) data.image_urls = data.image_urls.map((u) => getCdnUrl(u));
        if (data.profiles?.avatar_url) data.profiles.avatar_url = getCdnUrl(data.profiles.avatar_url);
        setPosts((prev) => [data, ...prev]);
      }
      setComposerText('');
      setComposerImage('');
      setCommunity((prev) => (prev ? { ...prev, post_count: (prev.post_count || 0) + 1 } : prev));
      // Publicar cambia la actividad → el ranking cacheado queda obsoleto
      clearCommunityRankingCache(community.id);
      // El feed cacheado no incluye el post nuevo → invalidar clave actual
      clearFeedCache(communityFeedKey(community.id, sort, timeRange));
      toast.success(t('create_post.posted'));
    } catch (err) {
      console.error(err);
      setComposerError(err.message || t('comunidades.error'));
    } finally {
      setPosting(false);
    }
  };

  // ── Borrado de posts (owner/moderadores) — PostCard llama onDelete(postId) ──
  const handleDeletePost = useCallback((postId) => {
    setDeletingPost(postId);
  }, []);

  const confirmDeletePost = async () => {
    if (!deletingPost) return;
    try {
      await deleteCommunityPost(deletingPost);
      setPosts((prev) => prev.filter((p) => p.id !== deletingPost));
      setCommunity((prev) => (prev ? { ...prev, post_count: Math.max((prev.post_count || 0) - 1, 0) } : prev));
      // Borrar cambia la actividad → el ranking cacheado queda obsoleto
      clearCommunityRankingCache(community.id);
      // El feed cacheado aún contiene el post borrado → invalidar clave actual
      clearFeedCache(communityFeedKey(community.id, sort, timeRange));
      toast.success(t('comunidades.post_deleted'));
    } catch (err) {
      console.error(err);
      toast.error(err.message || t('comunidades.error'));
    } finally {
      setDeletingPost(null);
    }
  };

  const handlePostUpdate = useCallback((updatedPost) => {
    setPosts((prev) => prev.map((p) => (p.id === updatedPost.id ? { ...p, ...updatedPost } : p)));
  }, []);

  // ── Share community invite to chat ──
  const openShareModal = useCallback(async () => {
    setShowInvites(false);
    if (!user?.id) return;
    setShowShareModal(true);
    setSelectedUsers(new Set());
    setShareSendingTo(new Set());
    setShareLoading(true);
    try {
      const data = await getFollowing(user.id);
      const filtered = (data || []).filter(u => {
        const blockedByMe = getCachedBlockStatus(user.id, u.id);
        const blockedByThem = getCachedBlockStatus(u.id, user.id);
        return blockedByMe !== true && blockedByThem !== true;
      });
      setShareFollowing(filtered);
    } catch (err) {
      console.warn('Error loading following for share:', err);
      setShareFollowing([]);
    } finally {
      setShareLoading(false);
    }
  }, [user?.id]);

  const toggleUserSelection = useCallback((userId) => {
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const handleSendInviteToChat = useCallback(async () => {
    if (selectedUsers.size === 0 || !user?.id || !community?.id) return;
    const targets = shareFollowing.filter(u => selectedUsers.has(u.id));
    setShareSendingTo(new Set(selectedUsers));
    let errors = 0;
    try {
      // Get-or-create: mi invitación personal única (su token viaja en el mensaje)
      const invite = await createInvite(community.id, user.id);
      for (const targetUser of targets) {
        const cachedBlocked = getCachedBlockStatus(user.id, targetUser.id);
        if (cachedBlocked === true) { errors++; continue; }
        const cachedBlockedByThem = getCachedBlockStatus(targetUser.id, user.id);
        if (cachedBlockedByThem === true) { errors++; continue; }
        try {
          const convId = await getOrCreateConversation(user.id, targetUser.id);
          const { data: participants } = await supabase
            .from('chat_participants')
            .select('user_id')
            .eq('conversation_id', convId);
          const participantIds = (participants || []).map(p => p.user_id).filter(id => id !== user.id);
          await sendMessage(convId, user.id, '', participantIds, null, null, community.id, invite.token);
        } catch (err) {
          console.error('Error sharing community invite to', targetUser.username, ':', err);
          errors++;
        }
      }
    } catch (err) {
      console.error('Error resolving own invite:', err);
      toast.error(t('comunidades.error'));
      setShareSendingTo(new Set());
      return;
    }
    setShareSendingTo(new Set());
    if (errors === 0) {
      setShowShareModal(false);
      setSelectedUsers(new Set());
      setShareFollowing([]);
      toast.success(t('comunidades.share_chat_sent'));
    } else {
      toast.error(t('comunidades.error'));
    }
  }, [selectedUsers, shareFollowing, user?.id, community?.id, t]);

  // ── Render ──
  if (loading) {
    return (
      <div className="community-page community-skeleton-page">
        {/* Skeleton del header */}
        <div className="community-skeleton-header">
          <div className="skeleton community-skeleton-banner" />
          <div className="community-skeleton-header-main">
            <div className="community-skeleton-avatar-row">
              <div className="skeleton skeleton--circle community-skeleton-avatar" />
              <div className="community-skeleton-header-actions">
                <div className="skeleton community-skeleton-btn" />
                <div className="skeleton community-skeleton-btn" style={{ width: 34 }} />
              </div>
            </div>
            <div className="community-skeleton-header-lines">
              <div className="skeleton community-skeleton-line community-skeleton-line--title" />
              <div className="skeleton community-skeleton-line community-skeleton-line--slug" />
              <div className="community-skeleton-line--stats">
                <div className="skeleton community-skeleton-line--stat" />
                <div className="skeleton community-skeleton-line--stat" style={{ width: 70 }} />
              </div>
              <div className="skeleton community-skeleton-line community-skeleton-line--desc" />
              <div className="community-skeleton-line--interests">
                <div className="skeleton community-skeleton-interest" />
                <div className="skeleton community-skeleton-interest" style={{ width: 50 }} />
                <div className="skeleton community-skeleton-interest" style={{ width: 70 }} />
                <div className="skeleton community-skeleton-interest" style={{ width: 55 }} />
              </div>
            </div>
          </div>
        </div>
        <div className="community-body">
          <div className="community-main">
            {/* Skeleton composer */}
            <div className="community-skeleton-composer">
              <div className="skeleton community-skeleton-composer-textarea" />
              <div className="community-skeleton-composer-footer">
                <div className="skeleton community-skeleton-composer-btn" />
                <div className="skeleton community-skeleton-composer-submit" />
              </div>
            </div>
            {/* Skeleton feed controls */}
            <div className="community-skeleton-feed-controls">
              <div className="community-skeleton-feed-sorts">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="skeleton community-skeleton-pill" />
                ))}
              </div>
              <div className="community-skeleton-feed-sorts">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton community-skeleton-pill" style={{ width: 50 }} />
                ))}
              </div>
            </div>
            {/* Skeleton posts */}
            {[1, 2].map((i) => (
              <div key={i} className="community-skeleton-post">
                <div className="skeleton community-skeleton-post-avatar" />
                <div className="community-skeleton-post-lines">
                  <div className="skeleton community-skeleton-line" style={{ width: '40%' }} />
                  <div className="skeleton community-skeleton-line" style={{ width: '90%' }} />
                  <div className="skeleton community-skeleton-line" style={{ width: '65%' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (notFound || !community) {
    return (
      <div className="community-page community-page--empty">
        <div className="community-page-empty-icon"><FaUsers /></div>
        <h2 className="community-page-empty-title">{t('comunidades.not_found')}</h2>
        <p className="community-page-empty-sub">{t('comunidades.not_found_sub')}</p>
        <Link to="/Communities" className="community-page-empty-btn">{t('comunidades.back')}</Link>
      </div>
    );
  }

  const isPending = membership?.status === 'pending';
  const canPost = isMember;
  const canManage = isModerator;

  // ── Modal de miembros: búsqueda, filtro por rol y orden ──
  // Roles presentes en la lista (incluye los personalizados que existan hoy),
  // para no ofrecer chips que no devolverían a nadie.
  const memberRoleOptions = Array.from(new Set(members.map((m) => m.role).filter(Boolean)));

  // Peso para ordenar por jerarquía; los roles personalizados van después de
  // 'member' y se ordenan alfabéticamente entre ellos.
  const memberRoleWeight = (role) => {
    const weights = { owner: 4, admin: 3, moderator: 2, member: 1 };
    return weights[role] || 0;
  };

  const memberSortOptions = [
    { mode: 'date', dir: 'desc', modeLabel: t('comunidades.filter_recent'), label: `${t('comunidades.filter_recent')} ↓` },
    { mode: 'date', dir: 'asc', modeLabel: t('comunidades.filter_recent'), label: `${t('comunidades.filter_recent')} ↑` },
    { mode: 'role', dir: 'desc', modeLabel: t('comunidades.filter_role'), label: `${t('comunidades.filter_role')} ↓` },
    { mode: 'role', dir: 'asc', modeLabel: t('comunidades.filter_role'), label: `${t('comunidades.filter_role')} ↑` },
  ];
  const currentMemberSort = memberSortOptions.find(
    (o) => o.mode === memberSortMode && o.dir === memberSortDir,
  ) || memberSortOptions[0];

  const memberRoleLabel = (role) => (
    ['owner', 'admin', 'moderator', 'member'].includes(role)
      ? t(`comunidades.role_${role}`)
      : role
  );
  const memberRoleChoices = [
    { value: 'all', label: t('comunidades.filter_all_roles') },
    ...memberRoleOptions.map((role) => ({ value: role, label: memberRoleLabel(role) })),
  ];
  const currentMemberRoleChoice = memberRoleChoices.find((c) => c.value === memberRoleFilter)
    || memberRoleChoices[0];

  const filteredMembers = (() => {
    const q = memberSearch.trim().toLowerCase().replace(/^@/, '');
    let list = members;
    if (q) {
      list = list.filter((m) => {
        const username = String(m.profiles?.username || '').toLowerCase();
        const displayname = String(m.profiles?.displayname || '').toLowerCase();
        return username.includes(q) || displayname.includes(q);
      });
    }
    if (memberRoleFilter !== 'all') {
      list = list.filter((m) => m.role === memberRoleFilter);
    }

    const dir = memberSortDir === 'asc' ? -1 : 1;
    if (memberSortMode === 'role') {
      return [...list].sort((a, b) => {
        const diff = memberRoleWeight(b.role) - memberRoleWeight(a.role);
        if (diff !== 0) return dir * diff;
        return String(a.profiles?.username || '').localeCompare(String(b.profiles?.username || ''));
      });
    }
    return [...list].sort(
      (a, b) => dir * (new Date(b.joined_at || 0) - new Date(a.joined_at || 0)),
    );
  })();

  return (
    <div className="community-page">
      {/* ── Header ── */}
      <div
        className="community-header"
        style={{
          '--cc-accent': community.accent_color || 'transparent',
          '--cc-accent-2': community.accent_color_secondary || community.accent_color || 'transparent',
        }}
      >
        <div className="community-header-banner">
          {community.banner_url && !bannerBroken ? (
            <img
              src={community.banner_url}
              alt=""
              onError={() => {
                // El archivo del CDN no existe (404) → ocultarlo con elegancia
                // y limpiar la cache del detalle para que el refetch sane.
                setBannerBroken(true);
                clearCommunityCache(slug);
              }}
            />
          ) : (
            <div
              className="community-header-banner-empty"
              style={community.accent_color ? { background: `linear-gradient(135deg, ${community.accent_color}, ${community.accent_color_secondary || community.accent_color})` } : undefined}
            />
          )}
          <div className="community-header-overlay" />
        </div>

        <div className="community-header-main">
          <div className="community-header-avatar-row">
            <div className="community-header-avatar">
              {community.avatar_url ? (
                <Avatar src={community.avatar_url} alt={community.name} />
              ) : (
                <span style={{ fontSize: '2.2rem', fontWeight: 800 }}>{community.name.charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className="community-header-actions">
              {!user?.id ? (
                <button className="community-header-btn community-header-btn--join" onClick={() => navigate('/Login')}>
                  {t('comunidades.join')}
                </button>
              ) : isPending ? (
                <span className="community-header-btn community-header-btn--pending">
                  <FaClockIcon /> {t('comunidades.pending')}
                </span>
              ) : isMember ? (
                <>
                  <span className="community-header-role-badge">{t(`comunidades.role_${membership.role}`)}</span>
                  <div className="community-header-menu-wrap" ref={headerMenuRef}>
                    <button
                      className={`community-header-btn community-header-btn--dots ${headerMenuOpen ? 'community-header-btn--dots-active' : ''}`}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setHeaderMenuPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
                        setHeaderMenuOpen((s) => !s);
                      }}
                      title={t('comunidades.more')}
                    >
                      <FaEllipsisH />
                    </button>
                    {headerMenuOpen && headerMenuPos && (
                      <div className="community-header-dropdown" style={{ top: headerMenuPos.top, right: headerMenuPos.right }}>
                        {isOwner && (
                          <button
                            type="button"
                            className="community-header-dropdown-btn"
                            onClick={() => { setHeaderMenuOpen(false); setShowSettings(true); }}
                          >
                            <FaCog />
                            <span>{t('comunidades.settings')}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="community-header-dropdown-btn"
                          onClick={() => { setHeaderMenuOpen(false); setShowInvites(true); }}
                        >
                          <FaLink />
                          <span>{t('comunidades.invites')}</span>
                        </button>
                        {!isOwner && (
                          <button
                            type="button"
                            className="community-header-dropdown-btn community-header-dropdown-btn--leave"
                            onClick={() => { setHeaderMenuOpen(false); setLeavePending(true); }}
                          >
                            <FaTimes />
                            <span>{t('comunidades.leave')}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <button className="community-header-btn community-header-btn--join" onClick={handleJoin}>
                  {community.is_private && <FaLock />} {t('comunidades.join')}
                </button>
              )}
            </div>
          </div>

          <h1 className="community-header-name" style={{ color: contrastColor }}>
            {community.name}
          </h1>
          <span className="community-header-slug" style={{ color: contrastColor }}>
            c/{community.slug}
            {community.is_private && <span className="community-header-private"><FaLock /> {t('comunidades.private')}</span>}
            {community.is_mature && <span className="community-header-mature" title={t('comunidades.mature')}>+18</span>}
          </span>

          <div className="community-header-stats" style={{ color: contrastColor }}>
            <button
              type="button"
              className="community-header-stat"
              onClick={() => {
                // Abrir limpio: sin búsqueda ni filtros de la vez anterior.
                setMemberSearch('');
                setMemberRoleFilter('all');
                setMemberSortMenuOpen(false);
                setMemberRoleMenuOpen(false);
                setShowMembersModal(true);
              }}
            >
              <strong>{community.member_count || 0}</strong> {t('comunidades.members')}
            </button>
            <span className="community-header-stat">
              <strong>{community.post_count || 0}</strong> {t('comunidades.posts')}
            </span>
          </div>

          {community.description && (
            <p className="community-header-desc" style={{ color: contrastColor }}>{community.description}</p>
          )}

          {community.interests?.length > 0 && (
            <div className="community-header-interests">
              {community.interests.slice(0, 8).map((i) => (
                <span key={i} className="community-header-interest">{i}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="community-body">
        {/* ── Columna principal ── */}
        <div className="community-main">
          {/* ── Solicitudes pendientes (moderadores) ── */}
          {canManage && requests.length > 0 && (
            <div className="community-requests">
              <div className="community-section-title">
                <FaClockIcon /> {t('comunidades.join_requests')} ({requests.length})
              </div>
              <div className="community-requests-list">
                {requests.map((r) => (
                  <div key={r.user_id} className="community-request-item">
                    <Link to={`/profile/${r.profiles?.username}`} className="community-request-user">
                      <Avatar className="community-request-avatar" src={r.profiles?.avatar_url} alt={r.profiles?.username} />
                      <span className="community-request-name">@{r.profiles?.username || r.user_id.slice(0, 8)}</span>
                    </Link>
                    <div className="community-request-actions">
                      <button type="button" className="community-request-btn community-request-btn--ok" onClick={() => handleRequest(r.user_id, true)}>
                        <FaCheck />
                      </button>
                      <button type="button" className="community-request-btn community-request-btn--no" onClick={() => handleRequest(r.user_id, false)}>
                        <FaTimes />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Composer (miembros) ── */}
          {canPost && (
            <div className="community-composer">
              <textarea
                className="community-composer-textarea"
                value={composerText}
                onChange={(e) => { setComposerText(e.target.value); setComposerError(null); }}
                placeholder={t('comunidades.post_placeholder')}
                rows={3}
                maxLength={2000}
              />
              {composerError && <p className="community-composer-error">{composerError}</p>}
              <div className="community-composer-footer">
                <label className="community-composer-img-btn">
                  {composerUploading ? <FaSpinner className="fc-spin" /> : <FaCamera />}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    style={{ display: 'none' }}
                    onChange={handleComposerImage}
                  />
                </label>
                {composerImage && (
                  <div className="community-composer-img-preview">
                    <img src={composerImage} alt="" />
                    <button type="button" onClick={() => setComposerImage('')}><FaTimes /></button>
                  </div>
                )}
                <button
                  className="community-composer-post"
                  onClick={handlePost}
                  disabled={posting || (!composerText.trim() && !composerImage)}
                >
                  {posting ? <FaSpinner className="fc-spin" /> : t('comunidades.post')}
                </button>
              </div>
            </div>
          )}

          {!user?.id && (
            <div className="community-join-prompt">
              <p>{t('comunidades.join_prompt')}</p>
              <button className="community-join-prompt-btn" onClick={() => navigate('/Login')}>{t('auth.login_btn')}</button>
            </div>
          )}

          {isPending && (
            <div className="community-join-prompt">
              <FaLock />
              <p>{t('comunidades.pending_hint')}</p>
            </div>
          )}

          {inviteToken && !isMember && !isPending && (
            <div className="community-join-prompt">
              <FaLink />
              <p>{t('comunidades.invite_prompt')}</p>
              <button
                className="community-join-prompt-btn"
                onClick={handleRedeemInvite}
                disabled={inviteRedeeming}
              >
                {inviteRedeeming ? <FaSpinner className="fc-spin" /> : t('comunidades.join')}
              </button>
            </div>
          )}

          {community.is_private && !isMember && !isPending && !inviteToken && (
            <div className="community-join-prompt">
              <FaLock />
              <p>{t('comunidades.private_hint')}</p>
            </div>
          )}

          {/* ── Feed controls ── */}
          <div className="community-feed-controls">
            <div className="community-feed-sorts">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`community-feed-sort ${sort === opt ? 'community-feed-sort--active' : ''}`}
                  onClick={() => setSort(opt)}
                >
                  {t(`comunidades.sort_${opt}`)}
                </button>
              ))}
            </div>
            <div className="community-feed-times">
              {TIME_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`community-feed-time ${timeRange === opt ? 'community-feed-time--active' : ''}`}
                  onClick={() => setTimeRange(opt)}
                >
                  {t(`comunidades.time_${opt}`)}
                </button>
              ))}
            </div>
          </div>

          {/* ── Feed ── */}
          {feedLoading ? (
            <div className="community-feed-skeleton">
              {[1, 2, 3].map((i) => (
                <div key={i} className="posts-skeleton-card">
                  <div className="skeleton posts-skeleton-avatar" />
                  <div className="posts-skeleton-lines">
                    <div className="skeleton posts-skeleton-line posts-skeleton-line--short" />
                    <div className="skeleton posts-skeleton-line" />
                  </div>
                </div>
              ))}
            </div>
          ) : posts.length === 0 ? (
            <div className="community-feed-empty">
              <FaRegComments />
              <p>{t('comunidades.no_posts')}</p>
            </div>
          ) : (
            <VirtualPostList
              posts={posts}
              likedIds={likedIds}
              dislikedIds={dislikedIds}
              repostedIds={repostedIds}
              savedIds={savedIds}
              onUpdate={handlePostUpdate}
              onDelete={isModerator ? handleDeletePost : undefined}
              onLikeToggle={(id, v) => setLikedIds((p) => (v ? [...p, id] : p.filter((x) => x !== id)))}
              onDislikeToggle={(id, v) => setDislikedIds((p) => (v ? [...p, id] : p.filter((x) => x !== id)))}
              onRepostToggle={(id, v) => setRepostedIds((p) => (v ? [...p, id] : p.filter((x) => x !== id)))}
              onSaveToggle={(id, v) => setSavedIds((p) => (v ? [...p, id] : p.filter((x) => x !== id)))}
            />
          )}
        </div>


      </div>

      {/* ── Modal de miembros — mismo shell y estructura que el de seguidores
          del perfil (FollowersModal): header + buscador + dropdown de orden +
          lista de filas. ── */}
      <ModalShell
        isOpen={showMembersModal}
        onClose={() => setShowMembersModal(false)}
        className="followers-modal"
      >
        <div className="followers-modal-header">
          <h3 className="fc-modal-title">{t('comunidades.members')} ({members.length})</h3>
          <button
            type="button"
            className="followers-modal-close"
            onClick={() => setShowMembersModal(false)}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>

        <div className="followers-modal-search">
          <div className="followers-modal-search-wrap">
            <svg className="followers-modal-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="followers-modal-search-input"
              type="text"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder={t('comunidades.members_search')}
            />
          </div>
        </div>

        <div className="community-members-menus">
          {/* Orden */}
          <div className="community-members-menu" ref={memberSortMenuRef}>
            <button
              type="button"
              className="followers-modal-sort-btn"
              onClick={() => setMemberSortMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={memberSortMenuOpen}
            >
              <span className="followers-modal-sort-btn-label">{currentMemberSort.modeLabel}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {memberSortMenuOpen && (
              <div className="followers-modal-sort-menu fc-dropdown" role="menu">
                {memberSortOptions.map((opt) => {
                  const active = opt.mode === memberSortMode && opt.dir === memberSortDir;
                  return (
                    <button
                      key={`${opt.mode}-${opt.dir}`}
                      type="button"
                      role="menuitem"
                      aria-pressed={active}
                      className={`fc-dropdown-btn${active ? ' fc-dropdown-btn--active' : ''}`}
                      onClick={() => {
                        setMemberSortMode(opt.mode);
                        setMemberSortDir(opt.dir);
                        setMemberSortMenuOpen(false);
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Filtro por rol (solo los que existen hoy en la comunidad) */}
          <div className="community-members-menu" ref={memberRoleMenuRef}>
            <button
              type="button"
              className="followers-modal-sort-btn"
              onClick={() => setMemberRoleMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={memberRoleMenuOpen}
            >
              <span className="followers-modal-sort-btn-label">{currentMemberRoleChoice.label}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {memberRoleMenuOpen && (
              <div className="followers-modal-sort-menu fc-dropdown" role="menu">
                {memberRoleChoices.map((choice) => {
                  const active = choice.value === memberRoleFilter;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      role="menuitem"
                      aria-pressed={active}
                      className={`fc-dropdown-btn${active ? ' fc-dropdown-btn--active' : ''}`}
                      onClick={() => {
                        setMemberRoleFilter(choice.value);
                        setMemberRoleMenuOpen(false);
                      }}
                    >
                      {choice.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>


        {members.length === 0 ? (
          <div className="followers-modal-empty">
            <p>{t('comunidades.no_members')}</p>
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="followers-modal-empty">
            <p>{t('comunidades.no_members_match')}</p>
          </div>
        ) : (
          <div className="followers-modal-list">
            {filteredMembers.map((m) => (
              <div
                key={m.user_id}
                className="followers-modal-item"
                onClick={(e) => {
                  if (e.target.closest('.followers-modal-action')) return;
                  setShowMembersModal(false);
                  navigate(`/profile/${m.profiles?.username}`);
                }}
              >
                <Avatar
                  className="followers-modal-avatar"
                  src={m.profiles?.avatar_url}
                  alt={m.profiles?.username}
                />
                <div className="followers-modal-info">
                  <div className="followers-modal-name-row">
                    <span className="followers-modal-username">{m.profiles?.username || '…'}</span>
                    <span className="community-member-role">
                      {['owner', 'admin', 'moderator', 'member'].includes(m.role)
                        ? t(`comunidades.role_${m.role}`)
                        : m.role}
                    </span>
                  </div>
                </div>
                {(isOwner || isModerator) && m.user_id !== user?.id && (
                  <div className="followers-modal-action">
                    <select
                      className="community-member-role-select"
                      value={m.role}
                      onChange={(e) => handleSetRole(m.user_id, e.target.value)}
                    >
                      <option value="member">{t('comunidades.role_member')}</option>
                      <option value="moderator">{t('comunidades.role_moderator')}</option>
                      <option value="admin">{t('comunidades.role_admin')}</option>
                      {roles.map((r) => (
                        <option key={r.id} value={r.name}>{r.name}</option>
                      ))}
                      <option value="owner" disabled>{t('comunidades.role_owner')}</option>
                    </select>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ModalShell>

      {/* ── Modal de invitaciones ── */}
      {showInvites && (
        <div className="community-modal-backdrop" onClick={() => setShowInvites(false)}>
          <div className="community-modal" onClick={(e) => e.stopPropagation()}>
            <div className="community-modal-header">
              <span className="community-modal-title">{t('comunidades.invites')}</span>
              <button type="button" className="community-modal-close" onClick={() => setShowInvites(false)}><FaTimes /></button>
            </div>
            <div className="community-modal-body">
              <button
                type="button"
                className="community-invite-create"
                onClick={handleCreateInvite}
                disabled={!!myInvite}
              >
                <FaPlus /> {t('comunidades.invite_create')}
              </button>
              {myInvite && (
                <p className="community-invite-limit">{t('comunidades.invite_limit')}</p>
              )}
              {myInvite ? (
                <div key={myInvite.id} className="community-invite-row">
                  <code className="community-invite-token">{inviteUrl(myInvite)}</code>
                  <button type="button" className="community-invite-copy" onClick={() => copyInvite(myInvite)}>
                    {t('comunidades.invite_copy')}
                  </button>
                  <button
                    type="button"
                    className="community-invite-chat"
                    title={t('comunidades.invite_send_chat')}
                    onClick={() => openShareModal()}
                  >
                    <FaComment />
                  </button>
                  <button type="button" className="community-invite-del" onClick={() => handleDeleteInvite(myInvite.id)}>
                    <FaTrash />
                  </button>
                </div>
              ) : (
                <p className="community-modal-empty">{t('comunidades.no_invites')}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modal de compartir invitación por chat ── */}
      {showShareModal && (
        <div className="post-card-share-modal-overlay" onClick={() => setShowShareModal(false)}>
          <div className="post-card-share-modal" onClick={(e) => e.stopPropagation()}>
            <div className="post-card-share-modal-header">
              <h3 className="post-card-share-modal-title">{t('comunidades.share_chat_title')}</h3>
              <button className="post-card-share-modal-close" onClick={() => setShowShareModal(false)}>
                <FaTimes />
              </button>
            </div>
            {shareLoading ? (
              <div className="post-card-share-modal-status">{t('common.loading')}</div>
            ) : shareFollowing.length === 0 ? (
              <div className="post-card-share-modal-status">
                <FaUsers className="post-card-share-modal-empty-icon" />
                <p>{t('comunidades.share_chat_empty')}</p>
              </div>
            ) : (
              <>
                <div className="post-card-share-modal-grid">
                  {shareFollowing.map((u) => {
                    const isSelected = selectedUsers.has(u.id);
                    const isSending = shareSendingTo.has(u.id);
                    return (
                      <button
                        key={u.id}
                        className={`post-card-share-modal-user ${isSelected ? 'post-card-share-modal-user--selected' : ''}`}
                        onClick={() => toggleUserSelection(u.id)}
                        disabled={shareSendingTo.size > 0}
                      >
                        <Avatar
                          src={u.avatar_url}
                          alt={u.username}
                          className="post-card-share-modal-avatar"
                        />
                        <span className="post-card-share-modal-username">{u.username}</span>
                        {isSending ? (
                          <span className="post-card-share-modal-spinner" />
                        ) : isSelected ? (
                          <FaCheck className="post-card-share-modal-sent" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                {selectedUsers.size > 0 && (
                  <div className="post-card-share-modal-footer">
                    <button
                      className="post-card-share-modal-send-btn"
                      onClick={handleSendInviteToChat}
                      disabled={shareSendingTo.size > 0}
                    >
                      {shareSendingTo.size > 0
                        ? (t('common.sending') || 'Sending...')
                        : t('comunidades.share_chat_send', { n: selectedUsers.size })}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Ajustes (owner): mismo modal que el de creación, con una pestaña
          extra para las invitaciones. Todo el estado de los campos vive dentro
          del componente; al guardar devuelve la comunidad actualizada. ── */}
      <CommunitySettingsModal
        isOpen={showSettings && isOwner}
        onClose={() => setShowSettings(false)}
        community={community}
        onSaved={(updated) => {
          if (!updated) return;
          setCommunity(updated);
          setBannerBroken(false);
          // El listado cachea la comunidad: invalidarlo para que el nuevo
          // nombre/imagen aparezca sin esperar el TTL.
          clearCommunitiesListCache(user?.id);
        }}
        roles={roles}
        onCreateRole={() => setShowCreateRole(true)}
        onDeleteRole={handleDeleteRole}
        myInvite={myInvite}
        inviteUrl={inviteUrl}
        onCopyInvite={copyInvite}
        onCreateInvite={handleCreateInvite}
        onDeleteInvite={handleDeleteInvite}
        // El modal de "compartir por chat" es un overlay con z-index, no un
        // <dialog>: si se abriera con los ajustes abiertos quedaría detrás de
        // la capa superior. Se cierra primero.
        onShareInvite={() => {
          setShowSettings(false);
          openShareModal();
        }}
      />

      {/* Crear rol: se abre ENCIMA del modal de ajustes, así que también tiene
          que ser un <dialog> nativo (un div con z-index quedaría detrás de la
          capa superior del otro modal). */}
      <ModalShell
        isOpen={showCreateRole}
        onClose={() => setShowCreateRole(false)}
        className="community-create-modal community-role-modal"
      >
        <div className="fc-modal-header">
          <h3 className="fc-modal-title">{t('comunidades.role_create')}</h3>
          <div className="fc-modal-header-actions">
            <button type="button" className="fc-modal-save" onClick={handleCreateRole} disabled={!newRoleName.trim()}>
              {t('comunidades.role_save')}
            </button>
            <button type="button" className="fc-modal-close" onClick={() => setShowCreateRole(false)} aria-label={t('common.close')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div className="community-settings-body">
        <input
          className="fc-modal-input"
          value={newRoleName}
          onChange={(e) => setNewRoleName(e.target.value)}
          placeholder={t('comunidades.role_name')}
          maxLength={30}
        />
        <div className="community-role-color-row">
          <span>{t('comunidades.role_color')}</span>
          <input type="color" value={newRoleColor} onChange={(e) => setNewRoleColor(e.target.value)} />
        </div>
        <div className="community-role-perms">
          {['manage_posts', 'manage_members', 'manage_requests', 'manage_chat', 'manage_roles'].map((perm) => (
            <label key={perm} className="community-role-perm">
              <input
                type="checkbox"
                checked={newRolePerms.includes(perm)}
                onChange={(e) => setNewRolePerms((prev) =>
                  e.target.checked ? [...prev, perm] : prev.filter((x) => x !== perm)
                )}
              />
              {t(`comunidades.perm_${perm}`)}
            </label>
          ))}
        </div>
        </div>
      </ModalShell>

      {/* ── Confirmar salida ── */}
      {leavePending && (
        <ConfirmModal
          message={t('comunidades.leave_confirm')}
          onConfirm={() => { setLeavePending(false); handleLeave(); }}
          onCancel={() => setLeavePending(false)}
        />
      )}

      {/* ── Confirmar borrado de post ── */}
      {deletingPost && (
        <ConfirmModal
          message={t('comunidades.delete_post_confirm')}
          onConfirm={confirmDeletePost}
          onCancel={() => setDeletingPost(null)}
        />
      )}
    </div>
  );
}

// Icono de reloj reutilizado (evita importar otra librería)
function FaClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
