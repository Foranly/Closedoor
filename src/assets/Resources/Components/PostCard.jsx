import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../hooks/useAuth';
import {
  likePost,
  unlikePost,
  deletePost,
  togglePinPost,
  repostPost,
  unrepostPost,
  savePost,
  unsavePost,
  dislikePost,
  undislikePost,
  likeComment,
  unlikeComment,
  dislikeComment,
  undislikeComment,
  setCachedPollVotes,
  getCachedPollVotes,
  setCachedPollVoters,
  getCachedPollVoters,
  clearCachedPollVoters,
} from '../../services/postService';
import { FaHeart, FaRegHeart, FaHeartBroken, FaComment, FaRetweet, FaThumbtack, FaEdit, FaTrash, FaEllipsisV, FaBookmark, FaRegBookmark, FaEye, FaLock, FaCheckCircle, FaRegCheckCircle, FaClock, FaBan, FaUserFriends, FaExclamationTriangle, FaShareAlt, FaCheck, FaTimes } from 'react-icons/fa';
import { toast } from 'react-toastify';
import Badge from './Badge';
import SafeImage from './SafeImage';
import { getCdnThumbUrl } from '../../services/cdnService';
import Avatar from './Avatar';
import PostMarkdown from './PostMarkdown';
import { closeUnbalancedMarkers } from '../../services/postMarkdown';
import LinkPreview from './LinkPreview';
import PostSongCard from './PostSongCard';
import PostVideoPlayer from './PostVideoPlayer';
import { useI18n } from '../../services/i18n/useI18n';
import { DEFAULT_AVATAR, getTimeAgo, formatClockTime, formatFullDate, getEmbedUrl as getEmbedUrlHelper, isVideoUrl as isVideoUrlHelper, IMG_RE, VID_RE, VID_RE_EXTENDED, getImageStyle, sanitizeUrl } from '../../services/helpers';import { decode as encryptDecode,
  decryptForUser,
  getCachedDecryptedContent,
  setCachedDecryptedContent,
} from '../../services/alphabetEncryption';
import { supabase } from '../../services/supabaseclient';
import { getOrCreateConversation, sendMessage } from '../../services/chatService';
import { getFollowing } from '../../services/followService';
import { isBlocked, getCachedBlockStatus, blockUser, unblockUser, cacheBlockStatus, clearBlockedListsCache } from '../../services/blockService';
import ConfirmModal from './ConfirmModal';
import ProfileHoverCard from './ProfileHoverCard';
import Tooltip from './Tooltip';
import './css/postCard.css';

const TRUNCATE_LENGTH = 500;

