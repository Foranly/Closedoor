import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../services/i18n/useI18n';
import { supabase } from '../services/supabaseclient';
import {
  getPost,
  getCachedPost,
  setCachedPost,
  getComments,
  createComment,
  deleteComment,
  updateComment,
  isLiked,
  isReposted,
  isDisliked,
  likeComment,
  unlikeComment,
  isCommentLiked,
  dislikeComment,
  undislikeComment,
  isCommentDisliked,
  getCachedComments,
  setCachedComments,
  trackPostView,
  canCommentOnPost,
  dislikePost,
  undislikePost,
} from '../services/postService';
import { FaHeart, FaRegHeart, FaHeartBroken, FaReply, FaTrash, FaPen, FaRegComment, FaRegSadTear, FaArrowLeft, FaImage, FaEllipsisV, FaUpload, FaSpinner } from 'react-icons/fa';
import { toast } from 'react-toastify';
import PostCard from '../Resources/Components/PostCard';
import SafeImage from '../Resources/Components/SafeImage';
import Avatar from '../Resources/Components/Avatar';
import ProfileHoverCard from '../Resources/Components/ProfileHoverCard';
import Badge from '../Resources/Components/Badge';
import GifPicker from '../Resources/Components/GifPicker';
import RichText from '../Resources/Components/RichText';
import ConfirmModal from '../Resources/Components/ConfirmModal';
import Tooltip from '../Resources/Components/Tooltip';
import CreatePostModal from '../Resources/Components/CreatePostModal';
import PostVideoPlayer from '../Resources/Components/PostVideoPlayer';
import useMentionAutocomplete from '../hooks/useMentionAutocomplete';
import { getTimeAgo, formatClockTime, formatFullDate, IMG_RE, getEmbedUrl, getImageStyle, sanitizeUrl } from '../services/helpers';
import { showRateLimitToast } from '../services/rateLimitNotice';
import { uploadImage, uploadWithLocalPreview } from '../services/cdnService';
import { getClipboardImageFile } from '../services/clipboard';
import usePageTitle from '../../hooks/usePageTitle';
import '../Resources/Styles/post.css';
import '../Resources/Styles/skeleton.css';

/**
 * Video de un comentario/respuesta. Archivo directo (.mp4/.webm/.ogg) usa el
 * reproductor propio del post; YouTube/Vimeo va en iframe porque no se puede
 * controlar desde fuera.
 */
function CommentVideo({ url, className }) {
  const embed = getEmbedUrl(url);
  if (embed) {
    return (
      <iframe
        src={embed}
        className={className || 'comment-card-video'}
        title="Video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    );
  }
  return <PostVideoPlayer src={url} />;
}

export default function PostDetail() {
  const { postId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t, locale, hour24 } = useI18n();

  const [post, setPost] = useState(null);
  const [postLoading, setPostLoading] = useState(true);
  const [postError, setPostError] = useState(null);
  usePageTitle(postError ? t('post.not_found') : 'Post');

  // ── Comments con cache ──
  const [comments, setComments] = useState(() => {
    const cached = getCachedComments(postId);
    return cached?.comments || [];
  });
  const [commentLikes, setCommentLikes] = useState(() => {
    const cached = getCachedComments(postId);
    return cached?.commentLikes || {};
  });
  const [commentDislikes, setCommentDislikes] = useState(() => {
    const cached = getCachedComments(postId);
    return cached?.commentDislikes || {};
  });
  const [commentsLoading, setCommentsLoading] = useState(() => {
    return !getCachedComments(postId);
  });

  const [commentInput, setCommentInput] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [commentMediaUrl, setCommentMediaUrl] = useState('');
  const [commentShowMedia, setCommentShowMedia] = useState(false);
  const [showCommentGifPicker, setShowCommentGifPicker] = useState(false);
  const [commentUploading, setCommentUploading] = useState(false);
  const [replyUploading, setReplyUploading] = useState(null); // commentId being uploaded to
  const [confirmDeleteComment, setConfirmDeleteComment] = useState(null);
  const [confirmExternalLink, setConfirmExternalLink] = useState(null);
  const [showCreatePost, setShowCreatePost] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const handleCancelDeleteComment = useCallback(() => setConfirmDeleteComment(null), []);
  const handleCancelExternalLink = useCallback(() => setConfirmExternalLink(null), []);

  // ── Comment context menu ──
  const [commentMenuState, setCommentMenuState] = useState({ commentId: null, style: null });
  const [editingComment, setEditingComment] = useState(null); // { id, content }
  const [savingCommentEdit, setSavingCommentEdit] = useState(false);
  const commentMenuDropdownRef = useRef(null);

  const openCommentMenu = (e, commentId) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setCommentMenuState((prev) => {
      if (prev.commentId === commentId) {
        // Toggle close
        return { commentId: null, style: null };
      }
      return {
        commentId,
        style: {
          position: 'fixed',
          right: `${window.innerWidth - rect.right}px`,
          top: `${rect.bottom + 4}px`,
          zIndex: 9999,
        },
      };
    });
  };

  const closeCommentMenu = useCallback(() => {
    setCommentMenuState({ commentId: null, style: null });
  }, []);

  // Cerrar menú de comentario al hacer clic fuera o al scrollear
  useEffect(() => {
    if (!commentMenuState.commentId) return;
    const handleClick = (e) => {
      // Ignorar clics en botones del menú (el onClick se encarga)
      if (e.target.closest('[data-comment-menu-btn]')) return;
      if (commentMenuDropdownRef.current && !commentMenuDropdownRef.current.contains(e.target)) {
        closeCommentMenu();
      }
    };
    const closeOnScroll = () => closeCommentMenu();
    // Usar mousedown para cerrar antes de que se abra otro menú
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('scroll', closeOnScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('scroll', closeOnScroll, { capture: true });
    };
  }, [commentMenuState.commentId, closeCommentMenu]);
  const [commentPermission, setCommentPermission] = useState(null);
  const [commentPermissionLoading, setCommentPermissionLoading] = useState(true);
  const [replyTo, setReplyTo] = useState(null); // { id, username } — para form inline
  // Estado del form inline (reply)
  const [replyContent, setReplyContent] = useState('');
  const [replyMediaUrl, setReplyMediaUrl] = useState('');
  const [replyShowMedia, setReplyShowMedia] = useState(false);
  const [showReplyGifPicker, setShowReplyGifPicker] = useState(false);
  const [submittingReply, setSubmittingReply] = useState(false);

  // ── @Mention autocomplete hooks (main comment + reply) ──
  const mainMention = useMentionAutocomplete(user?.id || null, commentInput, setCommentInput);
  const replyMention = useMentionAutocomplete(user?.id || null, replyContent, setReplyContent);

  // ── Gallery de imágenes en comentarios ──
  const [commentGalleryUrls, setCommentGalleryUrls] = useState(null);
  const [commentGalleryIndex, setCommentGalleryIndex] = useState(0);

  const openCommentGallery = (e, urls, index) => {
    e.stopPropagation();
    setCommentGalleryUrls(urls);
    setCommentGalleryIndex(index);
  };
  const closeCommentGallery = () => setCommentGalleryUrls(null);
  const goCommentGalleryPrev = () => setCommentGalleryIndex((prev) => (prev > 0 ? prev - 1 : commentGalleryUrls.length - 1));
  const goCommentGalleryNext = () => setCommentGalleryIndex((prev) => (prev < commentGalleryUrls.length - 1 ? prev + 1 : 0));

  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [reposted, setReposted] = useState(false);
  const [expandedReplies, setExpandedReplies] = useState({}); // { [commentId]: boolean }

  // ── Deep-link a un comentario específico (?comment=id) ──
  const [searchParams] = useSearchParams();
  const targetCommentId = searchParams.get('comment');
  const [highlightedCommentId, setHighlightedCommentId] = useState(null);
  const handledCommentRef = useRef(null);
  const highlightTimerRef = useRef(null);
  const deepLinkAttemptsRef = useRef(0);
  const expandedPostRef = useRef(null); // postId al que pertenecen las expansiones activas

  // Cuando llega un ?comment=id, expandir la cadena de ancestros, hacer scroll
  // al comentario y remarcarlo brevemente.
  useEffect(() => {
    if (!targetCommentId || commentsLoading || !postId) return;

    const target = comments.find((c) => c.id === targetCommentId);
    if (!target) return;

    // Expandir todos los ancestros para que el comentario objetivo sea visible.
    // Se re-aplica en cada cambio de comments (idempotente) para que el deep-link
    // sobreviva a cualquier colapso de expansiones.
    const ancestors = [];
    let cur = target;
    while (cur?.parent_id) {
      ancestors.push(cur.parent_id);
      cur = comments.find((c) => c.id === cur.parent_id);
    }
    if (ancestors.length) {
      setExpandedReplies((prev) => {
        if (ancestors.every((id) => prev[id])) return prev;
        const next = { ...prev };
        ancestors.forEach((id) => { next[id] = true; });
        return next;
      });
      expandedPostRef.current = postId;
    }

    // Scroll + highlight solo la primera vez que se maneja este deep-link
    if (handledCommentRef.current === targetCommentId) return;

    // Esperar al render de las respuestas expandidas y luego scroll + highlight
    // (marcamos como manejado SOLO si el scroll llegó a realizarse, para poder
    // reintentar si el DOM aún no tenía el comentario renderizado)
    const t = setTimeout(() => {
      const el = document.getElementById(`comment-${targetCommentId}`);
      if (el) {
        handledCommentRef.current = targetCommentId;
        deepLinkAttemptsRef.current = 0;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedCommentId(targetCommentId);
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => setHighlightedCommentId(null), 4500);
      } else {
        // Blindaje: si el comentario nunca llega a renderizarse (p.ej. fue
        // eliminado), no reintentar indefinidamente en cada cambio de comments.
        deepLinkAttemptsRef.current += 1;
        if (deepLinkAttemptsRef.current >= 5) handledCommentRef.current = targetCommentId;
      }
    }, 300);

    return () => clearTimeout(t);
  }, [targetCommentId, comments, commentsLoading, postId]);

  // Resetear el deep-link al cambiar de post (y limpiar el timer pendiente)
  useEffect(() => {
    handledCommentRef.current = null;
    deepLinkAttemptsRef.current = 0;
    setHighlightedCommentId(null);
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, [postId]);

  // Limpiar el timer de highlight al desmontar (evita setState tras unmount)
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

  // Load post
  useEffect(() => {
    if (!postId) return;

    const cached = getCachedPost(postId);
    if (cached) {
      setPost(cached);
      setPostLoading(false);
    }

    const loadPost = async () => {
      setPostError(null);
      try {
        const data = await getPost(postId);
        setPost(data);
        setCachedPost(data);
      } catch (err) {
        setPostError(t('post.not_found'));
        setPost(null);
      } finally {
        setPostLoading(false);
      }
    };
    loadPost();
  }, [postId]);

  // Load comments + their likes (con cache + background refresh)
  const loadComments = useCallback(async () => {
    if (!postId) return;

    // Restaurar cache inmediato
    const cached = getCachedComments(postId);
    if (cached) {
      setComments(cached.comments || []);
      setCommentLikes(cached.commentLikes || {});
      setCommentsLoading(false);
    }

    try {
      const data = await getComments(postId);
      setComments(data);

      // Check which comments the user has liked/disliked
      let likes = {};
      let dislikes = {};
      if (user?.id && data.length > 0) {
        const [likeResults, dislikeResults] = await Promise.all([
          Promise.allSettled(data.map((c) => isCommentLiked(c.id, user.id))),
          Promise.allSettled(data.map((c) => isCommentDisliked(c.id, user.id))),
        ]);
        data.forEach((c, i) => {
          if (likeResults[i].status === 'fulfilled') likes[c.id] = likeResults[i].value;
          if (dislikeResults[i].status === 'fulfilled') dislikes[c.id] = dislikeResults[i].value;
        });
        setCommentLikes(likes);
        setCommentDislikes(dislikes);
      }

      // Guardar en cache
      setCachedComments(postId, data, likes, dislikes);

      // All replies start hidden by default — solo al cargar un post nuevo.
      // Si el fetch resuelve para el mismo post (cache + refresh), no colapsar
      // las expansiones activas (deep-link o manuales).
      if (expandedPostRef.current !== postId) {
        expandedPostRef.current = postId;
        setExpandedReplies({});
      }
    } catch (err) {
      console.error('Error loading comments:', err);
    } finally {
      setCommentsLoading(false);
    }
  }, [postId, user?.id]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  // Track post view (once per user) — guard useRef: evita el doble disparo
  // del efecto por React.StrictMode (dev monta 2 veces) o porque user?.id
  // cambia de undefined → id al resolver la auth. El dedup real lo hace la
  // DB (UNIQUE user_id+post_id), pero este guard evita llamadas redundantes
  // y el doble conteo si la DB aún corre la función vieja sin dedup (046).
  const viewTrackedRef = useRef(null);
  useEffect(() => {
    if (!postId || !user?.id) return;
    if (viewTrackedRef.current === postId) return;
    viewTrackedRef.current = postId;
    trackPostView(postId, user?.id);
  }, [postId, user?.id]);

  // Check if current user liked/reposted/disliked this post
  useEffect(() => {
    if (!user?.id || !postId) return;
    isLiked(postId, user.id).then(setLiked).catch(() => {});
    isReposted(postId, user.id).then(setReposted).catch(() => {});
    isDisliked(postId, user.id).then(setDisliked).catch(() => {});
  }, [user?.id, postId]);

  // Check comment permission when post loads
  useEffect(() => {
    if (!postId || !user?.id) {
      setCommentPermission(null);
      setCommentPermissionLoading(false);
      return;
    }
    setCommentPermissionLoading(true);
    canCommentOnPost(postId, user.id).then((result) => {
      setCommentPermission(result);
      setCommentPermissionLoading(false);
    }).catch(() => {
      setCommentPermission(null);
      setCommentPermissionLoading(false);
    });
  }, [postId, user?.id]);

  // ── Keyboard nav for comment gallery ──
  useEffect(() => {
    if (!commentGalleryUrls) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') { closeCommentGallery(); return; }
      if (e.key === 'ArrowLeft') goCommentGalleryPrev();
      if (e.key === 'ArrowRight') goCommentGalleryNext();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [commentGalleryUrls, commentGalleryIndex]);

  // Realtime: listen for new comments + updates on post/comments
  useEffect(() => {
    if (!postId) return;

    const channel = supabase
      .channel(`post-detail-${postId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'comments', filter: `post_id=eq.${postId}` },
        async (payload) => {
          try {
            const { data } = await supabase
              .from('comments')
              .select('*, profiles!comments_user_id_fkey (id, username, displayname, avatar_url, roles)')
              .eq('id', payload.new.id)
              .single();

            if (data) {
              setComments((prev) => {
                // Evitar duplicados: si el usuario acaba de crear el comentario
                // desde handleSubmitComment, el Realtime no debe agregarlo otra vez
                if (prev.some((c) => c.id === data.id)) return prev;
                return [...prev, data];
              });
              if (user?.id) {
                const liked = await isCommentLiked(data.id, user.id);
                setCommentLikes((prev) => ({ ...prev, [data.id]: liked }));
              }
            }
          } catch (err) {
            console.warn('Error fetching new comment:', err);
          }
        }
      )          .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts', filter: `id=eq.${postId}` },
        (payload) => {
          // Actualizar contadores del post en vivo
          const updated = payload.new;
          setPost((prev) => {
            if (!prev) return prev;
            const merged = {
              ...prev,
              likes_count: updated.likes_count,
              dislikes_count: updated.dislikes_count,
              reposts_count: updated.reposts_count,
              comments_count: updated.comments_count,
              views_count: updated.views_count,
            };
            setCachedPost(merged);
            return merged;
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'comments', filter: `post_id=eq.${postId}` },
        (payload) => {
          // Actualizar comment_likes_count en vivo
          const updated = payload.new;
          setComments((prev) =>
            prev.map((c) =>
              c.id === updated.id
                ? { ...c, comment_likes_count: updated.comment_likes_count }
                : c
            )
          );
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'comments', filter: `post_id=eq.${postId}` },
        (payload) => {
          // Eliminar comentario + sus replies del estado local en todos los clientes
          const deletedId = payload.old.id;
          setComments((prev) => prev.filter((c) => c.id !== deletedId && c.parent_id !== deletedId));
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [postId, user?.id]);

  const handleSubmitComment = async () => {
    const trimmed = commentInput.trim();
    if (!user?.id) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    if (!postId) return;

    const trimmedMedia = commentMediaUrl.trim();
    const isImage = IMG_RE.test(trimmedMedia);
    const isVideo = isAttachableVideoUrl(trimmedMedia);
    const imageUrl = isImage ? trimmedMedia : null;
    const videoUrl = isVideo ? trimmedMedia : null;
    // Allow posting just media (GIF/image) without text
    if (!trimmed && !imageUrl && !videoUrl) return;

    setSubmittingComment(true);
    try {
      const newComment = await createComment({
        postId,
        userId: user.id,
        content: trimmed,
        parentId: null,
        imageUrl,
        videoUrl,
      });
      setComments((prev) => [...prev, newComment]);
      setCommentInput('');
      setCommentMediaUrl('');
      setCommentShowMedia(false);
    } catch (err) {
      console.error('Error creating comment:', err);
      showRateLimitToast(t, err);
      if (err.message === 'comment_permission_denied') {
        const reason = err.permissionReason;
        if (reason === 'followers_only' || reason === 'comments_disabled') {
          // Re-check permission to sync the UI
          canCommentOnPost(postId, user.id).then(setCommentPermission).catch(() => {});
        }
      }
    } finally {
      setSubmittingComment(false);
    }
  };

  // ── Handle inline reply submission ──
  const handleSubmitReply = async () => {
    if (!replyTo) return;
    const trimmed = replyContent.trim();
    if (!user?.id) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    if (!postId) return;

    const trimmedMedia = replyMediaUrl.trim();
    const isImage = IMG_RE.test(trimmedMedia);
    const isVideo = isAttachableVideoUrl(trimmedMedia);
    const imageUrl = isImage ? trimmedMedia : null;
    const videoUrl = isVideo ? trimmedMedia : null;
    // Allow posting just media (GIF/image) without text
    if (!trimmed && !imageUrl && !videoUrl) return;

    setSubmittingReply(true);
    try {
      const newComment = await createComment({
        postId,
        userId: user.id,
        content: trimmed,
        parentId: replyTo.id,
        imageUrl,
        videoUrl,
      });
      setComments((prev) => [...prev, newComment]);
      // Expandir al padre para que la nueva reply sea visible
      setExpandedReplies((prev) => ({ ...prev, [replyTo.id]: true }));
      cancelReply();
    } catch (err) {
      console.error('Error creating reply:', err);
      showRateLimitToast(t, err);
    } finally {
      setSubmittingReply(false);
    }
  };

  // ── Start replying to a comment ──
  const startReply = (comment, isNested = false) => {
    const prepend = isNested ? `@${comment.profiles?.username} ` : '';
    setReplyTo({
      id: comment.id,
      username: comment.profiles?.username,
    });
    setReplyContent(prepend);
    setReplyMediaUrl('');
    setReplyShowMedia(false);
    setTimeout(() => {
      const el = document.getElementById(`reply-form-${comment.id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  };

  const cancelReply = () => {
    setReplyTo(null);
    setReplyContent('');
    setReplyMediaUrl('');
    setReplyShowMedia(false);
  };

  // ── CDN upload for comment media (optimistic: local preview, then background upload) ──
  // Recibe el File en vez del evento para que lo compartan el input file y el
  // pegado con Ctrl+V (services/clipboard.js): misma subida, mismo preview.
  const uploadCommentImageFile = async (file) => {
    if (!file || !user?.id) return;

    setCommentUploading(true);
    const toastId = toast.loading(t('upload.uploading') || 'Subiendo imagen...');

    try {
      // Mostrar preview local instantáneo mientras se sube en background
      const { localUrl, realUrlPromise } = uploadWithLocalPreview(file, user.id, 'post');
      setCommentMediaUrl(localUrl);
      setCommentShowMedia(true);

      // Esperar subida real en background y reemplazar URL
      const realUrl = await realUrlPromise;
      setCommentMediaUrl(realUrl);

      toast.update(toastId, {
        render: t('upload.uploaded') || 'Imagen subida',
        type: 'success',
        isLoading: false,
        autoClose: 2000,
      });
    } catch (err) {
      console.error('Comment CDN upload error:', err);
      toast.update(toastId, {
        render: err.message || 'Upload failed',
        type: 'error',
        isLoading: false,
        autoClose: 3000,
      });
    } finally {
      setCommentUploading(false); // solo habilitar submit cuando tenemos URL real
    }
  };

  // ── Input file del formulario de comentario ──
  const handleCommentMediaUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite volver a elegir el mismo archivo
    if (!file) return;
    await uploadCommentImageFile(file);
  };

  // ── Pegar imagen (Ctrl+V) en el comentario → misma subida que el input file ──
  // Si lo pegado es texto, `getClipboardImageFile` devuelve null y NO se llama a
  // preventDefault: el pegado normal del textarea sigue funcionando.
  const handleCommentPaste = (e) => {
    if (commentUploading) return; // evita subidas concurrentes (mismo guard que el input file)
    const file = getClipboardImageFile(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    uploadCommentImageFile(file);
  };

  // ── CDN upload for reply media (optimistic: local preview, then background upload) ──
  // Igual que el de comentario: File en vez de evento, para reusarlo al pegar.
  const uploadReplyImageFile = async (file, commentId) => {
    if (!file || !user?.id) return;

    setReplyUploading(commentId);
    const toastId = toast.loading(t('upload.uploading') || 'Subiendo imagen...');

    try {
      // Mostrar preview local instantáneo mientras se sube en background
      const { localUrl, realUrlPromise } = uploadWithLocalPreview(file, user.id, 'post');
      setReplyMediaUrl(localUrl);
      setReplyShowMedia(true);

      // Esperar subida real en background y reemplazar URL
      const realUrl = await realUrlPromise;
      setReplyMediaUrl(realUrl);

      toast.update(toastId, {
        render: t('upload.uploaded') || 'Imagen subida',
        type: 'success',
        isLoading: false,
        autoClose: 2000,
      });
    } catch (err) {
      console.error('Reply CDN upload error:', err);
      toast.update(toastId, {
        render: err.message || 'Upload failed',
        type: 'error',
        isLoading: false,
        autoClose: 3000,
      });
    } finally {
      setReplyUploading(null); // solo habilitar submit cuando tenemos URL real
    }
  };

  // ── Input file del formulario de respuesta ──
  const handleReplyMediaUpload = async (e, commentId) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await uploadReplyImageFile(file, commentId);
  };

  // ── Pegar imagen (Ctrl+V) en la respuesta → misma subida que el input file ──
  const handleReplyPaste = (e, commentId) => {
    if (replyUploading === commentId) return;
    const file = getClipboardImageFile(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    uploadReplyImageFile(file, commentId);
  };



  const handleDeleteComment = (commentId) => {
    setConfirmDeleteComment(commentId);
  };

  const startCommentEdit = (comment) => {
    closeCommentMenu();
    setEditingComment({ id: comment.id, content: comment.content || '' });
  };

  const cancelCommentEdit = () => setEditingComment(null);

  const saveCommentEdit = async () => {
    const id = editingComment?.id;
    const content = editingComment?.content.trim();
    if (!id || !content) return;
    setSavingCommentEdit(true);
    try {
      const updated = await updateComment(id, content);
      setComments((prev) => prev.map((c) => (c.id === id
        ? { ...c, content: updated?.content ?? content, updated_at: updated?.updated_at ?? c.updated_at }
        : c)));
      setEditingComment(null);
    } catch (err) {
      console.error('Error editing comment:', err);
      toast.error(t('post.edit_failed') || 'Could not edit comment');
    } finally {
      setSavingCommentEdit(false);
    }
  };

  const handleExternalLink = (url) => {
    setConfirmExternalLink(url);
  };

  const executeExternalLink = () => {
    const safeLink = sanitizeUrl(confirmExternalLink);
    if (safeLink) {
      window.open(safeLink, '_blank', 'noopener noreferrer');
    }
    setConfirmExternalLink(null);
  };

  const executeDeleteComment = async () => {
    const commentId = confirmDeleteComment;
    setConfirmDeleteComment(null);
    if (!commentId) return;
    try {
      await deleteComment(commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      console.error('Error deleting comment:', err);
      toast.error(t('post.comment_delete_failed') || 'Could not delete comment');
    }
  };

  const handleLikeComment = async (commentId) => {
    if (!user?.id) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    try {
      // Remove dislike if exists
      if (commentDislikes[commentId]) {
        await undislikeComment(commentId, user.id);
        setCommentDislikes((prev) => ({ ...prev, [commentId]: false }));
      }
      if (commentLikes[commentId]) {
        await unlikeComment(commentId, user.id);
        setCommentLikes((prev) => ({ ...prev, [commentId]: false }));
      } else {
        await likeComment(commentId, user.id);
        setCommentLikes((prev) => ({ ...prev, [commentId]: true }));
      }
    } catch (err) {
      console.error('Error toggling comment like:', err);
    }
  };

  const handleDislikeComment = async (commentId) => {
    if (!user?.id) {
      toast.info(t('auth.login_required'));
      navigate(`/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    try {
      // Remove like if exists
      if (commentLikes[commentId]) {
        await unlikeComment(commentId, user.id);
        setCommentLikes((prev) => ({ ...prev, [commentId]: false }));
      }
      if (commentDislikes[commentId]) {
        await undislikeComment(commentId, user.id);
        setCommentDislikes((prev) => ({ ...prev, [commentId]: false }));
      } else {
        await dislikeComment(commentId, user.id);
        setCommentDislikes((prev) => ({ ...prev, [commentId]: true }));
      }
    } catch (err) {
      console.error('Error toggling comment dislike:', err);
    }
  };

  const handleDislikeToggle = async (postId, nowDisliked) => {
    if (!user) return;
    try {
      if (nowDisliked) {
        await dislikePost(postId, user.id);
        setDisliked(true);
        setLiked(false);
      } else {
        await undislikePost(postId, user.id);
        setDisliked(false);
      }
    } catch (err) {
      console.error('Dislike error:', err);
    }
  };

  const handlePostUpdate = (updatedPost) => {
    if (updatedPost._editing) {
      setEditingPost(updatedPost);
      setShowCreatePost(true);
      return;
    }
    setPost(updatedPost);
    setCachedPost(updatedPost);
  };

  const handlePostCreated = async () => {
    // Refresh the post to get updated data
    try {
      const data = await getPost(postId);
      setPost(data);
      setCachedPost(data);
    } catch (err) {
      console.warn('Error refreshing post after edit:', err);
    }
  };

  // ── Safe back navigation: fall back to home if no history ──
  const goBack = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/');
    }
  }, [navigate]);

  const handlePostDelete = () => {
    goBack();
  };

  // ── Group comments into top-level + replies ──
  const topLevelComments = comments.filter((c) => !c.parent_id);
  const getReplies = (parentId) => comments.filter((c) => c.parent_id === parentId);

  // Total de respuestas de cada comentario, contando también las de las respuestas.
  const replyTotals = useMemo(() => {
    const childrenByParent = new Map();
    for (const c of comments) {
      if (!c.parent_id) continue;
      const kids = childrenByParent.get(c.parent_id);
      if (kids) kids.push(c.id);
      else childrenByParent.set(c.parent_id, [c.id]);
    }
    const totals = new Map();
    const visiting = new Set();
    const count = (id) => {
      if (totals.has(id)) return totals.get(id);
      if (visiting.has(id)) return 0; // evita bucles si los datos vienen mal
      visiting.add(id);
      let total = 0;
      for (const kid of childrenByParent.get(id) || []) total += 1 + count(kid);
      visiting.delete(id);
      totals.set(id, total);
      return total;
    };
    for (const c of comments) count(c.id);
    return totals;
  }, [comments]);



  // renderCommentContent is now handled by RichText component

  // Editado = updated_at posterior a created_at
  const isEdited = (c) => c?.updated_at && c?.created_at
    && new Date(c.updated_at).getTime() - new Date(c.created_at).getTime() > 1500;

  // ── Render a single reply (sangría tope en el nivel 3) ──
  const renderReplyCard = (reply, depth = 1) => {
    const isLikedComment = commentLikes[reply.id] || false;
    const isDislikedComment = commentDislikes[reply.id] || false;
    const isReplying = replyTo?.id === reply.id;
    const childReplies = getReplies(reply.id);
    const hasChildren = childReplies.length > 0;
    const totalReplies = replyTotals.get(reply.id) || 0;
    const childrenExpanded = expandedReplies[reply.id];
    const threadOpen = hasChildren && childrenExpanded;
    const contentClass = `comment-card-content${threadOpen ? ' comment-card-content--threaded' : ''}`;
    // Encontrar el autor del comentario padre
    const parentComment = comments.find((c) => c.id === reply.parent_id);
    const parentUsername = parentComment?.profiles?.username;
    const canDelete = user?.id && (user.id === reply.user_id || user.id === post?.user_id);
    const canEdit = user?.id && user.id === reply.user_id;
    const isOp = !!post?.user_id && reply.user_id === post.user_id;
    const isEditing = editingComment?.id === reply.id;
    const wasEdited = isEdited(reply);

    return (
      <div
        key={reply.id}
        id={`comment-${reply.id}`}
        className={`comment-card comment-card--reply ${highlightedCommentId === reply.id ? 'comment-card--highlight' : ''}`}
      >
        <a
          href={`/profile/${reply.profiles?.username}`}
          onClick={(e) => { e.preventDefault(); navigate(`/profile/${reply.profiles?.username}`); }}
          style={{ alignSelf: 'flex-start' }}
        >
          <ProfileHoverCard userId={reply.profiles?.id || reply.user_id}>
            <Avatar
              className="comment-card-avatar"
              src={reply.profiles?.avatar_url}
              alt={reply.profiles?.username || 'user'}
              style={getImageStyle(reply.profiles?.avatar_position)}
            />
          </ProfileHoverCard>
        </a>
        <div className={contentClass}>
          <div className="comment-card-header">
            <a
              className="comment-card-username"
              href={`/profile/${reply.profiles?.username}`}
              onClick={(e) => { e.preventDefault(); navigate(`/profile/${reply.profiles?.username}`); }}
            >
              {reply.profiles?.displayname || reply.profiles?.username || 'unknown'}
            </a>
            {reply.profiles?.roles && <Badge roles={reply.profiles.roles} />}
            {isOp && <span className="comment-card-op">{t('post.op')}</span>}
            <Tooltip text={formatFullDate(reply.created_at, locale, hour24)}>
              <span className="comment-card-time">
                {`${getTimeAgo(t, locale, reply.created_at)} · ${formatClockTime(reply.created_at, locale, hour24)}`}
              </span>
            </Tooltip>
            {wasEdited && <span className="comment-card-edited">{t('post.edited')}</span>}
            {parentUsername && (
              <span className="comment-card-replying-to">
                {t('post.replying_to', { user: `@${parentUsername}` })}
              </span>
            )}
          </div>
          {isEditing ? (
            <div className="comment-card-edit">
              <textarea
                className="comment-form-input"
                value={editingComment.content}
                onChange={(e) => setEditingComment((prev) => ({ ...prev, content: e.target.value }))}
                rows={2}
                maxLength={1000}
                autoFocus
              />
              <div className="comment-card-edit-actions">
                <button className="comment-form-cancel-reply" onClick={cancelCommentEdit}>{t('common.cancel')}</button>
                <button
                  className="comment-form-submit"
                  onClick={saveCommentEdit}
                  disabled={savingCommentEdit || !editingComment.content.trim()}
                >
                  {t('post.save')}
                </button>
              </div>
            </div>
          ) : (
          <p className="comment-card-text">
            <RichText
              text={reply.content}
              linkClass="comment-card-link"
              mentionClass="comment-card-mention"
              hashtagClass="comment-card-hashtag"
              onExternalLink={handleExternalLink}
            />
          </p>
          )}

          {/* ── Media (clickable for gallery) ── */}
          {reply.image_url && (
            <div className="comment-card-media">
              <SafeImage
                src={reply.image_url}
                alt={t('post.media_alt', { n: 1 })}
                className="comment-card-image"
                onClick={(e) => openCommentGallery(e, [reply.image_url], 0)}
              />
            </div>
          )}
          {reply.video_url && (
            <div className="comment-card-media">
              {isAttachableVideoUrl(reply.video_url) ? (
                <CommentVideo url={reply.video_url} />
              ) : (
                <SafeImage
                  src={reply.video_url}
                  alt={t('post.media_alt', { n: 1 })}
                  className="comment-card-image"
                  onClick={(e) => openCommentGallery(e, [reply.video_url], 0)}
                />
              )}
            </div>
          )}

          <div className="comment-card-actions-row">
            <Tooltip text={t('post.like')} placement="bottom">
              <button
                className={`comment-card-btn ${isLikedComment ? 'comment-card-btn--liked' : ''}`}
                onClick={() => handleLikeComment(reply.id)}
              >
                {isLikedComment ? <FaHeart /> : <FaRegHeart />}
                {reply.comment_likes_count > 0 && <span className="comment-card-btn-count">{reply.comment_likes_count}</span>}
              </button>
            </Tooltip>

            <Tooltip text={t('post.dislike')} placement="bottom">
              <button
                className={`comment-card-btn ${isDislikedComment ? 'comment-card-btn--disliked' : ''}`}
                onClick={() => handleDislikeComment(reply.id)}
              >
                <FaHeartBroken />
                {reply.comment_dislikes_count > 0 && <span className="comment-card-btn-count">{reply.comment_dislikes_count}</span>}
              </button>
            </Tooltip>

            <Tooltip text={t('post.reply')} placement="bottom">
              <button className="comment-card-btn" onClick={() => startReply(reply, true)}>
                <FaReply /> {t('post.reply')}
              </button>
            </Tooltip>

            {hasChildren && (
              <button
                className="comment-card-btn"
                onClick={() => setExpandedReplies((prev) => ({ ...prev, [reply.id]: !threadOpen }))}
              >
                {threadOpen ? t('post.hide_replies') : t('post.replies_count', { n: totalReplies })}
              </button>
            )}

            {/* Spacer flex para empujar el menú a la derecha */}
            {canDelete && <div style={{ flex: 1 }} />}

            {/* Context menu */}
            {canDelete && (
              <>
                <button
                  data-comment-menu-btn
                  className="comment-card-menu-btn"
                  onClick={(e) => openCommentMenu(e, reply.id)}
                  aria-label="Comment options"
                >
                  <FaEllipsisV />
                </button>
                {commentMenuState.commentId === reply.id && commentMenuState.style && createPortal(
                  <div
                    ref={commentMenuDropdownRef}
                    className="fc-dropdown"
                    style={commentMenuState.style}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canEdit && (
                      <button className="fc-dropdown-btn" onClick={() => startCommentEdit(reply)}>
                        <FaPen /> {t('post.edit')}
                      </button>
                    )}
                    <button
                      className="fc-dropdown-btn fc-dropdown-btn--danger"
                      onClick={() => handleDeleteComment(reply.id)}
                    >
                      <FaTrash /> {t('post.delete')}
                    </button>
                  </div>,
                  document.body
                )}
              </>
            )}
          </div>

          {/* ── Inline reply form ── */}
          {isReplying && (
            <div className="comment-card-reply-form" id={`reply-form-${reply.id}`}>
              <div className="comment-card-reply-info">
                {t('post.reply_to', { user: `@${replyTo?.username}` })}
                <button className="comment-form-cancel-reply" onClick={cancelReply}>{t('post.cancel_reply')}</button>
              </div>
              <textarea
                ref={replyMention.textareaRef}
                className="comment-form-input"
                value={replyContent}
                onChange={replyMention.handleContentChange}
                onKeyDown={replyMention.handleTextareaKeyDown}
                onPaste={(e) => handleReplyPaste(e, reply.id)}
                placeholder={t('post.reply_placeholder', { user: replyTo?.username })}
                title={t('post.paste_image_hint') || 'Paste an image with Ctrl+V'}
                rows={2}
                maxLength={1000}
              />
              {replyMention.mentionDropdown}
              <div className="comment-form-media-row">
                <div className="comment-form-media-btns">
                  <button
                    type="button"
                    className={`comment-form-media-btn ${replyShowMedia ? 'comment-form-media-btn--active' : ''}`}
                    onClick={() => setReplyShowMedia((s) => !s)}
                    title={t('post.comment_add_media')}
                  >
                    <FaImage />
                    {replyMediaUrl && (
                      <span className="comment-form-media-badge">{t('post.comment_media_added')}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`comment-form-media-btn ${showReplyGifPicker ? 'comment-form-media-btn--active' : ''}`}
                    onClick={() => setShowReplyGifPicker((s) => !s)}
                    title={t('create_post.add_gif') || 'GIF'}
                  >
                    <span style={{ fontWeight: 800, fontSize: '0.72rem', lineHeight: 1 }}>GIF</span>
                  </button>
                </div>
                <button
                  className="comment-form-submit"
                  onClick={handleSubmitReply}
                  disabled={submittingReply || (!replyContent.trim() && !replyMediaUrl.trim())}
                >
                  {submittingReply ? t('post.sending') : t('post.comment_post')}
                </button>
              </div>
              {showReplyGifPicker && (
                <div className="comment-form-gif-picker">
                  <GifPicker
                    onSelect={(gifUrl) => {
                      setReplyMediaUrl(gifUrl);
                      setReplyShowMedia(true);
                      setShowReplyGifPicker(false);
                    }}
                    onClose={() => setShowReplyGifPicker(false)}
                  />
                </div>
              )}
              {replyShowMedia && (
                <div className="comment-form-media-inputs">
                  <div className="comment-form-media-url-row">
                    <input className="comment-form-media-input" type="url" value={replyMediaUrl} onChange={(e) => setReplyMediaUrl(e.target.value)} placeholder={t('post.comment_media_url')} />
                    <label className="comment-form-cdn-upload-btn">
                      {replyUploading === reply.id ? <FaSpinner className="fc-spin" /> : <FaUpload />}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp"
                        onChange={(e) => handleReplyMediaUpload(e, reply.id)}
                        hidden
                        disabled={replyUploading === reply.id}
                      />
                    </label>
                  </div>
                  {replyMediaUrl && IMG_RE.test(replyMediaUrl) && (
                    <div className="comment-card-preview"><SafeImage src={replyMediaUrl} alt="Preview" hideOnError /></div>
                  )}
                  {replyMediaUrl && isAttachableVideoUrl(replyMediaUrl) && (
                    <div className="comment-card-preview"><CommentVideo url={replyMediaUrl} /></div>
                  )}
                </div>
              )}

            </div>
          )}

        </div>

        {threadOpen && (
          <div className={`comment-card-replies${depth >= 3 ? ' comment-card-replies--flat' : ''}`}>
            {childReplies.map((child) => renderReplyCard(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // ── Render a single comment (top-level) ──
  const renderComment = (comment) => {
    const isLikedComment = commentLikes[comment.id] || false;
    const isDislikedComment = commentDislikes[comment.id] || false;
    const directReplies = getReplies(comment.id);
    const totalReplies = replyTotals.get(comment.id) || 0;
    const threadOpen = !!expandedReplies[comment.id] && directReplies.length > 0;
    const contentClass = `comment-card-content${threadOpen ? ' comment-card-content--threaded' : ''}`;
    const isReplying = replyTo?.id === comment.id;
    const canDelete = user?.id && (user.id === comment.user_id || user.id === post?.user_id);
    const canEdit = user?.id && user.id === comment.user_id;
    const isOp = !!post?.user_id && comment.user_id === post.user_id;
    const isEditing = editingComment?.id === comment.id;
    const wasEdited = isEdited(comment);

    return (
      <div
        key={comment.id}
        id={`comment-${comment.id}`}
        className={`comment-card ${highlightedCommentId === comment.id ? 'comment-card--highlight' : ''}`}
      >
        <a
          href={`/profile/${comment.profiles?.username}`}
          onClick={(e) => { e.preventDefault(); navigate(`/profile/${comment.profiles?.username}`); }}
          style={{ alignSelf: 'flex-start' }}
        >
          <ProfileHoverCard userId={comment.profiles?.id || comment.user_id}>
            <Avatar
              className="comment-card-avatar"
              src={comment.profiles?.avatar_url}
              alt={comment.profiles?.username || 'user'}
              style={getImageStyle(comment.profiles?.avatar_position)}
            />
          </ProfileHoverCard>
        </a>
        <div className={contentClass}>
          <div className="comment-card-header">
            <a
              className="comment-card-username"
              href={`/profile/${comment.profiles?.username}`}
              onClick={(e) => { e.preventDefault(); navigate(`/profile/${comment.profiles?.username}`); }}
            >
              {comment.profiles?.displayname || comment.profiles?.username || 'unknown'}
            </a>
            {comment.profiles?.roles && <Badge roles={comment.profiles.roles} />}
            {isOp && <span className="comment-card-op">{t('post.op')}</span>}
            <Tooltip text={formatFullDate(comment.created_at, locale, hour24)}>
              <span className="comment-card-time">
                {`${getTimeAgo(t, locale, comment.created_at)} · ${formatClockTime(comment.created_at, locale, hour24)}`}
              </span>
            </Tooltip>
            {wasEdited && <span className="comment-card-edited">{t('post.edited')}</span>}
          </div>
          {isEditing ? (
            <div className="comment-card-edit">
              <textarea
                className="comment-form-input"
                value={editingComment.content}
                onChange={(e) => setEditingComment((prev) => ({ ...prev, content: e.target.value }))}
                rows={2}
                maxLength={1000}
                autoFocus
              />
              <div className="comment-card-edit-actions">
                <button className="comment-form-cancel-reply" onClick={cancelCommentEdit}>{t('common.cancel')}</button>
                <button
                  className="comment-form-submit"
                  onClick={saveCommentEdit}
                  disabled={savingCommentEdit || !editingComment.content.trim()}
                >
                  {t('post.save')}
                </button>
              </div>
            </div>
          ) : (
          <p className="comment-card-text">
            <RichText
              text={comment.content}
              linkClass="comment-card-link"
              mentionClass="comment-card-mention"
              hashtagClass="comment-card-hashtag"
              onExternalLink={handleExternalLink}
            />
          </p>
          )}

          {/* ── Media en comentario (clickable, gallery) ── */}
          {comment.image_url && (
            <div className="comment-card-media">
              <SafeImage
                src={comment.image_url}
                alt={t('post.media_alt', { n: 1 })}
                className="comment-card-image"
                onClick={(e) => openCommentGallery(e, [comment.image_url], 0)}
              />
            </div>
          )}
          {comment.video_url && (
            <div className="comment-card-media">
              {isAttachableVideoUrl(comment.video_url) ? (
                <CommentVideo url={comment.video_url} />
              ) : (
                <SafeImage
                  src={comment.video_url}
                  alt={t('post.media_alt', { n: 1 })}
                  className="comment-card-image"
                  onClick={(e) => openCommentGallery(e, [comment.video_url], 0)}
                />
              )}
            </div>
          )}

          <div className="comment-card-actions-row">
            {/* Like button */}
            <Tooltip text={t('post.like')} placement="bottom">
              <button
                className={`comment-card-btn ${isLikedComment ? 'comment-card-btn--liked' : ''}`}
                onClick={() => handleLikeComment(comment.id)}
              >
                {isLikedComment ? <FaHeart /> : <FaRegHeart />}
                {comment.comment_likes_count > 0 && (
                  <span className="comment-card-btn-count">{comment.comment_likes_count}</span>
                )}
              </button>
            </Tooltip>

            {/* Dislike button */}
            <Tooltip text={t('post.dislike')} placement="bottom">
              <button
                className={`comment-card-btn ${isDislikedComment ? 'comment-card-btn--disliked' : ''}`}
                onClick={() => handleDislikeComment(comment.id)}
              >
                <FaHeartBroken />
                {comment.comment_dislikes_count > 0 && <span className="comment-card-btn-count">{comment.comment_dislikes_count}</span>}
              </button>
            </Tooltip>

            {/* Reply button */}
            <Tooltip text={t('post.reply')} placement="bottom">
              <button
                className="comment-card-btn"
                onClick={() => startReply(comment, false)}
              >
                <FaReply /> {t('post.reply')}
              </button>
            </Tooltip>

            {/* Show replies count */}
            {directReplies.length > 0 && (
              <button
                className="comment-card-btn"
                onClick={() => setExpandedReplies((prev) => ({ ...prev, [comment.id]: !threadOpen }))}
              >
                {threadOpen ? t('post.hide_replies') : t('post.replies_count', { n: totalReplies })}
              </button>
            )}

            {/* Spacer flex para empujar el menú a la derecha */}
            {canDelete && <div style={{ flex: 1 }} />}

            {/* Context menu */}
            {canDelete && (
              <>
                <button
                  data-comment-menu-btn
                  className="comment-card-menu-btn"
                  onClick={(e) => openCommentMenu(e, comment.id)}
                  aria-label="Comment options"
                >
                  <FaEllipsisV />
                </button>
                {commentMenuState.commentId === comment.id && commentMenuState.style && createPortal(
                  <div
                    ref={commentMenuDropdownRef}
                    className="fc-dropdown"
                    style={commentMenuState.style}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canEdit && (
                      <button className="fc-dropdown-btn" onClick={() => startCommentEdit(comment)}>
                        <FaPen /> {t('post.edit')}
                      </button>
                    )}
                    <button
                      className="fc-dropdown-btn fc-dropdown-btn--danger"
                      onClick={() => handleDeleteComment(comment.id)}
                    >
                      <FaTrash /> {t('post.delete')}
                    </button>
                  </div>,
                  document.body
                )}
              </>
            )}
          </div>

          {/* ── Inline reply form ── */}
          {isReplying && (
            <div className="comment-card-reply-form" id={`reply-form-${comment.id}`}>
              <div className="comment-card-reply-info">
                {t('post.reply_to', { user: `@${replyTo?.username}` })}
                <button className="comment-form-cancel-reply" onClick={cancelReply}>{t('post.cancel_reply')}</button>
              </div>              <textarea
                ref={replyMention.textareaRef}
                className="comment-form-input"
                value={replyContent}
                onChange={replyMention.handleContentChange}
                onKeyDown={replyMention.handleTextareaKeyDown}
                placeholder={t('post.reply_placeholder', { user: replyTo?.username })}
                rows={2}
                maxLength={1000}
                onPaste={(e) => handleReplyPaste(e, comment.id)}
                title={t('post.paste_image_hint') || 'Paste an image with Ctrl+V'}
              />
              <div className="comment-form-media-row">
                <div className="comment-form-media-btns">
                  <button
                    type="button"
                    className={`comment-form-media-btn ${replyShowMedia ? 'comment-form-media-btn--active' : ''}`}
                    onClick={() => setReplyShowMedia((s) => !s)}
                    title={t('post.comment_add_media')}
                  >
                    <FaImage />
                    {replyMediaUrl && (
                      <span className="comment-form-media-badge">{t('post.comment_media_added')}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`comment-form-media-btn ${showReplyGifPicker ? 'comment-form-media-btn--active' : ''}`}
                    onClick={() => setShowReplyGifPicker((s) => !s)}
                    title={t('create_post.add_gif') || 'GIF'}
                  >
                    <span style={{ fontWeight: 800, fontSize: '0.72rem', lineHeight: 1 }}>GIF</span>
                  </button>
                </div>
                <button
                  className="comment-form-submit"
                  onClick={handleSubmitReply}
                  disabled={submittingReply || (!replyContent.trim() && !replyMediaUrl.trim())}
                >
                  {submittingReply ? t('post.sending') : t('post.comment_post')}
                </button>
              </div>
              {showReplyGifPicker && (
                <div className="comment-form-gif-picker">
                  <GifPicker
                    onSelect={(gifUrl) => {
                      setReplyMediaUrl(gifUrl);
                      setReplyShowMedia(true);
                      setShowReplyGifPicker(false);
                    }}
                    onClose={() => setShowReplyGifPicker(false)}
                  />
                </div>
              )}
              {replyShowMedia && (
                <div className="comment-form-media-inputs">
                  <div className="comment-form-media-url-row">
                    <input className="comment-form-media-input" type="url" value={replyMediaUrl} onChange={(e) => setReplyMediaUrl(e.target.value)} placeholder={t('post.comment_media_url')} />
                    <label className="comment-form-cdn-upload-btn">
                      {replyUploading === comment.id ? <FaSpinner className="fc-spin" /> : <FaUpload />}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp"
                        onChange={(e) => handleReplyMediaUpload(e, comment.id)}
                        hidden
                        disabled={replyUploading === comment.id}
                      />
                    </label>
                  </div>
                  {replyMediaUrl && IMG_RE.test(replyMediaUrl) && (
                    <div className="comment-card-preview"><SafeImage src={replyMediaUrl} alt="Preview" hideOnError /></div>
                  )}
                  {replyMediaUrl && isAttachableVideoUrl(replyMediaUrl) && (
                    <div className="comment-card-preview"><CommentVideo url={replyMediaUrl} /></div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        {threadOpen && (
          <div className="comment-card-replies">
            {directReplies.map((reply) => renderReplyCard(reply))}
          </div>
        )}
      </div>
    );
  };

  // ── Loading state ──
  if (postLoading) {
    return (
      <div className="post-detail-page">
        <div className="posts-skeleton">
          <div className="posts-skeleton-card">
            <div className="skeleton posts-skeleton-avatar" />
            <div className="posts-skeleton-lines">
              <div className="posts-skeleton-line posts-skeleton-line--short" />
              <div className="posts-skeleton-line" />
              <div className="posts-skeleton-line posts-skeleton-line--medium" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (postError || !post) {
    return (
      <div className="post-detail-page">
        <button className="post-detail-back" onClick={goBack}><FaArrowLeft /> {t('post.back')}</button>
        <div className="posts-empty">
          <span className="posts-empty-icon"><FaRegSadTear /></span>
          <p className="posts-empty-text">{postError || t('post.not_found')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="post-detail-page">
      <button className="post-detail-back" onClick={goBack}><FaArrowLeft /> {t('post.back')}</button>

      <PostCard
        post={post}
        liked={liked}
        disliked={disliked}
        reposted={reposted}
        fullContent
        onUpdate={handlePostUpdate}
        onDelete={handlePostDelete}
        onLikeToggle={(id, nowLiked) => setLiked(nowLiked)}
        onDislikeToggle={handleDislikeToggle}
        onRepostToggle={(id, nowReposted) => setReposted(nowReposted)}
      />

      {/* Comments Section */}
      <div className="comments-section">
        <h3 className="comments-title">{t('post.comments_title')}</h3>

        {/* Top-level comment form */}
        {user && commentPermissionLoading && (
          <div className="comment-form" style={{ opacity: 0.4, pointerEvents: 'none' }}>
            <div className="comment-form-input-wrapper">
              <div className="skeleton" style={{ width: '100%', height: 60, borderRadius: 8 }} />
            </div>
          </div>
        )}
        {user && !commentPermissionLoading && commentPermission?.allowed && (
          <div className="comment-form">
            <Avatar
              className="comment-form-avatar"
              src={profile?.avatar_url}
              alt="Your avatar"
              style={getImageStyle(profile?.avatar_position)}
            />
            <div className="comment-form-input-wrapper">
              <textarea
                ref={mainMention.textareaRef}
                className="comment-form-input"
                value={commentInput}
                onChange={mainMention.handleContentChange}
                onKeyDown={mainMention.handleTextareaKeyDown}
                onPaste={handleCommentPaste}
                placeholder={t('post.comment_placeholder')}
                title={t('post.paste_image_hint') || 'Paste an image with Ctrl+V'}
                rows={2}
                maxLength={1000}
              />
              {mainMention.mentionDropdown}
              <div className="comment-form-media-row">
                <div className="comment-form-media-btns">
                  <button
                    type="button"
                    className={`comment-form-media-btn ${commentShowMedia ? 'comment-form-media-btn--active' : ''}`}
                    onClick={() => setCommentShowMedia((s) => !s)}
                    title={t('post.comment_add_media')}
                  >
                    <FaImage />
                    {commentMediaUrl && (
                      <span className="comment-form-media-badge">{t('post.comment_media_added')}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`comment-form-media-btn ${showCommentGifPicker ? 'comment-form-media-btn--active' : ''}`}
                    onClick={() => setShowCommentGifPicker((s) => !s)}
                    title={t('create_post.add_gif') || 'GIF'}
                  >
                    <span style={{ fontWeight: 800, fontSize: '0.72rem', lineHeight: 1 }}>GIF</span>
                  </button>
                </div>
                <button
                  className="comment-form-submit"
                  onClick={handleSubmitComment}
                  disabled={submittingComment || (!commentInput.trim() && !commentMediaUrl.trim())}
                >
                  {submittingComment ? t('post.sending') : t('post.comment_post')}
                </button>
              </div>
              {showCommentGifPicker && (
                <div className="comment-form-gif-picker">
                  <GifPicker
                    onSelect={(gifUrl) => {
                      setCommentMediaUrl(gifUrl);
                      setCommentShowMedia(true);
                      setShowCommentGifPicker(false);
                    }}
                    onClose={() => setShowCommentGifPicker(false)}
                  />
                </div>
              )}
              {commentShowMedia && (
                <div className="comment-form-media-inputs">
                  <div className="comment-form-media-url-row">
                    <input
                      className="comment-form-media-input"
                      type="url"
                      value={commentMediaUrl}
                      onChange={(e) => setCommentMediaUrl(e.target.value)}
                      placeholder={t('post.comment_media_url')}
                    />
                    <label className="comment-form-cdn-upload-btn">
                      {commentUploading ? <FaSpinner className="fc-spin" /> : <FaUpload />}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp"
                        onChange={handleCommentMediaUpload}
                        hidden
                        disabled={commentUploading}
                      />
                    </label>
                  </div>
                  {commentMediaUrl && IMG_RE.test(commentMediaUrl) && (
                    <div className="comment-card-preview">
                      <SafeImage src={commentMediaUrl} alt="Preview" hideOnError />
                    </div>
                  )}
                  {commentMediaUrl && isAttachableVideoUrl(commentMediaUrl) && (
                    <div className="comment-card-preview">
                      <CommentVideo url={commentMediaUrl} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {user && !commentPermissionLoading && !commentPermission?.allowed && commentPermission && (
          <div className="comments-disabled-banner">
            {commentPermission.reason === 'comments_disabled' && t('post.comments_disabled')}
            {commentPermission.reason === 'followers_only' && t('post.comments_followers_only')}
          </div>
        )}

        {/* Comments list */}
        {commentsLoading ? (
          <div className="posts-skeleton">
            {[1, 2, 3].map((i) => (
              <div key={i} className="posts-skeleton-card" style={{ padding: '12px' }}>
                <div className="skeleton posts-skeleton-avatar" style={{ width: '32px', height: '32px' }} />
                <div className="posts-skeleton-lines">
                  <div className="posts-skeleton-line posts-skeleton-line--short" />
                  <div className="posts-skeleton-line" />
                </div>
              </div>
            ))}
          </div>
        ) : topLevelComments.length === 0 ? (
          <div className="posts-empty">
            <span className="posts-empty-icon"><FaRegComment /></span>
            <p className="posts-empty-text">{t('post.no_comments')}</p>
          </div>
        ) : (
          <div className="comments-list">
            {topLevelComments.map((comment) => renderComment(comment))}
          </div>
        )}
      </div>

      {/* ── Comment gallery lightbox ── */}      {/* ── Delete comment confirmation ── */}
      {confirmDeleteComment && (
        <ConfirmModal
          message={t('post.delete_comment_confirm')}
          onConfirm={executeDeleteComment}
          onCancel={handleCancelDeleteComment}
        />
      )}

      {/* ── External link confirmation ── */}
      {confirmExternalLink && (
        <ConfirmModal
          message={t('post.external_link_warning')}
          onConfirm={executeExternalLink}
          onCancel={handleCancelExternalLink}
        />
      )}

      {/* ── Create/Edit Post modal ── */}
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

      {commentGalleryUrls && createPortal(
        <div className="post-card-lightbox" onClick={(e) => { e.stopPropagation(); closeCommentGallery(); }}>
          {commentGalleryUrls.length > 1 && (
            <button
              className="post-card-gallery-nav post-card-gallery-nav--prev"
              onClick={(e) => { e.stopPropagation(); goCommentGalleryPrev(); }}
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
                src={commentGalleryUrls[commentGalleryIndex]}
                alt={t('post.full_media')}
                className="post-card-gallery-image"
                key={commentGalleryIndex}
                fallbackText={t('post.image_failed')}
              />
            </div>
            <div className="post-card-lightbox-actions">
              {commentGalleryUrls.length > 1 && (
                <span className="post-card-gallery-counter">
                  {commentGalleryIndex + 1} / {commentGalleryUrls.length}
                </span>
              )}
              <a
                href={commentGalleryUrls[commentGalleryIndex]}
                target="_blank"
                rel="noopener noreferrer"
                className="post-card-lightbox-btn"
                title={t('post.open_new_tab')}
                onClick={(e) => e.stopPropagation()}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
              <a
                href={commentGalleryUrls[commentGalleryIndex]}
                download
                className="post-card-lightbox-btn"
                title={t('post.download')}
                onClick={(e) => e.stopPropagation()}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </a>
              <button
                className="post-card-lightbox-btn post-card-lightbox-close"
                onClick={closeCommentGallery}
                title={t('post.close')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* ── Thumbnail strip ── */}
            {commentGalleryUrls.length > 1 && (
              <div className="post-card-gallery-thumbnails">
                {commentGalleryUrls.map((url, i) => (
                  <button
                    key={url}
                    className={`post-card-gallery-thumb ${i === commentGalleryIndex ? 'post-card-gallery-thumb--active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setCommentGalleryIndex(i); }}
                    aria-label={`Go to image ${i + 1}`}
                  >
                    <div className="post-card-gallery-thumb-inner">
                      <SafeImage src={url} alt={`Thumbnail ${i + 1}`} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {commentGalleryUrls.length > 1 && (
            <button
              className="post-card-gallery-nav post-card-gallery-nav--next"
              onClick={(e) => { e.stopPropagation(); goCommentGalleryNext(); }}
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
    </div>
  );
}