const PostCard = React.memo(function PostCard({
  post,
  liked: initialLiked = false,
  disliked: initialDisliked = false,
  reposted: initialReposted = false,
  saved: initialSaved = false,
  onUpdate,
  onDelete,
  onSaveToggle,
  onLikeToggle,
  onDislikeToggle,
  onRepostToggle,
  onBlockUser,
  compact = false,
  fullContent = false,
  repostInfo = null,
  replyInfo = null,
}) {
  const navigate = useNavigate();
  const { user, profile: currentProfile } = useAuth();
  const { t, locale, hour24 } = useI18n();
  const [liked, setLiked] = useState(initialLiked);
  const [likesCount, setLikesCount] = useState(post.likes_count || 0);
  const [disliked, setDisliked] = useState(initialDisliked);
  const [dislikesCount, setDislikesCount] = useState(post.dislikes_count || 0);
  const [reposted, setReposted] = useState(initialReposted);
  const [repostsCount, setRepostsCount] = useState(post.reposts_count || 0);
  const [saved, setSaved] = useState(initialSaved);
  const [showMenu, setShowMenu] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [galleryUrls, setGalleryUrls] = useState(null);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmExternalLink, setConfirmExternalLink] = useState(null);
  // ── Sensitive content reveal state ──
  const [sensitiveRevealed, setSensitiveRevealed] = useState(false);
  // ── Poll state (con caché síncrono en localStorage) ──
  // Nota: no podemos usar hasPoll aquí porque se define más abajo
  const initialPollCache = post.poll_data && typeof post.poll_data === 'object'
    ? getCachedPollVotes(post.id)
    : null;
  const [pollVotes, setPollVotes] = useState(() => initialPollCache?.votes || null); // [{ option_id, user_id }]
  const [pollUserVote, setPollUserVote] = useState(() => initialPollCache?.userVote || null); // option_id or null
  const [pollVotingLoading, setPollVotingLoading] = useState(false);
  const [showPollVoters, setShowPollVoters] = useState(false);
  const [pollVoters, setPollVoters] = useState([]);
  const [pollVotersLoading, setPollVotersLoading] = useState(false);
  const pollVotersRef = useRef(null);
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);
  const dropdownRef = useRef(null);
  const [dropdownStyle, setDropdownStyle] = useState(null);
  // ── Encrypted post state (con caché síncrono en memoria) ──
  // undefined = no en caché, null = sin acceso, string = contenido descifrado
  const initialCached = (post?.is_encrypted && user?.id)
    ? getCachedDecryptedContent(post.id, user.id)
    : undefined;
  const [decryptedContent, setDecryptedContent] = useState(
    initialCached !== undefined ? initialCached : null
  );
  const [decrypting, setDecrypting] = useState(
    initialCached === undefined && post?.is_encrypted === true && !!post?.encrypted_content
  );

  // ── Decrypt post content if user has access ──
  useEffect(() => {
    if (!post.is_encrypted || !post.encrypted_content || !post.allowed_users || !user?.id) {
      setDecryptedContent(null);
      setDecrypting(false);
      return;
    }

    // Nota: el autor también pasa por decryptForUser porque su ID está en allowed_users
    // (se agrega automáticamente en CreatePostModal al crear el post)

    // Verificar caché primero — evita loading en navegación entre posts ya vistos
    const cached = getCachedDecryptedContent(post.id, user.id);
    if (cached !== undefined) {
      setDecryptedContent(cached); // null o string
      setDecrypting(false);
      return;
    }

    // Resetear estado al cambiar de post (evita mostrar contenido descifrado del post anterior)
    setDecryptedContent(null);
    setDecrypting(true);

    decryptForUser(
      post.encrypted_content,
      post.encrypted_iv,
      post.user_id,
      post.allowed_users,
      user.id
    ).then((decrypted) => {
      setDecryptedContent(decrypted || null);
      setCachedDecryptedContent(post.id, user.id, decrypted || null);
    }).catch(() => {
      setDecryptedContent(null);
    }).finally(() => {
      setDecrypting(false);
    });
  }, [post.id, post.is_encrypted, post.encrypted_content, post.encrypted_iv, post.allowed_users, post.user_id, user?.id]);

  // ── Load poll data ──
  const hasPoll = post.poll_data && typeof post.poll_data === 'object';
  const isPollExpired = hasPoll && post.poll_data.expires_at && new Date(post.poll_data.expires_at) < new Date();

  useEffect(() => {
    if (!hasPoll) {
      setPollVotes(null);
      setPollUserVote(null);
      return;
    }

    // Si ya hay cache, no refetchear — se cargó síncrono en useState
    const cached = getCachedPollVotes(post.id);
    if (cached && cached.votes) return;

    const loadPollData = async () => {
      try {
        const { getPollVotes: fetchPollVotes, getPollUserVotes: fetchUserVotes } = await import('../../services/postService');
        const [votes, userVotes] = await Promise.all([
          fetchPollVotes(post.id),
          user?.id ? fetchUserVotes([post.id], user.id) : {},
        ]);
        setPollVotes(votes);
        const userVote = userVotes[post.id] || null;
        setPollUserVote(userVote);
        setCachedPollVotes(post.id, votes, userVote);
      } catch (err) {
        console.warn('Error loading poll data:', err);
      }
    };

    loadPollData();
  }, [post.id, hasPoll, user?.id]);

  // ── Realtime: escuchar votos nuevos en la poll ──
  useEffect(() => {
    if (!hasPoll) return;

    const channel = supabase
      .channel(`poll-${post.id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'poll_votes', filter: `post_id=eq.${post.id}` },
        (payload) => {
          setPollVotes(prev => {
            if (!prev) return [payload.new];
            if (prev.some(v => v.user_id === payload.new.user_id)) return prev;
            return [...prev, payload.new];
          });
          if (payload.new.user_id === user?.id) {
            setPollUserVote(payload.new.option_id);
          }
          // Invalidate voters cache on new vote
          clearCachedPollVoters(post.id);
        }
      )
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'poll_votes', filter: `post_id=eq.${post.id}` },
        (payload) => {
          setPollVotes(prev => {
            if (!prev) return [];
            return prev.filter(v => v.user_id !== payload.old.user_id);
          });
          if (payload.old.user_id === user?.id) {
            setPollUserVote(null);
          }
          // Invalidate voters cache on vote removal
          clearCachedPollVoters(post.id);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [post.id, hasPoll, user?.id]);

  // ── Sincronizar estado de la poll a localStorage cache ──
  useEffect(() => {
    if (hasPoll && pollVotes) {
      const currentUserVote = pollUserVote;
      setCachedPollVotes(post.id, pollVotes, currentUserVote);
    }
  }, [post.id, hasPoll, pollVotes, pollUserVote]);

  // ── Handle poll vote ──
  const handlePollVote = async (optionId) => {
    if (!user) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    if (pollVotingLoading) return;
    setPollVotingLoading(true);
    try {
      const { votePoll } = await import('../../services/postService');
      if (pollUserVote === optionId) {
        const { unvotePoll } = await import('../../services/postService');
        await unvotePoll(post.id, user.id);
        setPollUserVote(null);
        setPollVotes(prev => prev.filter(v => v.user_id !== user.id));
        clearCachedPollVoters(post.id);
      } else {
        await votePoll(post.id, optionId, user.id);
        setPollUserVote(optionId);
        setPollVotes(prev => {
          const filtered = prev.filter(v => v.user_id !== user.id);
          return [...filtered, { option_id: optionId, user_id: user.id }];
        });
        clearCachedPollVoters(post.id);
      }
    } catch (err) {
      console.error('Error voting on poll:', err);
    } finally {
      setPollVotingLoading(false);
    }
  };

  // Sincronizar estado liked/reposted cuando el padre refetchea (navegación)
  // Separado de los contadores para evitar race condition con Realtime:
  // cuando llega un UPDATE de likes_count desde Realtime, NO debe resetear liked a initialLiked
  useEffect(() => {
    setLiked(initialLiked);
  }, [initialLiked]);

  useEffect(() => {
    setDisliked(initialDisliked);
  }, [initialDisliked]);

  // Sincronizar contadores desde la DB (Realtime o refetch)
  useEffect(() => {
    setLikesCount(post.likes_count || 0);
  }, [post.likes_count]);

  useEffect(() => {
    setDislikesCount(post.dislikes_count || 0);
  }, [post.dislikes_count]);

  useEffect(() => {
    setReposted(initialReposted);
  }, [initialReposted]);

  useEffect(() => {
    setRepostsCount(post.reposts_count || 0);
  }, [post.reposts_count]);

  useEffect(() => {
    setSaved(initialSaved);
  }, [initialSaved]);

  // ── Calcular posición del dropdown y portearlo a body ──
  useEffect(() => {
    if (!showMenu) {
      setDropdownStyle(null);
      return;
    }
    const btn = menuBtnRef.current;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      setDropdownStyle({
        position: 'fixed',
        right: `${window.innerWidth - rect.right}px`,
        top: `${rect.bottom + 4}px`,
        zIndex: 9999,
      });
    }
  }, [showMenu]);

  // Cerrar menú al hacer clic fuera (incluye el portal)
  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e) => {
      const clickedButton = menuBtnRef.current?.contains(e.target);
      const clickedDropdown = dropdownRef.current?.contains(e.target);
      if (!clickedButton && !clickedDropdown) {
        setShowMenu(false);
      }
    };
    const closeOnScroll = () => setShowMenu(false);
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('scroll', closeOnScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('scroll', closeOnScroll, { capture: true });
    };
  }, [showMenu]);

  const isOwner = user?.id === post.user_id;
  // Si el post es del usuario actual, usar el perfil de AuthContext (se actualiza en tiempo real)
  // para que el avatar, username, etc. se reflejen al instante sin recargar.
  const profile = isOwner && currentProfile ? currentProfile : (post.profiles || {});
  const isPrivateProfile = profile?.is_private === true;
  const repostDisabled = isPrivateProfile && !isOwner;
  // Misma regla para compartir por chat: el post de una cuenta privada no se
  // reenvía a terceros. El dueño sí puede compartirlo con sus seguidores.
  const shareDisabled = isPrivateProfile && !isOwner;
  const timeAgo = useMemo(() => getTimeAgo(t, locale, post.created_at), [t, locale, post.created_at]);
  // En el detalle del post se añade la hora de publicación.
  const postedAt = useMemo(
    () => (fullContent ? formatClockTime(post.created_at, locale, hour24) : ''),
    [fullContent, post.created_at, locale, hour24]
  );
  // Fecha y hora exactas en el tooltip de la hora.
  const fullDate = useMemo(
    () => formatFullDate(post.created_at, locale, hour24),
    [post.created_at, locale, hour24]
  );

  // ── Determinar qué contenido mostrar (sin flicker) ──
  const isEncrypted = post.is_encrypted === true;
  // Mostrar loading mientras se descifra, nunca mostrar post.content (es la cadena numérica)
  const showEncryptedLoading = isEncrypted && decrypting && !decryptedContent;
  const showEncryptedLabel = isEncrypted && !decrypting && !decryptedContent;
  const displayContent = isEncrypted
    ? decryptedContent  // nunca hacer fallback a post.content
    : post.content;

  const handleCancelDelete = useCallback(() => setConfirmDelete(false), []);
  const handleCancelExternal = useCallback(() => setConfirmExternalLink(null), []);

  const handleLike = useCallback(async (e) => {
    e.stopPropagation();
    if (!user) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    // ── Optimistic update ──
    const wasLiked = liked;
    const wasDisliked = disliked;
    const prevLikesCount = likesCount;
    const prevDislikesCount = dislikesCount;

    if (wasLiked) {
      setLiked(false);
      setLikesCount((c) => Math.max(c - 1, 0));
    } else {
      setLiked(true);
      setLikesCount((c) => c + 1);
      if (wasDisliked) {
        setDisliked(false);
        setDislikesCount((c) => Math.max(c - 1, 0));
      }
    }

    try {
      if (replyInfo) {
        const commentTargetId = replyInfo.commentId || post.commentId || post.id;
        if (wasLiked) {
          await unlikeComment(commentTargetId, user.id);
        } else {
          await likeComment(commentTargetId, user.id);
        }
      } else {
        if (wasLiked) {
          await unlikePost(post.id, user.id);
        } else {
          await likePost(post.id, user.id);
        }
      }
      if (onLikeToggle) onLikeToggle(post.id, !wasLiked);
    } catch (err) {
      // Rollback on error
      setLiked(wasLiked);
      setLikesCount(prevLikesCount);
      if (wasDisliked) {
        setDisliked(true);
        setDislikesCount(prevDislikesCount);
      }
      console.error('Like error:', err);
    }
  }, [user, liked, disliked, likesCount, dislikesCount, post.id, post.commentId, replyInfo, onLikeToggle, navigate, t]);

  const handleDislike = useCallback(async (e) => {
    e.stopPropagation();
    if (!user) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    // ── Optimistic update ──
    const wasDisliked = disliked;
    const wasLiked = liked;
    const prevDislikesCount = dislikesCount;
    const prevLikesCount = likesCount;

    if (wasDisliked) {
      setDisliked(false);
      setDislikesCount((c) => Math.max(c - 1, 0));
    } else {
      setDisliked(true);
      setDislikesCount((c) => c + 1);
      if (wasLiked) {
        setLiked(false);
        setLikesCount((c) => Math.max(c - 1, 0));
      }
    }

    try {
      if (replyInfo) {
        const commentTargetId = replyInfo.commentId || post.commentId || post.id;
        if (wasDisliked) {
          await undislikeComment(commentTargetId, user.id);
        } else {
          await dislikeComment(commentTargetId, user.id);
        }
      } else {
        if (wasDisliked) {
          await undislikePost(post.id, user.id);
        } else {
          await dislikePost(post.id, user.id);
        }
      }
      if (onDislikeToggle) onDislikeToggle(post.id, !wasDisliked);
    } catch (err) {
      // Rollback on error
      setDisliked(wasDisliked);
      setDislikesCount(prevDislikesCount);
      if (wasLiked) {
        setLiked(true);
        setLikesCount(prevLikesCount);
      }
      console.error('Dislike error:', err);
    }
  }, [user, disliked, liked, dislikesCount, likesCount, post.id, post.commentId, replyInfo, onDislikeToggle, navigate, t]);

  const handleRepost = useCallback(async (e) => {
    e.stopPropagation();
    if (!user) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    // ── Optimistic update ──
    const wasReposted = reposted;
    const prevRepostsCount = repostsCount;

    if (wasReposted) {
      setReposted(false);
      setRepostsCount((c) => Math.max(c - 1, 0));
    } else {
      setReposted(true);
      setRepostsCount((c) => c + 1);
    }

    try {
      if (wasReposted) {
        await unrepostPost(post.id, user.id);
      } else {
        await repostPost(post.id, user.id);
      }
      if (onRepostToggle) onRepostToggle(post.id, !wasReposted);
    } catch (err) {
      // Rollback on error
      setReposted(wasReposted);
      setRepostsCount(prevRepostsCount);
      console.error('Repost error:', err);
    }
  }, [user, reposted, repostsCount, post.id, onRepostToggle, navigate, t]);

  const handlePin = async (e) => {
    e.stopPropagation();
    if (!user) return;
    const nowPinned = !post.is_pinned;
    try {
      await togglePinPost(post.id, user.id, post.is_pinned);
      if (onUpdate) {
        onUpdate({
          ...post,
          is_pinned: nowPinned,
          pinned_at: nowPinned ? new Date().toISOString() : null,
        });
      }
    } catch (err) {
      console.error('Pin error:', err);
      if (err.message) toast.error(err.message);
    }
    setShowMenu(false);
  };

  const handleDelete = useCallback(async (e) => {
    e.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const executeDelete = useCallback(async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await deletePost(post.id);
      toast.success(t('post.deleted_success'));
      if (onDelete) onDelete(post.id);
    } catch (err) {
      console.error('Delete error:', err);
      setDeleting(false);
    }
  }, [post.id, onDelete, t]);

  const handleExternalLink = useCallback((url) => {
    setConfirmExternalLink(url);
  }, []);

  const executeExternalLink = useCallback(() => {
    const safeLink = sanitizeUrl(confirmExternalLink);
    if (safeLink) {
      window.open(safeLink, '_blank', 'noopener noreferrer');
    }
    setConfirmExternalLink(null);
  }, [confirmExternalLink]);

  const handleSave = async (e) => {
    e.stopPropagation();
    if (!user) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    // ── Optimistic update ──
    const wasSaved = saved;

    setSaved(!wasSaved);

    try {
      if (wasSaved) {
        await unsavePost(post.id, user.id);
      } else {
        await savePost(post.id, user.id);
      }
      if (onSaveToggle) onSaveToggle(post.id, !wasSaved);
    } catch (err) {
      // Rollback on error
      setSaved(wasSaved);
      console.error('Save error:', err);
    }
  };

  // Cerrar galería con Escape y navegar con flechas
  useEffect(() => {
    if (!galleryUrls) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') { setGalleryUrls(null); return; }
      if (e.key === 'ArrowLeft') goGalleryPrev();
      if (e.key === 'ArrowRight') goGalleryNext();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);    },
    [galleryUrls, galleryIndex]
  );

  // ── Share to chat (multi-select) ──
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareFollowing, setShareFollowing] = useState([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const [shareSendingTo, setShareSendingTo] = useState(new Set());
  const shareModalRef = useRef(null);

  const openShareModal = useCallback(async (e) => {
    e.stopPropagation();
    setShowMenu(false);
    if (shareDisabled) {
      toast.error(t('post.share_private_forbidden') || "Cannot share a private profile's post");
      return;
    }
    if (!user) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    setShowShareModal(true);
    setSelectedUsers(new Set());
    setShareSendingTo(new Set());
    setShareLoading(true);
    try {
      const data = await getFollowing(user.id);
      // Filter out blocked users
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
  }, [user, navigate, t, shareDisabled]);

  // Toggle selection of a user for multi-send
  const toggleUserSelection = useCallback((userId) => {
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }, []);

  // Send to all selected users
  const handleSendToSelected = useCallback(async () => {
    if (selectedUsers.size === 0 || !user?.id) return;
    const targets = shareFollowing.filter(u => selectedUsers.has(u.id));
    setShareSendingTo(new Set(selectedUsers));
    let errors = 0;
    for (const targetUser of targets) {
      // Block check per user
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
        await sendMessage(convId, user.id, '', participantIds, null, post.id);
      } catch (err) {
        console.error('Error sharing post to', targetUser.username, ':', err);
        errors++;
      }
    }
    setShareSendingTo(new Set());
    if (errors === 0) {
      setShowShareModal(false);
      setSelectedUsers(new Set());
      setShareFollowing([]);
      toast.success(t('post.shared_to_chat') || 'Post shared!');
    } else {
      toast.error(t('post.share_error') || 'Error sharing post');
    }    }, [selectedUsers, shareFollowing, user?.id, post.id, t]);

  // Close share modal on outside click
  useEffect(() => {
    if (!showShareModal) return;
    const handleClick = (e) => {
      if (shareModalRef.current && !shareModalRef.current.contains(e.target)) {
        setShowShareModal(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showShareModal]);

  // Close poll voters modal on outside click
  useEffect(() => {
    if (!showPollVoters) return;
    const handleClick = (e) => {
      if (pollVotersRef.current && !pollVotersRef.current.contains(e.target)) {
        setShowPollVoters(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPollVoters]);

  const handleCardClick = () => {
    navigate(`/post/${post.id}`);
  };

  const handleEdit = (e) => {
    e.stopPropagation();
    if (onUpdate) onUpdate({ ...post, _editing: true });
    setShowMenu(false);
  };

  const isVideo = isVideoUrlHelper;
  const getEmbedUrl = getEmbedUrlHelper;

  // ── Obtener todas las URLs de imagen del post ──
  const getGalleryUrls = () => {
    const urls = (post.image_urls || (post.image_url ? [post.image_url] : []))
      .filter((url) => {
        if (!url) return false;
        return !VID_RE_EXTENDED.test(url);
      });
    // También incluir inline media si existe y no hay image_urls/image_url
    if (urls.length === 0 && inlineMedia && inlineMedia.type === 'image') {
      urls.push(inlineMedia.url);
    }
    // Incluir legacy video_url que es imagen
    if (urls.length === 0 && post.video_url && !isVideo(post.video_url)) {
      urls.push(post.video_url);
    }
    return urls;
  };

  const openGallery = (e, index) => {
    e.stopPropagation();
    const urls = getGalleryUrls();
    if (urls.length === 0) return;
    setGalleryUrls(urls);
    setGalleryIndex(Math.min(index, urls.length - 1));
  };

  const goGalleryPrev = () => {
    setGalleryIndex((prev) => (prev > 0 ? prev - 1 : galleryUrls.length - 1));
  };

  const goGalleryNext = () => {
    setGalleryIndex((prev) => (prev < galleryUrls.length - 1 ? prev + 1 : 0));
  };

  const closeGallery = () => {
    setGalleryUrls(null);
  };

  // Detectar media incrustado en el texto (para posts sin image_url/video_url separados)
  const detectInlineMedia = (text) => {
    if (post.image_url || post.video_url) return null;
    const urls = text?.match(/(https?:\/\/[^\s<]+)/gi) || [];
    for (const url of urls) {
      if (IMG_RE.test(url)) return { type: 'image', url };
      if (VID_RE.test(url)) return { type: 'video', url };
    }
    return null;
  };

  const inlineMedia = useMemo(() => detectInlineMedia(post.content), [post.content, post.image_url, post.video_url]);

  return (
    <article
      className={`post-card ${deleting ? 'post-card--deleting' : ''} ${compact ? 'post-card--compact' : ''}`}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') handleCardClick(); }}
    >
      {/* Repost / Reply banner */}
      {repostInfo ? (
        <div className="post-card-repost-banner">
          <FaRetweet className="post-card-repost-icon" />
          <span>{t('post.reposted_by', { user: repostInfo.repostedBy })}</span>
        </div>
      ) : replyInfo ? (
        <div className="post-card-repost-banner">
          <FaComment className="post-card-repost-icon" />
          <span>{t('post.reply_to', { user: replyInfo.replyTo })}</span>
        </div>
      ) : null}

      {/* Pin badge */}
      {post.is_pinned && (
        <div className="post-card-pin">
          <FaThumbtack />
          <span>{t('post.pinned')}</span>
        </div>
      )}

      <div className="post-card-body">
        {/* Avatar */}
        <Link
          to={`/profile/${profile?.username}`}
          className="post-card-avatar-link"
          onClick={(e) => e.stopPropagation()}
        >
          <ProfileHoverCard userId={profile?.id || post.user_id}>
            <Avatar
              className="post-card-avatar"
              src={profile?.avatar_url}
              alt={profile?.username || 'user'}
              style={getImageStyle(profile?.avatar_position)}
            />
          </ProfileHoverCard>
        </Link>

        {/* Content */}
        <div className="post-card-content">
          {/* Header: username + time + menu */}
          <div className="post-card-header">
            <Link
              to={`/profile/${profile?.username}`}
              className="post-card-author"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="post-card-username">{profile?.displayname || profile?.username || 'unknown'}</span>
              {profile?.roles && <Badge roles={profile.roles} />}
              <Tooltip text={fullDate}>
                <span className="post-card-time">{timeAgo}{postedAt && ` · ${postedAt}`}</span>
              </Tooltip>
            </Link>

            {/* ── Right-side: encrypted badge + menus ── */}
            <div className="post-card-header-right">
              {isEncrypted && (
                <Tooltip text={t('post.encrypted_hidden')} placement="bottom">
                  <span className="post-card-encrypted-badge">
                    <FaLock />
                  </span>
                </Tooltip>
              )}

              {isOwner && (
                <div className="post-card-menu-wrapper">
                  <button
                    ref={menuBtnRef}
                    className="post-card-menu-btn"
                    onClick={(e) => { e.stopPropagation(); setShowMenu((s) => !s); }}
                    aria-label="Post options"
                  >
                    <FaEllipsisV />
                  </button>
                  {/* Dropdown ported a body para evitar clipping */}
                  {showMenu && dropdownStyle && createPortal(
                    <div
                      ref={dropdownRef}
                      className="fc-dropdown"
                      style={{ ...dropdownStyle, minWidth: 170 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        className="fc-dropdown-btn"
                        onClick={openShareModal}
                        disabled={shareDisabled}
                        title={shareDisabled ? t('post.share_private_forbidden') : undefined}
                      >
                        <FaShareAlt /> {t('post.share')}
                      </button>
                      <button className="fc-dropdown-btn" onClick={handleEdit}><FaEdit /> {t('post.edit')}</button>
                      <button className="fc-dropdown-btn" onClick={handlePin}><FaThumbtack /> {post.is_pinned ? t('post.unpin') : t('post.pin')}</button>
                      <button className="fc-dropdown-btn" onClick={async (e) => {
                        await handleSave(e);
                        setShowMenu(false);
                      }}>
                        {saved ? <FaBookmark /> : <FaRegBookmark />}
                        {saved ? (t('post.unsave') || 'Quitar guardado') : t('post.save')}
                      </button>
                      <button className="fc-dropdown-btn fc-dropdown-btn--danger" onClick={handleDelete}><FaTrash /> {t('post.delete')}</button>
                    </div>,
                    document.body
                  )}
                </div>
              )}
              {/* ── Non-owner menu: save, share, block, report ── */}
              {!isOwner && (
                <div className="post-card-menu-wrapper post-card-menu--non-owner">
                  <button
                    ref={menuBtnRef}
                    className="post-card-menu-btn"
                    onClick={(e) => { e.stopPropagation(); setShowMenu((s) => !s); }}
                    aria-label="More options"
                  >
                    <FaEllipsisV />
                  </button>
                  {showMenu && dropdownStyle && createPortal(
                    <div
                      ref={dropdownRef}
                      className="fc-dropdown"
                      style={{ ...dropdownStyle, minWidth: 170 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button className="fc-dropdown-btn" onClick={async (e) => {
                        await handleSave(e);
                        setShowMenu(false);
                      }}>
                        {saved ? <FaBookmark /> : <FaRegBookmark />}
                        {saved ? (t('post.unsave') || 'Quitar guardado') : t('post.save')}
                      </button>
                      <button
                        className="fc-dropdown-btn"
                        onClick={openShareModal}
                        disabled={shareDisabled}
                        title={shareDisabled ? t('post.share_private_forbidden') : undefined}
                      >
                        <FaShareAlt /> {t('post.share')}
                      </button>
                      <button
                        className="fc-dropdown-btn"
                        onClick={async (e) => {
                          e.stopPropagation();
                          setShowMenu(false);
                          if (!user || !post?.user_id) return;
                          try {
                            await blockUser(user.id, post.user_id);
                            cacheBlockStatus(user.id, post.user_id, true);
                            clearBlockedListsCache(user.id);
                            onBlockUser?.(post.user_id);
                            const blockedUsername = post.profiles?.username || 'user';
                            const undoBlock = async () => {
                              try {
                                await unblockUser(user.id, post.user_id);
                                cacheBlockStatus(user.id, post.user_id, false);
                                clearBlockedListsCache(user.id);
                                toast.dismiss(toastId);
                                toast.success(t('post.user_unblocked') || 'Usuario desbloqueado');
                              } catch (err) {
                                console.error('Error undoing block:', err);
                                toast.error(t('post.undo_block_error') || 'Error al deshacer bloqueo');
                              }
                            };
                            const toastId = toast(
                              ({ closeToast }) => (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <span style={{ flex: 1 }}>{(t('post.user_blocked') || 'Usuario bloqueado').replace('{user}', blockedUsername)}</span>
                                  <button
                                    onClick={() => { undoBlock(); closeToast?.(); }}
                                    style={{
                                      background: 'var(--overlay-bg)',
                                      border: '1px solid var(--color-border)',
                                      borderRadius: 'var(--radius-sm, 6px)',
                                      color: 'var(--color-text)',
                                      cursor: 'pointer',
                                      fontFamily: 'inherit',
                                      fontSize: '0.8rem',
                                      fontWeight: 600,
                                      padding: '4px 10px',
                                      whiteSpace: 'nowrap',
                                      transition: 'background 0.12s ease',
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--overlay-bg-hover)'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = 'var(--overlay-bg)'}
                                  >
                                    {t('common.undo') || 'Deshacer'}
                                  </button>
                                </div>
                              ),
                              {
                                autoClose: 5000,
                                closeOnClick: false,
                                className: 'fc-toast',
                              }
                            );
                          } catch (err) {
                            console.error('Error blocking user:', err);
                          }
                        }}
                      >
                        <FaBan /> {t('post.block_user') || 'Bloquear usuario'}
                      </button>
                      <button className="fc-dropdown-btn" disabled style={{ opacity: 0.4, cursor: 'not-allowed' }}>
                        <FaExclamationTriangle /> {t('post.report') || 'Reportar'}
                      </button>
                    </div>,
                    document.body
                  )}
                </div>
              )}
            </div>
          </div>

          {/* (badge moved inside header above) */}

          {/* Text content: markdown GFM + @menciones/#hashtags (truncado a TRUNCATE_LENGTH en borde de palabra) */}
          <div className="post-card-text">
            {showEncryptedLoading ? (
              <span className="post-card-encrypted-loading">{t('common.loading') || 'Descifrando...'}</span>
            ) : showEncryptedLabel ? (
              <span className="post-card-encrypted-text">
                <FaLock style={{ marginRight: 4, fontSize: '0.65rem' }} /> {t('post.encrypted_hidden_placeholder')}
              </span>
            ) : (() => {
              const text = displayContent || '';
              const shouldTruncate = !fullContent && text.length > TRUNCATE_LENGTH;
              const truncateAt = shouldTruncate
                ? text.lastIndexOf(' ', TRUNCATE_LENGTH) || TRUNCATE_LENGTH
                : text.length;
              const displayed = shouldTruncate
                ? closeUnbalancedMarkers(`${text.slice(0, truncateAt)}...`)
                : text;
              return (
                <>
                  <PostMarkdown
                    text={displayed}
                    skipUrls={getSkipUrls(post)}
                    onExternalLink={handleExternalLink}
                  />
                  {shouldTruncate && (
                    <span
                      className="post-card-show-more"
                      onClick={(e) => { e.stopPropagation(); navigate(`/post/${post.id}`); }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); navigate(`/post/${post.id}`); } }}
                    >
                      {t('post.show_more') || 'Mostrar más'}
                    </span>
                  )}
                </>
              );
            })()}
          </div>

          {/* ── Link preview (OG card) para URLs no-media visibles en el contenido ── */}
          {!showEncryptedLoading && !showEncryptedLabel && (() => {
            const text = displayContent || '';
            const urls = text.match(/(https?:\/\/[^\s<]+)/gi) || [];
            const skip = getSkipUrls(post);
            const nonMediaUrls = urls.filter((u) => !skip.includes(u));
            if (nonMediaUrls.length === 0) return null;
            // Si el post está truncado, solo mostrar el preview si la URL es visible
            const shouldTruncate = !fullContent && text.length > TRUNCATE_LENGTH;
            const truncateAt = shouldTruncate
              ? text.lastIndexOf(' ', TRUNCATE_LENGTH) || TRUNCATE_LENGTH
              : text.length;
            const displayedText = shouldTruncate ? text.slice(0, truncateAt) : text;
            const url = nonMediaUrls[0];
            if (!displayedText.includes(url)) return null;
            return (
              <div className="post-card-link-preview">
                <LinkPreview url={url} onExternalLink={handleExternalLink} />
              </div>
            );
          })()}

          {/* ── Scheduled badge (solo futuro, ya-publicados son posts normales sin badge) ── */}
          {post.scheduled_at && new Date(post.scheduled_at) > new Date() && (
            <div className="post-card-scheduled-badge">
              <FaClock />
              <span>
                {(t('post.scheduled_future') || 'Programado: {date}').replace('{date}', new Date(post.scheduled_at).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: !hour24 }))}
              </span>
            </div>
          )}

          {/* ── Poll ── */}
          {hasPoll && (() => {
            const totalVotes = pollVotes ? pollVotes.length : 0;
            const isPostOwner = user?.id === post.user_id;
            const showAllResults = true;
            return (
            <div className="post-card-poll" onClick={(e) => e.stopPropagation()}>
              <p className="post-card-poll-question">{post.poll_data.question}</p>
              <div className="post-card-poll-options">
                {(() => {
                  const hasVoted = !!pollUserVote;
                  return post.poll_data.options.map((option) => {
                    const votesCount = pollVotes ? pollVotes.filter(v => v.option_id === option.id).length : 0;
                    const percentage = totalVotes > 0 ? Math.round((votesCount / totalVotes) * 100) : 0;
                    const isSelected = pollUserVote === option.id;
                    const isDimmed = showAllResults && !isSelected;
                    const showResults = showAllResults;

                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`post-card-poll-option ${isSelected ? 'post-card-poll-option--selected' : ''} ${isDimmed && !isSelected ? 'post-card-poll-option--attenuated' : ''} ${showResults ? 'post-card-poll-option--results' : ''}`}
                      onClick={(e) => { e.stopPropagation(); handlePollVote(option.id); }}
                      disabled={isPollExpired || !user || pollVotingLoading}
                    >
                      <div className="post-card-poll-option-row">
                        <span className="post-card-poll-option-check">
                          {isSelected ? <FaCheckCircle /> : <FaRegCheckCircle />}
                        </span>
                        <span className="post-card-poll-option-text">{option.text}</span>
                        {showResults && (
                          <span className="post-card-poll-option-pct">{votesCount} · {percentage}%</span>
                        )}
                      </div>
                      {showResults && (
                        <div className="post-card-poll-bar-track">
                          <div
                            className="post-card-poll-bar-fill"
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      )}
                    </button>
                  );
                });
              })()}
              </div>
              <div className="post-card-poll-footer">
                {totalVotes > 0 ? (
                  isPostOwner ? (
                    <button className="post-card-poll-count post-card-poll-count--clickable" onClick={async (e) => {
                      e.stopPropagation();
                      if (pollVotersLoading) return;
                      // Try cache first (show modal directly if cached, no loading state)
                      const cachedVoters = getCachedPollVoters(post.id);
                      if (cachedVoters) {
                        setPollVoters(cachedVoters);
                        setShowPollVoters(true);
                        return;
                      }
                      setPollVotersLoading(true);
                      setShowPollVoters(true);
                      try {
                        const { getPollVotersWithProfiles } = await import('../../services/postService');
                        const voters = await getPollVotersWithProfiles(post.id);
                        setPollVoters(voters);
                        setCachedPollVoters(post.id, voters);
                      } catch (err) {
                        console.warn('Error loading poll voters:', err);
                        setPollVoters([]);
                      } finally {
                        setPollVotersLoading(false);
                      }
                    }}>
                      {totalVotes} {totalVotes === 1 ? t('post.poll_vote_singular') || 'voto' : t('post.poll_vote_plural') || 'votos'}
                    </button>
                  ) : (
                    <span className="post-card-poll-count">{totalVotes} {totalVotes === 1 ? t('post.poll_vote_singular') || 'voto' : t('post.poll_vote_plural') || 'votos'}</span>
                  )
                ) : (
                  <span className="post-card-poll-count">0 {t('post.poll_vote_plural') || 'votos'}</span>
                )}
                {isPollExpired ? (
                  <span className="post-card-poll-expired">{t('post.poll_ended') || 'Finalizada'}</span>
                ) : post.poll_data.expires_at ? (
                  <span className="post-card-poll-expires">
                    {t('post.poll_ends') || 'Termina'}: {new Date(post.poll_data.expires_at).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: !hour24 })}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })()}

          {/* ── Media sections wrapped for sensitive overlay ── */}
          <div className="post-card-media-wrapper">
            {post.is_sensitive && !sensitiveRevealed && (
              <div className="post-card-sensitive-overlay" onClick={(e) => e.stopPropagation()}>
                <div className="post-card-sensitive-overlay-content">
                  <FaExclamationTriangle className="post-card-sensitive-overlay-icon" />
                  <span className="post-card-sensitive-overlay-label">{t('post.sensitive_warning') || 'Sensitive content'}</span>
                  <button
                    type="button"
                    className="post-card-sensitive-reveal-btn"
                    onClick={(e) => { e.stopPropagation(); setSensitiveRevealed(true); }}
                  >
                    {t('post.sensitive_click') || 'Reveal'}
                  </button>
                </div>
              </div>
            )}
            {/* Multiple images from post.image_urls (grid) */}
            {renderImageGrid(post, openGallery, t)}

          {/* Video from post.video_url */}
          {post.video_url && isVideo(post.video_url) && (
            <div className="post-card-media">
              {getEmbedUrl(post.video_url) ? (
                <iframe
                  src={getEmbedUrl(post.video_url)}
                  className="post-card-video"
                  title="Video"
                  allowFullScreen
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <PostVideoPlayer src={post.video_url} />
              )}
            </div>
          )}

          {/* Legacy: single image from post.image_url */}
          {post.image_url && !post.image_urls?.length && !post.video_url && (
            <div className="post-card-media">
              <SafeImage
                src={getCdnThumbUrl(post.image_url)}
                alt={t('post.media_alt', { n: 1 })}
                className="post-card-image"
                onClick={(e) => openGallery(e, 0)}
              />
            </div>
          )}

          {/* Legacy: image in post.video_url */}
          {post.video_url && !isVideo(post.video_url) && !post.image_url && (
            <div className="post-card-media">
              <SafeImage
                src={getCdnThumbUrl(post.video_url)}
                alt={t('post.media_alt', { n: 1 })}
                className="post-card-image"
                onClick={(e) => openGallery(e, 0)}
              />
            </div>
          )}

          {/* Legacy: inline media detection */}
          {inlineMedia && !post.image_url && !post.image_urls?.length && !post.video_url && (
            <div className="post-card-media">
              {inlineMedia.type === 'image' ? (
                <SafeImage
                  src={getCdnThumbUrl(inlineMedia.url)}
                  alt={t('post.media_alt', { n: 1 })}
                  className="post-card-image"
                  onClick={(e) => openGallery(e, 0)}
                />
              ) : (
                <PostVideoPlayer src={inlineMedia.url} />
              )}
            </div>
          )}

          </div>{/* ── end post-card-media-wrapper ── */}

          {/* ── Canción adjunta (reproductor global: stream completo en escritorio, preview de 30 s en web) ── */}
          {post.song?.title && <PostSongCard song={post.song} />}

          {/* Actions */}
          <div className="post-card-actions">
            <Tooltip text={t('post.like')} placement="bottom">
              <button
                className={`post-card-action ${liked ? 'post-card-action--liked' : ''}`}
                onClick={handleLike}
              >
                <span className="post-card-action-icon">{liked ? <FaHeart /> : <FaRegHeart />}</span>
                <span className="post-card-action-count">{likesCount}</span>
              </button>
            </Tooltip>

            <Tooltip text={t('post.dislike') || 'Dislike'} placement="bottom">
              <button
                className={`post-card-action ${disliked ? 'post-card-action--disliked' : ''}`}
                onClick={handleDislike}
              >
                <span className="post-card-action-icon"><FaHeartBroken /></span>
                <span className="post-card-action-count">{dislikesCount}</span>
              </button>
            </Tooltip>

            {!replyInfo && (
              <>
                <Tooltip
                  text={
                    post.comments_allowed === 'nobody'
                      ? t('post.comments_disabled')
                      : post.comments_allowed === 'followers'
                        ? t('post.comments_followers_only')
                        : t('post.comment')
                  }
                  placement="bottom"
                >
                  <button
                    className={`post-card-action ${post.comments_allowed && post.comments_allowed !== 'everyone' ? 'post-card-action--restricted' : ''}`}
                    onClick={(e) => { e.stopPropagation(); navigate(`/post/${post.id}`); }}
                  >
                    <span className="post-card-action-icon">
                      {post.comments_allowed === 'nobody' ? <FaBan /> : post.comments_allowed === 'followers' ? <FaUserFriends /> : <FaComment />}
                    </span>
                    <span className="post-card-action-count">{post.comments_count || 0}</span>
                  </button>
                </Tooltip>

                <Tooltip
                  text={repostDisabled ? t('post.repost_private_forbidden') : t('post.repost')}
                  placement="bottom"
                >
                  <button
                    className={`post-card-action ${reposted ? 'post-card-action--reposted' : ''} ${repostDisabled ? 'post-card-action--disabled' : ''}`}
                    onClick={repostDisabled ? undefined : handleRepost}
                    disabled={repostDisabled}
                  >
                    <span className="post-card-action-icon"><FaRetweet /></span>
                    <span className="post-card-action-count">{repostsCount}</span>
                  </button>
                </Tooltip>

                <Tooltip text={saved ? t('post.saved') : t('post.save')} placement="bottom">
                  <button
                    className={`post-card-action post-card-action--save ${saved ? 'post-card-action--saved' : ''}`}
                    onClick={handleSave}
                  >
                    <span className="post-card-action-icon">{saved ? <FaBookmark /> : <FaRegBookmark />}</span>
                  </button>
                </Tooltip>

                <Tooltip text={t('post.views_count') || 'Views'} placement="bottom">
                  <button type="button" className="post-card-action post-card-action--view">
                    <span className="post-card-action-icon"><FaEye /></span>
                    <span className="post-card-action-count">{post.views_count || 0}</span>
                  </button>
                </Tooltip>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Delete confirmation modal (portado a body) ── */}
      {confirmDelete && createPortal(
        <ConfirmModal
          message={t('post.delete_confirm')}
          onConfirm={executeDelete}
          onCancel={handleCancelDelete}
        />,
        document.body
      )}

      {/* ── External link confirmation (portado a body) ── */}
      {confirmExternalLink && createPortal(
        <ConfirmModal
          message={t('post.external_link_warning')}
          onConfirm={executeExternalLink}
          onCancel={handleCancelExternal}
        />,
        document.body
      )}

      {/* ── Share to chat modal ── */}
      {showShareModal && createPortal(
        <div className="post-card-share-modal-overlay" onClick={() => setShowShareModal(false)}>
          <div className="post-card-share-modal" ref={shareModalRef} onClick={(e) => e.stopPropagation()}>
            <div className="post-card-share-modal-header">
              <h3 className="post-card-share-modal-title">{t('post.share') || 'Share'}</h3>
              <button className="post-card-share-modal-close" onClick={() => setShowShareModal(false)}>
                <FaTimes />
              </button>
            </div>
            {shareLoading ? (
              <div className="post-card-share-modal-status">{t('common.loading')}</div>
            ) : shareFollowing.length === 0 ? (
              <div className="post-card-share-modal-status">
                <FaUserFriends className="post-card-share-modal-empty-icon" />
                <p>{t('post.share_no_following') || 'No users to share with'}</p>
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
                      onClick={handleSendToSelected}
                      disabled={shareSendingTo.size > 0}
                    >
                      {shareSendingTo.size > 0
                        ? (t('common.sending') || 'Sending...')
                        : (t('post.share_send_to', { n: selectedUsers.size }) || `Send to ${selectedUsers.size}`)}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* ── Poll voters modal (grouped by option) ── */}
      {showPollVoters && createPortal(
        <div className="post-card-poll-voters-overlay" onClick={() => setShowPollVoters(false)}>
          <div className="post-card-poll-voters" ref={pollVotersRef} onClick={(e) => e.stopPropagation()}>
            <div className="post-card-poll-voters-header">
              <h4 className="post-card-poll-voters-title">{t('post.poll_voters_title') || 'Votantes'}</h4>
              <button className="post-card-poll-voters-close" onClick={() => setShowPollVoters(false)}>
                <FaTimes />
              </button>
            </div>
            {pollVotersLoading ? (
              <div className="post-card-poll-voters-loading">{t('common.loading') || 'Cargando...'}</div>
            ) : pollVoters.length === 0 ? (
              <div className="post-card-poll-voters-empty">{t('post.poll_voters_empty') || 'No hay votantes'}</div>
            ) : (
              <div className="post-card-poll-voters-list">
                {(() => {
                  const options = post.poll_data?.options || [];
                  // Build map: option_id -> { text, voters: [] }
                  const groups = {};
                  options.forEach(o => {
                    groups[o.id] = { text: o.text, voters: [] };
                  });

                  // Deduplicate voters by user_id across all options (a user votes once)
                  const seenUsers = new Set();
                  pollVoters.forEach(v => {
                    if (!seenUsers.has(v.user_id)) {
                      seenUsers.add(v.user_id);
                      if (groups[v.option_id]) {
                        groups[v.option_id].voters.push(v);
                      }
                    }
                  });

                  const totalVotes = pollVotes ? pollVotes.length : 0;

                  return options.map((option) => {
                    const group = groups[option.id];
                    const voters = group?.voters || [];
                    const votesCount = pollVotes ? pollVotes.filter(v => v.option_id === option.id).length : 0;
                    const percentage = totalVotes > 0 ? Math.round((votesCount / totalVotes) * 100) : 0;

                    return (
                      <div key={option.id} className="post-card-poll-voters-group">
                        <div className="post-card-poll-voters-group-header">
                          <span className="post-card-poll-voters-group-name">{option.text}</span>
                          <span className="post-card-poll-voters-group-stats">{votesCount} · {percentage}%</span>
                        </div>
                        {voters.length === 0 ? (
                          <div className="post-card-poll-voters-group-empty">
                            {t('post.poll_voters_no_votes') || 'Sin votos'}
                          </div>
                        ) : (
                          voters.map((voter) => {
                            const profile = voter.profiles || {};
                            return (
                              <Link
                                key={voter.user_id}
                                to={`/profile/${profile.username}`}
                                className="post-card-poll-voter"
                                onClick={() => setShowPollVoters(false)}
                              >
                                <Avatar
                                  src={profile.avatar_url}
                                  alt={profile.username || 'user'}
                                  className="post-card-poll-voter-avatar"
                                />
                                <span className="post-card-poll-voter-username">{profile.username || 'Unknown'}</span>
                              </Link>
                            );
                          })
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* ── Galería de imágenes (portal a body para evitar backdrop-filter issue) ── */}
      {galleryUrls && createPortal(
        <div className="post-card-lightbox" onClick={(e) => { e.stopPropagation(); closeGallery(); }}>
          {/* Prev button */}
          {galleryUrls.length > 1 && (
            <button
              className="post-card-gallery-nav post-card-gallery-nav--prev"
              onClick={(e) => { e.stopPropagation(); goGalleryPrev(); }}
              aria-label="Previous"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}

          <div className="post-card-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <div className="post-card-gallery-image-area">
              <SafeImage
                src={galleryUrls[galleryIndex]}
                alt={t('post.full_media')}
                className="post-card-gallery-image"
                key={galleryIndex}
                fallbackText={t('post.image_failed')}
              />
            </div>
            <div className="post-card-lightbox-actions">
              {galleryUrls.length > 1 && (
                <span className="post-card-gallery-counter">
                  {galleryIndex + 1} / {galleryUrls.length}
                </span>
              )}
              <Tooltip text={t('post.open_new_tab')} placement="bottom">
                <a
                  href={galleryUrls[galleryIndex]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="post-card-lightbox-btn"
                  onClick={(e) => e.stopPropagation()}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              </Tooltip>
              <Tooltip text={t('post.download')} placement="bottom">
                <a
                  href={galleryUrls[galleryIndex]}
                  download
                  className="post-card-lightbox-btn"
                  onClick={(e) => e.stopPropagation()}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </a>
              </Tooltip>
              <Tooltip text={t('post.close')} placement="bottom">
                <button
                  className="post-card-lightbox-btn post-card-lightbox-close"
                  onClick={closeGallery}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </Tooltip>
            </div>

            {/* ── Thumbnail strip ── */}
            {galleryUrls.length > 1 && (
              <div className="post-card-gallery-thumbnails">
                {galleryUrls.map((url, i) => (
                  <button
                    key={url}
                    className={`post-card-gallery-thumb ${i === galleryIndex ? 'post-card-gallery-thumb--active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setGalleryIndex(i); }}
                    aria-label={`Go to image ${i + 1}`}
                  >
                    <div className="post-card-gallery-thumb-inner">
                      <SafeImage src={getCdnThumbUrl(url)} alt={`Thumbnail ${i + 1}`} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Next button */}
          {galleryUrls.length > 1 && (
            <button
              className="post-card-gallery-nav post-card-gallery-nav--next"
              onClick={(e) => { e.stopPropagation(); goGalleryNext(); }}
              aria-label="Next"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
        </div>,
        document.body
      )}
    </article>
  );
});
export default PostCard;

// Genera URLs a ocultar del texto porque ya se renderizan como media aparte
function getSkipUrls(post) {
  const text = post?.content;
  if (!text) return [];
  const urls = text.match(/(https?:\/\/[^\s<]+)/gi) || [];
  const result = [];
  for (const url of urls) {
    if (IMG_RE.test(url) || VID_RE.test(url) || (post.video_url && url === post.video_url)) {
      result.push(url);
    }
  }
  return result;
}

// ── Imagen de feed con thumbnail + ratio real ──
// Cache de módulo: dims naturales medidas en carga para imágenes sin
// image_meta (posts legacy) — compartida entre todas las PostCards.
const naturalDimsCache = new Map();

/**
 * Celda de imagen del feed.
 * - fixed=true (mosaicos de 2-4): celda 16/10 + cover, src=thumbnail.
 * - fixed=false (imagen única): aspect-ratio con el ratio REAL (image_meta
 *   o medición onLoad para posts legacy) → sin recorte y sin salto de layout.
 */
function FeedImage({ url, alt, onClick, meta, fixed }) {
  const [measured, setMeasured] = useState(() => naturalDimsCache.get(url) || null);

  const dims = (meta?.w > 0 && meta?.h > 0)
    ? meta
    : measured;

  const handleLoad = (e) => {
    if (fixed || naturalDimsCache.has(url)) return;
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      const d = { w: img.naturalWidth, h: img.naturalHeight };
      naturalDimsCache.set(url, d);
      setMeasured(d);
    }
  };

  return (
    <div
      className="post-card-image-grid-item"
      style={!fixed && dims ? { aspectRatio: `${dims.w} / ${dims.h}`, maxHeight: '80vh' } : undefined}
    >
      <SafeImage
        src={getCdnThumbUrl(url)}
        alt={alt}
        onClick={onClick}
        onLoad={handleLoad}
      />
    </div>
  );
}

// ── Render image grid (up to 4 images) ──
function renderImageGrid(post, onImageClick, t) {
  const urls = (post.image_urls || (post.image_url ? [post.image_url] : []))
    .filter((url) => {
      if (!url) return false;
      return !VID_RE_EXTENDED.test(url);
    });
  if (!urls.length) return null;

  const handleClick = onImageClick || ((e) => e.stopPropagation());

  // Mapa url → dimensiones reales (posts nuevos con image_meta)
  const dimsMap = new Map(
    (Array.isArray(post.image_meta) ? post.image_meta : [])
      .filter((m) => m && m.u && m.w > 0 && m.h > 0)
      .map((m) => [m.u, m])
  );

  const gridClass = `post-card-image-grid post-card-image-grid--${Math.min(urls.length, 4)}`;
  const isSingle = urls.length === 1;

  return (
    <div className={gridClass}>
      {urls.slice(0, 4).map((url, i) => (
        <FeedImage
          key={url}
          url={url}
          alt={t('post.media_alt', { n: i + 1 })}
          meta={dimsMap.get(url)}
          fixed={!isSingle}
          onClick={(e) => handleClick(e, i)}
        />
      ))}
    </div>
  );
}
