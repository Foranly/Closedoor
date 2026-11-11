import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ModalShell from './ModalShell';
import { createPost, updatePost, notifyMentions, notifyEncryptedAdd, extractMentions, getMentionUserIds } from '../../services/postService';
import { searchProfiles } from '../../services/userService';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { FaImage, FaTimes, FaPlus, FaMinus, FaLink, FaLock, FaUnlock, FaUserPlus, FaCheck, FaSearch, FaRegHeart, FaHeartBroken, FaComment, FaRetweet, FaEye, FaPoll, FaCalendarAlt, FaClock, FaGlobe, FaUserFriends, FaBan, FaExclamationTriangle, FaBookmark, FaRegBookmark, FaUpload, FaSpinner, FaMusic, FaVideo, FaBold, FaItalic, FaStrikethrough, FaCode, FaListUl, FaQuoteRight } from 'react-icons/fa';
import SafeImage from './SafeImage';
import Avatar from './Avatar';
import Badge from './Badge';
import GifPicker from './GifPicker';
import SongPicker from './SongPicker';
import SongArtwork from './SongArtwork';
import { withPreviewFallback } from '../../services/musicService';
import { IMG_RE, VID_RE, YOUTUBE_PATTERN, VIMEO_PATTERN, extractUrls, detectMediaFromContent, getRateLimitInfo, getEmbedUrl as getEmbedUrlHelper } from '../../services/helpers';
import { getClipboardImageFile } from '../../services/clipboard';
import ConfirmModal from './ConfirmModal';
import PostMarkdown from './PostMarkdown';
import { applyMarkdownEdit } from '../../services/postMarkdown';
import { toast } from 'react-toastify';
import { uploadImage, uploadWithLocalPreview } from '../../services/cdnService';
import Tooltip from './Tooltip';
import { encode as encryptEncode, encryptForUsers, decryptForUser } from '../../services/alphabetEncryption';
import { supabase, dbPublic } from '../../services/supabaseclient';
import useMentionAutocomplete from '../../hooks/useMentionAutocomplete';
import './css/modal.css';
import './css/createPostModal.css';

const IMAGE_EXTENSIONS = IMG_RE;

/**
 * Lee las dimensiones reales de un video por URL (best-effort). Se guardan en
 * posts.video_meta para que el feed reserve el hueco antes de cargar el
 * archivo. Los embeds (YouTube/Vimeo) no exponen tamaño: devuelven null.
 */
function loadVideoMeta(url) {
  return new Promise((resolve) => {
    if (!url || getEmbedUrlHelper(url)) {
      resolve(null);
      return;
    }
    const video = document.createElement('video');
    let settled = false;
    const finish = (meta) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load?.();
      resolve(meta);
    };
    const timer = setTimeout(() => finish(null), 4000);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      finish(video.videoWidth && video.videoHeight
        ? { width: video.videoWidth, height: video.videoHeight }
        : null);
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

export default function CreatePostModal({
  isOpen,
  onClose,
  onSuccess,
  editPost = null,
  userId,
}) {
  const { t, filterEncrypted } = useI18n();
  const { profile } = useAuth();
  const currentUserId = userId; // alias para usar en callbacks
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewType, setPreviewType] = useState(null);
  const [imageUrls, setImageUrls] = useState(['']);
  const [showImageSection, setShowImageSection] = useState(false);
  const [uploadingPostIndex, setUploadingPostIndex] = useState(-1);
  const [mediaLimitWarning, setMediaLimitWarning] = useState(null);
  // Dimensiones reales de las imágenes subidas (url → {u,w,h}) para
  // posts.image_meta: permite aspect-ratio sin recorte en las PostCards
  const imageMetaRef = useRef(new Map());

  // ── @ Mention autocomplete (shared hook) ──
  const {
    textareaRef,
    mentionDropdownRef,
    handleContentChange: mentionHandleChange,
    handleTextareaKeyDown,
    mentionDropdown,
    followedUsers,
  } = useMentionAutocomplete(isOpen ? userId : null, content, setContent);

  // ── Encrypted post state ──
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [allowedUsers, setAllowedUsers] = useState([]); // { id, username, avatar_url }
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userSearchResults, setUserSearchResults] = useState([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [showUserSearch, setShowUserSearch] = useState(false);
  const userSearchTimeoutRef = useRef(null);

  // ── Poll state ──
  const [showPoll, setShowPoll] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [pollExpiresAt, setPollExpiresAt] = useState('');

  // ── Comment permissions state ──
  const [commentsAllowed, setCommentsAllowed] = useState('everyone');

  // ── Scheduling state ──
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');

  // ── GIF picker state ──
  const [showGifPicker, setShowGifPicker] = useState(false);

  // ── Canción adjunta al post ──
  // Se guarda en posts.song y la reproduce el reproductor global: preview de
  // 30 s en la web, canción entera desde el servidor local en la app de
  // escritorio.
  const [song, setSong] = useState(null);
  const [showSongPicker, setShowSongPicker] = useState(false);

  // ── Video por URL ──
  // Solo por URL: el CDN todavía no procesa video, así que no hay subida.
  const [videoUrl, setVideoUrl] = useState('');

  // ── Sensitive content state ──
  const [isSensitive, setIsSensitive] = useState(false);

  // ── Unsaved changes confirmation state ──
  const [pendingClose, setPendingClose] = useState(false);

  const hasUnsavedContent = useCallback(() => {
    return content.trim().length > 0 || getValidImageUrls().length > 0 || !!song || !!videoUrl.trim() || allowedUsers.length > 0 || showPoll || showSchedule || isSensitive;
  }, [content, imageUrls, allowedUsers, showPoll, showSchedule, song, videoUrl]);

  const confirmClose = useCallback(() => {
    if (hasUnsavedContent()) {
      setPendingClose(true);
    } else {
      onClose();
    }
  }, [hasUnsavedContent, onClose]);

  // Ref estable para evitar que el efecto se re-ejecute al cambiar de dependencias
  const confirmCloseRef = useRef(confirmClose);
  confirmCloseRef.current = confirmClose;

  const executeClose = useCallback(() => {
    setPendingClose(false);
    onClose();
  }, [onClose]);

  // ── Cerrar con Escape y scroll locking: manejado por ModalShell (<dialog> nativo)

  const isEditing = !!editPost;

  const displayName = profile?.username || t('common.username');

  // ── Image URL management (must be before updatePreview) ──
  const getValidImageUrls = () => {
    return imageUrls.filter((url) => url.trim() && IMAGE_EXTENSIONS.test(url.trim()));
  };

  const validVideoUrl = isAttachableVideoUrl(videoUrl) ? videoUrl.trim() : '';


  // Preview the media found in current content
  const updatePreview = useCallback((text) => {
    const { imageUrl, videoUrl: detectedVideoUrl } = detectMediaFromContent(text);
    const validCount = getValidImageUrls().length;
    if (imageUrl || detectedVideoUrl) {
      if (validCount >= 4) {
        setMediaLimitWarning(t('create_post.media_limit_warning'));
        setPreviewUrl(null);
        setPreviewType(null);
        return;
      }
      setMediaLimitWarning(null);
      if (imageUrl) {
        setPreviewUrl(imageUrl);
        setPreviewType('image');
      } else if (detectedVideoUrl) {
        setPreviewUrl(detectedVideoUrl);
        setPreviewType('video');
      }
    } else {
      setPreviewUrl(null);
      setPreviewType(null);
      setMediaLimitWarning(null);
    }
  }, [t, imageUrls]);



  // ── User search with debounce ──
  const handleUserSearchChange = useCallback((e) => {
    const query = e.target.value;
    setUserSearchQuery(query);
    if (query.trim().length < 2) {
      setUserSearchResults([]);
      return;
    }
    setSearchingUsers(true);
    if (userSearchTimeoutRef.current) clearTimeout(userSearchTimeoutRef.current);
    userSearchTimeoutRef.current = setTimeout(async () => {
      const results = await searchProfiles(query.trim(), currentUserId);
      // Filtrar usuarios que ya están seleccionados o que no permiten añadirlos a posts encriptados
      const selectedIds = new Set(allowedUsers.map(u => u.id));
      let filtered = results.filter(u => !selectedIds.has(u.id));
      if (filtered.length > 0) {
        const { data: prefs } = await dbPublic
          .from('profiles')
          .select('id, allow_encrypted_add')
          .in('id', filtered.map(u => u.id));
        const disabledAdd = new Set(
          (prefs || []).filter(p => p.allow_encrypted_add === false).map(p => p.id)
        );
        filtered = filtered.filter(u => !disabledAdd.has(u.id));
      }
      setUserSearchResults(filtered);
      setSearchingUsers(false);
    }, 300);
  }, [currentUserId, allowedUsers]);

  const addAllowedUser = useCallback((user) => {
    setAllowedUsers(prev => {
      if (prev.some(u => u.id === user.id)) return prev;
      return [...prev, { id: user.id, username: user.username, avatar_url: user.avatar_url }];
    });
    setUserSearchQuery('');
    setUserSearchResults([]);
    setShowUserSearch(false);
  }, []);

  const removeAllowedUser = useCallback((userId) => {
    setAllowedUsers(prev => prev.filter(u => u.id !== userId));
  }, []);

  useEffect(() => {
    if (isOpen) {
      if (editPost) {
        setContent(editPost.content || '');
        updatePreview(editPost.content || '');
        const existingUrls = editPost.image_urls || (editPost.image_url ? [editPost.image_url] : []);
        setImageUrls(existingUrls.length > 0 ? existingUrls : ['']);
        setShowImageSection(existingUrls.length > 0);

        setCommentsAllowed(editPost.comments_allowed || 'everyone');
        setIsSensitive(!!editPost.is_sensitive);
        setSong(editPost.song && editPost.song.title ? editPost.song : null);
        setVideoUrl(editPost.video_url || '');

        // ── Encrypted post: descifrar contenido + mantener estado ──
        const wasEncrypted = editPost.is_encrypted === true;
        setIsEncrypted(wasEncrypted);
        if (wasEncrypted && editPost.encrypted_content && userId) {
          // Descifrar el contenido para mostrarlo al autor
          decryptForUser(
            editPost.encrypted_content,
            editPost.encrypted_iv,
            editPost.user_id,
            editPost.allowed_users,
            userId
          ).then((decrypted) => {
            if (decrypted) setContent(decrypted);
          }).catch(() => {
            // Si falla el descifrado, mostrar lo que hay
          });

          // Cargar usuarios permitidos
          const allowedIds = editPost.allowed_users || [];
          if (allowedIds.length > 0) {
            // Filtrar el autor
            const others = allowedIds.filter(id => id !== userId);
            if (others.length > 0) {
              dbPublic
                .from('profiles')
                .select('id, username, avatar_url')
                .in('id', others)
                .then(({ data }) => {
                  if (data) setAllowedUsers(data);
                });
            }
          }
        }
      } else {
        setContent('');
        setPreviewUrl(null);
        setPreviewType(null);
        setImageUrls(['']);
        setShowImageSection(false);
        setIsEncrypted(false);
        setAllowedUsers([]);
        setUserSearchQuery('');
        setUserSearchResults([]);
        setShowUserSearch(false);
      setShowPoll(false);
      setPollQuestion('');
      setPollOptions(['', '']);
      setPollExpiresAt('');
      setShowSchedule(false);
      setScheduledAt('');
      setShowGifPicker(false);
      setSong(null);
      setShowSongPicker(false);
      setVideoUrl('');
      setIsSensitive(false);
      setCommentsAllowed('everyone');
    }
    setError(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editPost]);

  // ── Mostrar preview ofuscado (cuando está activo y hay contenido) ──
  const showObfuscatedPreview = isEncrypted && !isEditing && content.trim().length > 0;

  // ── Poll option handlers ──
  const handlePollOptionChange = (index, value) => {
    setPollOptions(prev => {
      const updated = [...prev];
      updated[index] = value;
      return updated;
    });
  };

  const addPollOption = () => {
    if (pollOptions.length >= 10) return;
    setPollOptions(prev => [...prev, '']);
  };

  const removePollOption = (index) => {
    if (pollOptions.length <= 2) return;
    setPollOptions(prev => prev.filter((_, i) => i !== index));
  };

  // Scroll locking, Escape: manejado por ModalShell (<dialog> nativo)

  // ── Combined content change handler (mention + preview) ──
  const handleContentChange = (e) => {
    const text = e.target.value;
    mentionHandleChange(e);
    updatePreview(text);
  };

  // ── Markdown: envuelve la selección con la sintaxis (o deja el cursor
  //    dentro para empezar a escribir, sin insertar texto de relleno) ──
  const applyMarkdown = useCallback((opts) => {
    const el = textareaRef.current;
    const value = content;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const { next, selectionStart, selectionEnd } = applyMarkdownEdit({ value, start, end, ...opts });

    setContent(next);

    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(selectionStart, selectionEnd);
    });
  }, [content, textareaRef]);

  // ── Image URL management ──
  const handleImageUrlChange = (index, value) => {
    setImageUrls((prev) => {
      const updated = [...prev];
      updated[index] = value;
      return updated;
    });
  };

  const addImageUrlInput = () => {
    if (imageUrls.length >= 4) return;
    setImageUrls((prev) => [...prev, '']);
  };

  const removeImageUrlInput = (index) => {
    setImageUrls((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Upload a post image file to CDN (optimistic: local preview, then background upload) ──
  const uploadPostImage = useCallback(async (file, index) => {
    if (!file || !userId) return;

    if (!file.type.startsWith('image/')) {
      toast.error(t('modal.invalid_image_type') || 'Invalid image type', { containerId: 'modal' });
      return;
    }

    setUploadingPostIndex(index);
    const toastId = toast.loading(t('upload.uploading') || 'Subiendo imagen...', { containerId: 'modal' });

    try {
      // Mostrar preview local instantáneo mientras se sube en background
      const { localUrl, realUrlPromise, realResultPromise } = uploadWithLocalPreview(file, userId, 'post');
      setImageUrls((prev) => {
        const updated = [...prev];
        updated[index] = localUrl;
        return updated;
      });
      setShowImageSection(true);

      // Esperar subida real en background y reemplazar URL
      const realUrl = await realUrlPromise;
      setImageUrls((prev) => {
        const updated = [...prev];
        updated[index] = realUrl;
        return updated;
      });

      // Guardar dimensiones reales para image_meta (no bloquea el submit)
      realResultPromise.then((result) => {
        if (result?.width > 0 && result?.height > 0) {
          imageMetaRef.current.set(result.url, { u: result.url, w: result.width, h: result.height });
        }
      }).catch(() => {});

      toast.update(toastId, {
        render: t('upload.uploaded') || 'Imagen subida',
        type: 'success',
        isLoading: false,
        autoClose: 2000,
        containerId: 'modal',
      });
    } catch (err) {
      console.error('CDN upload error:', err);
      toast.update(toastId, {
        render: err.message || 'Upload failed',
        type: 'error',
        isLoading: false,
        autoClose: 3000,
        containerId: 'modal',
      });
    } finally {
      setUploadingPostIndex(-1); // solo habilitar submit cuando ya tenemos la URL real
    }
  }, [userId, t]);

  // ── Input file de las imágenes del post ──
  const handlePostImageUpload = async (e, index) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadPostImage(file, index);
    e.target.value = '';
  };

  // ── Pegar imagen (Ctrl+V) en el editor → sube directo y agrega al media ──
  const handlePostPaste = useCallback(async (e) => {
    if (!userId) return;

    // Imagen del portapapeles (si es texto normal, dejar el paste por defecto)
    const file = getClipboardImageFile(e.clipboardData);
    if (!file) return;

    e.preventDefault();
    if (uploadingPostIndex !== -1) return; // evita uploads concurrentes (mismo guard que el input file)

    // Reusar el primer slot vacío; si no hay, agregar uno nuevo (máx 4 imágenes)
    const emptyIdx = imageUrls.findIndex((u) => !u.trim());
    if (emptyIdx === -1 && imageUrls.length >= 4) {
      setMediaLimitWarning(t('create_post.media_limit_warning'));
      return;
    }
    const targetIndex = emptyIdx !== -1 ? emptyIdx : imageUrls.length;
    if (targetIndex === imageUrls.length) {
      setImageUrls((prev) => [...prev, '']);
    }
    setMediaLimitWarning(null);
    setShowImageSection(true);
    await uploadPostImage(file, targetIndex);
  }, [userId, imageUrls, uploadingPostIndex, t, uploadPostImage]);

  const handleSubmit = async () => {
    const trimmed = content.trim();
    // Un video o una imagen bastan: no hace falta texto.
    if (!trimmed && getValidImageUrls().length === 0 && !showPoll && !song && !validVideoUrl) {
      setError(t('create_post.empty_error'));
      return;
    }

    // El video solo se acepta por URL: si escribió algo, tiene que ser un
    // enlace http(s) de video reconocible (mp4/webm/ogg, YouTube o Vimeo).
    if (videoUrl.trim() && !validVideoUrl) {
      setError(t('create_post.invalid_video_url'));
      return;
    }

    // Validar ofuscación: si está activa, debe haber al menos un usuario seleccionado
    if (isEncrypted && allowedUsers.length === 0) {
      setError(t('create_post.encrypted_no_users') || 'Selecciona al menos un usuario para ver el contenido ofuscado');
      return;
    }

    const { imageUrl, videoUrl: detectedVideoUrl } = detectMediaFromContent(trimmed);
    // El video pegado en el campo dedicado gana sobre el detectado en el texto.
    const finalVideoUrl = validVideoUrl || detectedVideoUrl || null;
    const validImageUrls = getValidImageUrls();

    // Merge auto-detected image with manual URLs (auto-detected takes priority if manual is empty)
    const finalImageUrls = validImageUrls.length > 0
      ? validImageUrls
      : (imageUrl ? [imageUrl] : []);

    // Dimensiones reales alineadas con las URLs finales (para image_meta)
    const finalImageMeta = finalImageUrls
      .map((u) => imageMetaRef.current.get(u))
      .filter(Boolean);

    // ── Validate poll ──
    let finalPollData = null;
    if (showPoll) {
      const question = pollQuestion.trim();
      if (!question) {
        setError(t('create_post.poll_question_required') || 'La pregunta de la encuesta es obligatoria');
        return;
      }
      const validOptions = pollOptions
        .map(o => o.trim())
        .filter(o => o.length > 0);
      if (validOptions.length < 2) {
        setError(t('create_post.poll_min_options') || 'La encuesta necesita al menos 2 opciones');
        return;
      }
      finalPollData = {
        question,
        options: validOptions.map((text, i) => ({ id: `opt_${i + 1}`, text })),
        expires_at: pollExpiresAt || null,
      };
    }

    // ── Validate scheduled date ──
    let finalScheduledAt = null;
    if (showSchedule && scheduledAt) {
      const schedDate = new Date(scheduledAt);
      if (isNaN(schedDate.getTime())) {
        setError(t('create_post.invalid_schedule_date') || 'Fecha de programación inválida');
        return;
      }
      if (schedDate <= new Date()) {
        setError(t('create_post.schedule_past') || 'La fecha de programación debe ser futura');
        return;
      }
      // Convertir hora local a UTC (ISO string con Z) para que Supabase
      // almacene correctamente independientemente de la zona horaria del servidor
      finalScheduledAt = new Date(scheduledAt).toISOString();
    }

    // No permitir encuesta y ofuscación juntas
    if (showPoll && isEncrypted) {
      setError(t('create_post.poll_encrypted_conflict') || 'No puedes tener una encuesta en un post ofuscado');
      return;
    }

    // ── @Mentions: verificar que los usuarios mencionados permitan menciones ──
    const mentionedUsernames = extractMentions(trimmed);
    if (mentionedUsernames.length > 0) {
      const mentionedUsers = await getMentionUserIds(mentionedUsernames);
      const others = mentionedUsers.filter(u => u.id !== userId);
      if (others.length > 0) {
        const { data: mentionPrefs } = await dbPublic
          .from('profiles')
          .select('id, username, allow_mention')
          .in('id', others.map(u => u.id));
        const disabledMention = (mentionPrefs || []).filter(p => p.allow_mention === false);
        if (disabledMention.length > 0) {
          const names = disabledMention.map(p => `@${p.username}`).join(', ');
          setError(t('create_post.mention_disabled', { users: names }) || `No puedes mencionar a ${names} porque tienen las menciones desactivadas`);
          return;
        }
      }
    }

    setSaving(true);
    setError(null);

    try {
      let newPost;
      let encryptedResult = null;
      let obfuscatedDisplay = null;
      // Las canciones de YouTube no traen preview: se pide uno a iTunes como
      // respaldo antes de guardar (best-effort), igual que en el perfil.
      const finalSong = song ? await withPreviewFallback(song) : null;
      // Ratio del video para reservar el hueco en el feed: se mide aquí (si
      // falla, el post se guarda igual sin video_meta y el reproductor mide al
      // cargar). Al editar se conserva el guardado si la URL no cambió.
      let finalVideoMeta = finalVideoUrl ? await loadVideoMeta(finalVideoUrl) : null;
      if (!finalVideoMeta && finalVideoUrl && editPost?.video_url === finalVideoUrl) {
        finalVideoMeta = editPost.video_meta || null;
      }

      // Si es modo ofuscado, encriptar el contenido
      if (isEncrypted && !isEditing) {
        obfuscatedDisplay = encryptEncode(trimmed);
      }

      if (isEditing) {
        const updateData = {
          content: trimmed,
          image_url: finalImageUrls[0] || imageUrl,
          image_urls: finalImageUrls.length > 0 ? finalImageUrls : null,
          image_meta: finalImageMeta.length > 0 ? finalImageMeta : null,
          video_url: finalVideoUrl,
          video_meta: finalVideoUrl ? finalVideoMeta : null,
          comments_allowed: commentsAllowed,
          is_sensitive: isSensitive,
          song: finalSong,
        };

        // Incluir poll_data si hay encuesta
        if (finalPollData) {
          updateData.poll_data = finalPollData;
        }
        // Incluir scheduled_at si está programado
        if (finalScheduledAt) {
          updateData.scheduled_at = finalScheduledAt;
        } else if (showSchedule && !scheduledAt) {
          // Si desactivó la programación, quitar scheduled_at
          updateData.scheduled_at = null;
        }

        // Re-encriptar si el post estaba ofuscado
        if (isEncrypted) {
          const userIds = allowedUsers.map(u => u.id);
          if (!userIds.includes(userId)) {
            userIds.push(userId);
          }
          const encResult = await encryptForUsers(trimmed, userId, userIds);
          const encDisplay = encryptEncode(trimmed);
          const fullAllowedIds = [...new Set([...allowedUsers.map(u => u.id), userId])];
          updateData.content = encDisplay;
          updateData.is_encrypted = true;
          updateData.encrypted_content = encResult.ciphertext;
          updateData.encrypted_iv = encResult.iv;
          updateData.allowed_users = fullAllowedIds;
          updateData.obfuscated_display = encDisplay;
          encryptedResult = encResult;
          obfuscatedDisplay = encDisplay;
        }

        await updatePost(editPost.id, updateData);

        // ── Encrypted add (edición): notificar SOLO a los usuarios recién
        //    agregados a la lista de permitidos (los que ya estaban ya saben).
        //    Crítico porque los posts encriptados son invisibles en feeds: la
        //    notificación es el único canal de descubrimiento.
        if (isEncrypted && editPost.id) {
          const prevAllowedIds = editPost.allowed_users || [];
          const newAddedIds = allowedUsers
            .map((u) => u.id)
            .filter((id) => !prevAllowedIds.includes(id));
          if (newAddedIds.length > 0) {
            notifyEncryptedAdd(userId, editPost.id, newAddedIds).catch((err) =>
              console.warn('Error notifying encrypted add on edit:', err)
            );
          }
        }
      } else {
        if (!userId) {
          setError(t('create_post.auth_error'));
          setSaving(false);
          return;
        }

        // Si es modo ofuscado, encriptar con AES (clave derivada del autor + usuarios, sin postId)
        if (isEncrypted) {
          const userIds = allowedUsers.map(u => u.id);
          // Incluir al autor también para que pueda verlo
          if (!userIds.includes(userId)) {
            userIds.push(userId);
          }
          encryptedResult = await encryptForUsers(trimmed, userId, userIds);
        }

        // Incluir al autor en allowed_users (necesario para que coincida con la clave de encriptación)
        const fullAllowedIds = isEncrypted
          ? [...new Set([...allowedUsers.map(u => u.id), userId])]
          : null;

        newPost = await createPost({
          userId,
          content: isEncrypted ? obfuscatedDisplay : trimmed,
          imageUrl: finalImageUrls[0] || imageUrl,
          imageUrls: finalImageUrls.length > 0 ? finalImageUrls : null,
          imageMeta: finalImageMeta.length > 0 ? finalImageMeta : null,
          videoUrl: finalVideoUrl,
          videoMeta: finalVideoUrl ? finalVideoMeta : null,
          song: finalSong,
          encryptedContent: encryptedResult?.ciphertext || null,
          encryptedIv: encryptedResult?.iv || null,
          allowedUsers: fullAllowedIds,
          obfuscatedDisplay: isEncrypted ? obfuscatedDisplay : null,
          pollData: finalPollData,
          scheduledAt: finalScheduledAt,
          commentsAllowed,
          isSensitive,
        });

        // ── @Mentions: notificar a usuarios mencionados ──
        if (trimmed && newPost?.id) {
          notifyMentions(userId, newPost.id, trimmed).catch((err) =>
            console.warn('Error notifying mentions:', err)
          );
        }

        // ── Encrypted add: notificar a usuarios agregados ──
        if (isEncrypted && newPost?.id && allowedUsers.length > 0) {
          notifyEncryptedAdd(
            userId,
            newPost.id,
            allowedUsers.map((u) => u.id)
          ).catch((err) =>
            console.warn('Error notifying encrypted add:', err)
          );
        }
      }

      // ── Toast de confirmación de publicación ──
      if (isEditing) {
        toast.success(t('create_post.updated') || 'Post updated');
      } else if (finalScheduledAt) {
        toast.success(t('create_post.scheduled') || 'Post scheduled');
      } else {
        toast.success(t('create_post.posted') || 'Post published!');
      }

      setContent('');
      setPreviewUrl(null);
      setPreviewType(null);
      setImageUrls(['']);
      setSong(null);
      setShowSongPicker(false);
      setVideoUrl('');
      setShowImageSection(false);
      setIsEncrypted(false);
      setAllowedUsers([]);
      setUserSearchQuery('');
      setUserSearchResults([]);
      setShowUserSearch(false);
      setShowPoll(false);
      setPollQuestion('');
      setPollOptions(['', '']);
      setPollExpiresAt('');
      setShowSchedule(false);
      setScheduledAt('');
      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      const limitInfo = getRateLimitInfo(err);
      setError(
        limitInfo
          ? (limitInfo.retryAfter
            ? t('common.rate_limited_wait', { seconds: limitInfo.retryAfter })
            : t('common.rate_limited'))
          : (err.message || t('create_post.save_error'))
      );
    } finally {
      setSaving(false);
    }
  };

  const isVideoPreview = previewType === 'video' && (VID_RE.test(previewUrl) || YOUTUBE_PATTERN.test(previewUrl) || VIMEO_PATTERN.test(previewUrl));

  const getEmbedUrl = getEmbedUrlHelper;

  // ── Whether there's an image to censor ──
  const hasImage = useMemo(() => {
    return getValidImageUrls().length > 0 || (previewUrl !== null && previewType === 'image');
  }, [imageUrls, previewUrl, previewType]);

  // ── Strip detected media URLs from preview text ──
  const cleanPreviewText = useMemo(() => {
    const text = content.trim();
    if (!text || !previewUrl) return text;
    // Remove the auto-detected image/video URL from the displayed text
    // (same behavior as PostCard's RichText with skipUrls)
    return text.replace(previewUrl, '').trim();
  }, [content, previewUrl]);

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} onEscape={() => confirmCloseRef.current()} className="create-post-modal">
        <div className="fc-modal-header">
          <h3 className="fc-modal-title">{isEditing ? t('create_post.edit_title') : t('create_post.title')}</h3>
          <div className="fc-modal-header-actions">
            <button
              className="fc-modal-save"
              onClick={handleSubmit}
              disabled={saving || (!content.trim() && getValidImageUrls().length === 0 && !showPoll && !song && !validVideoUrl)}
            >
              {isEncrypted && <FaLock className="fc-modal-save-lock" />}
              {saving ? t('create_post.saving') : isEditing ? t('create_post.save_changes') : t('create_post.post')}
            </button>
            <button
              type="button"
              className="fc-modal-close"
              onClick={confirmClose}
              aria-label={t('common.close')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {error && <p className="create-post-error">{error}</p>}

        {/* ── Two-column layout: editor left, previews right ── */}
        <div className="create-post-body">
          <div className="create-post-body-left">
            {/* ── Content textarea (sin label, sin avatar/usuario) ── */}
            <div className="create-post-textarea-wrapper">
              <textarea
                ref={textareaRef}
                className="fc-modal-input create-post-textarea"
                value={content}
                onChange={handleContentChange}
                onKeyDown={handleTextareaKeyDown}
                onPaste={handlePostPaste}
                rows={5}
                placeholder={t('create_post.placeholder')}
                maxLength={2000}
                title={t('create_post.paste_image_hint') || 'Paste an image with Ctrl+V'}
              />
              <span className="create-post-charcount">{content.length}/2000</span>
              {/* ── @mention autocomplete dropdown (portaled) ── */}
              {mentionDropdown}
            </div>

            {/* ── Toolbar: icons + tooltips ── */}
            <div className="create-post-toolbar">
              <Tooltip text={showImageSection ? t('create_post.hide_media') : t('create_post.show_media')} placement="bottom">
              <button
                type="button"
                className={`create-post-toolbar-btn ${showImageSection ? 'create-post-toolbar-btn--active' : ''}`}
                onClick={() => setShowImageSection((s) => !s)}
              >
                <FaImage />
                {getValidImageUrls().length > 0 && (
                  <span className="create-post-toolbar-badge">{getValidImageUrls().length}</span>
                )}
              </button>
              </Tooltip>

              <Tooltip
                text={
                  filterEncrypted
                    ? t('create_post.encrypted_disabled_by_filter')
                    : isEditing
                      ? t('create_post.encrypted_edit_locked')
                      : isEncrypted
                        ? t('create_post.encrypted_on')
                        : t('create_post.encrypted_off')
                }
                placement="bottom"
              >
              <button
                type="button"
                className={`create-post-toolbar-btn ${isEncrypted ? 'create-post-toolbar-btn--encrypted' : ''}`}
                disabled={filterEncrypted}
                onClick={() => {
                  if (isEditing) return; // No permitir cambiar en edición
                  if (!isEncrypted) {
                    // Activar encriptación → eliminar poll y schedule
                    if (showPoll) {
                      setShowPoll(false);
                      setPollQuestion('');
                      setPollOptions(['', '']);
                      setPollExpiresAt('');
                    }
                    if (showSchedule) {
                      setShowSchedule(false);
                      setScheduledAt('');
                    }
                  } else {
                    // Desactivar encriptación → limpiar usuarios permitidos
                    setAllowedUsers([]);
                    setShowUserSearch(false);
                  }
                  setIsEncrypted(s => !s);
                }}
              >
                {isEncrypted ? <FaLock /> : <FaUnlock />}
              </button>
              </Tooltip>

              <Tooltip text={showPoll ? t('create_post.remove_poll') : t('create_post.add_poll')} placement="bottom">
              <button
                type="button"
                className={`create-post-toolbar-btn ${showPoll ? 'create-post-toolbar-btn--active' : ''}`}
                onClick={() => setShowPoll(s => !s)}
                disabled={isEncrypted}
              >
                <FaPoll />
              </button>
              </Tooltip>

              <Tooltip text={showSchedule ? t('create_post.remove_schedule') : t('create_post.add_schedule')} placement="bottom">
              <button
                type="button"
                className={`create-post-toolbar-btn ${showSchedule ? 'create-post-toolbar-btn--active' : ''}`}
                onClick={() => setShowSchedule(s => !s)}
                disabled={isEncrypted}
              >
                <FaClock />
              </button>
              </Tooltip>

              {/* ── Comment permissions toggle ── */}
              <Tooltip
                text={
                  commentsAllowed === 'everyone'
                    ? t('create_post.comments_everyone')
                    : commentsAllowed === 'followers'
                      ? t('create_post.comments_followers')
                      : t('create_post.comments_nobody')
                }
                placement="bottom"
              >
              <button
                type="button"
                className={`create-post-toolbar-btn ${commentsAllowed !== 'everyone' ? 'create-post-toolbar-btn--active' : ''}`}
                onClick={() => {
                  const options = ['everyone', 'followers', 'nobody'];
                  const idx = options.indexOf(commentsAllowed);
                  setCommentsAllowed(options[(idx + 1) % options.length]);
                }}
              >
                {commentsAllowed === 'everyone' ? <FaGlobe /> : commentsAllowed === 'followers' ? <FaUserFriends /> : <FaBan />}
              </button>
              </Tooltip>

              {/* ── GIF picker toggle ── */}
              <Tooltip text={t('create_post.add_gif') || 'GIF'} placement="bottom">
              <button
                type="button"
                className={`create-post-toolbar-btn ${showGifPicker ? 'create-post-toolbar-btn--active' : ''}`}
                onClick={() => setShowGifPicker(s => !s)}
              >
                <span className="create-post-toolbar-btn-gif">GIF</span>
              </button>
              </Tooltip>

              {/* ── Song picker toggle ── */}
              <Tooltip text={song ? t('create_post.remove_song') : t('create_post.add_song')} placement="bottom">
              <button
                type="button"
                className={`create-post-toolbar-btn ${showSongPicker || song ? 'create-post-toolbar-btn--active' : ''}`}
                onClick={() => setShowSongPicker(s => !s)}
              >
                <FaMusic />
              </button>
              </Tooltip>

              {/* ── Sensitive content toggle (disabled if no image) ── */}
              <Tooltip
                text={
                  hasImage
                    ? (isSensitive ? t('create_post.sensitive_on') : t('create_post.sensitive_off'))
                    : t('create_post.sensitive_no_image')
                }
                placement="bottom"
              >
              <button
                type="button"
                className={`create-post-toolbar-btn ${isSensitive ? 'create-post-toolbar-btn--active' : ''}`}
                onClick={() => setIsSensitive(s => !s)}
                disabled={!hasImage}
              >
                <FaExclamationTriangle />
              </button>
              </Tooltip>
            </div>

            {/* ── Canción adjunta (chip con quit) ── */}
            {song && (
              <div className="create-post-song">
                <SongArtwork
                  song={song}
                  className="create-post-song-art"
                  emptyClassName="create-post-song-art--empty"
                  loading="lazy"
                />
                <span className="create-post-song-info">
                  <span className="create-post-song-title">{song.title}</span>
                  {song.artist && <span className="create-post-song-artist">{song.artist}</span>}
                </span>
                <button
                  type="button"
                  className="create-post-song-remove"
                  onClick={() => setSong(null)}
                  aria-label={t('create_post.remove_song')}
                  title={t('create_post.remove_song')}
                >
                  <FaTimes />
                </button>
              </div>
            )}

            {/* ── Formato markdown (fila propia debajo de las opciones del post) ── */}
            <div className="create-post-markdown-toolbar">
              <span className="create-post-markdown-label">{t('create_post.md_format') || 'Formato'}</span>

              <Tooltip text={t('create_post.md_bold')} placement="bottom">
              <button
                type="button"
                className="create-post-toolbar-btn"
                aria-label={t('create_post.md_bold')}
                onClick={() => applyMarkdown({ prefix: '**', suffix: '**' })}
              >
                <FaBold />
              </button>
              </Tooltip>

              <Tooltip text={t('create_post.md_italic')} placement="bottom">
              <button
                type="button"
                className="create-post-toolbar-btn"
                aria-label={t('create_post.md_italic')}
                onClick={() => applyMarkdown({ prefix: '*', suffix: '*' })}
              >
                <FaItalic />
              </button>
              </Tooltip>

              <Tooltip text={t('create_post.md_strike')} placement="bottom">
              <button
                type="button"
                className="create-post-toolbar-btn"
                aria-label={t('create_post.md_strike')}
                onClick={() => applyMarkdown({ prefix: '~~', suffix: '~~' })}
              >
                <FaStrikethrough />
              </button>
              </Tooltip>

              <Tooltip text={t('create_post.md_code')} placement="bottom">
              <button
                type="button"
                className="create-post-toolbar-btn"
                aria-label={t('create_post.md_code')}
                onClick={() => applyMarkdown({ prefix: '`', suffix: '`' })}
              >
                <FaCode />
              </button>
              </Tooltip>

              <Tooltip text={t('create_post.md_list')} placement="bottom">
              <button
                type="button"
                className="create-post-toolbar-btn"
                aria-label={t('create_post.md_list')}
                onClick={() => applyMarkdown({ prefix: '- ', block: true })}
              >
                <FaListUl />
              </button>
              </Tooltip>

              <Tooltip text={t('create_post.md_quote')} placement="bottom">
              <button
                type="button"
                className="create-post-toolbar-btn"
                aria-label={t('create_post.md_quote')}
                onClick={() => applyMarkdown({ prefix: '> ', block: true })}
              >
                <FaQuoteRight />
              </button>
              </Tooltip>
            </div>

            {/* ── Song picker panel ── */}
            {showSongPicker && (
              <SongPicker
                onSelect={(picked) => {
                  setSong(picked);
                  setShowSongPicker(false);
                }}
                onClose={() => setShowSongPicker(false)}
              />
            )}

            {/* ── GIF picker panel ── */}
            {showGifPicker && (
              <GifPicker
                onSelect={(gifUrl) => {
                  // Add GIF URL to image URLs
                  setImageUrls(prev => {
                    const urls = prev.filter(u => u.trim() !== '');
                    if (urls.length < 4) {
                      return [...urls, gifUrl];
                    }
                    return prev;
                  });
                  // Ensure image section is visible
                  setShowImageSection(true);
                  setShowGifPicker(false);
                }}
                onClose={() => setShowGifPicker(false)}
              />
            )}

            {/* ── Poll creation section ── */}
            {showPoll && (
              <div className="create-post-poll-section">
                <div className="create-post-poll-section-header">
                  <FaPoll className="create-post-poll-section-icon" />
                  <span className="create-post-poll-section-label">{t('create_post.poll_title') || 'Encuesta'}</span>
                </div>
                <input
                  className="fc-modal-input create-post-poll-input"
                  type="text"
                  value={pollQuestion}
                  onChange={(e) => setPollQuestion(e.target.value)}
                  placeholder={t('create_post.poll_question_placeholder') || 'Escribe una pregunta...'}
                  maxLength={280}
                />
                <div className="create-post-poll-options">
                  {pollOptions.map((option, index) => (
                    <div key={index} className="create-post-poll-option-row">
                      <span className="create-post-poll-option-num">{index + 1}</span>
                      <input
                        className="fc-modal-input create-post-poll-option-input"
                        type="text"
                        value={option}
                        onChange={(e) => handlePollOptionChange(index, e.target.value)}
                        placeholder={t('create_post.poll_option_placeholder', { n: index + 1 }) || `Opción ${index + 1}`}
                        maxLength={120}
                      />
                      {pollOptions.length > 2 && (
                        <Tooltip text={t('common.delete')} placement="bottom">
                        <button
                          type="button"
                          className="create-post-poll-option-remove"
                          onClick={() => removePollOption(index)}
                        >
                          <FaTimes />
                        </button>
                        </Tooltip>
                      )}
                    </div>
                  ))}
                </div>
                {pollOptions.length < 10 && (
                  <button
                    type="button"
                    className="create-post-poll-add-option"
                    onClick={addPollOption}
                  >
                    <FaPlus /> {t('create_post.poll_add_option')}
                  </button>
                )}
                <div className="create-post-poll-expiry">
                  <FaCalendarAlt className="create-post-poll-expiry-icon" />
                  <span className="create-post-poll-expiry-label">{t('create_post.poll_expires_label') || 'Fecha límite (opcional):'}</span>
                  <input
                    className="fc-modal-input create-post-poll-expiry-input"
                    type="datetime-local"
                    value={pollExpiresAt}
                    onChange={(e) => setPollExpiresAt(e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                  />
                </div>
              </div>
            )}

            {/* ── Scheduling section ── */}
            {showSchedule && (
              <div className="create-post-schedule-section">
                <div className="create-post-schedule-section-header">
                  <FaClock className="create-post-schedule-section-icon" />
                  <span className="create-post-schedule-section-label">{t('create_post.schedule_title')}</span>
                </div>
                <div className="create-post-schedule-input-row">
                  <input
                    className="fc-modal-input create-post-schedule-input"
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                  />
                </div>
                <p className="create-post-schedule-hint">
                  {t('create_post.schedule_hint') || 'El post se publicará automáticamente en la fecha seleccionada.'}
                </p>
              </div>
            )}

            {/* ── Allowed users selector (solo si ofuscación activa) ── */}
            {isEncrypted && (
              <div className="create-post-encrypt-section">
                <div className="create-post-encrypt-section-header">
                  <FaUserPlus className="create-post-encrypt-section-icon" />
                  <span className="create-post-encrypt-section-label">{t('create_post.allowed_users_title') || 'Visible para:'}</span>
                  <Tooltip text={t('create_post.add_user')} placement="bottom">
                  <button
                    type="button"
                    className="create-post-encrypt-add-btn"
                    onClick={() => setShowUserSearch((s) => !s)}
                  >
                    {showUserSearch ? <FaMinus /> : <FaPlus />}
                  </button>
                  </Tooltip>
                </div>

                {/* Selected users as chips */}
                {allowedUsers.length > 0 && (
                  <div className="create-post-encrypt-chips">
                    {allowedUsers.map(u => (
                      <span key={u.id} className="create-post-encrypt-chip">
                        <Avatar className="create-post-encrypt-chip-avatar" src={u.avatar_url} alt={u.username} />
                        <span className="create-post-encrypt-chip-name">@{u.username}</span>
                        <Tooltip text={t('common.delete')} placement="bottom">
                        <button
                          type="button"
                          className="create-post-encrypt-chip-remove"
                          onClick={() => removeAllowedUser(u.id)}
                        >
                          <FaTimes />
                        </button>
                        </Tooltip>
                      </span>
                    ))}
                  </div>
                )}

                {/* User search */}
                {showUserSearch && (
                  <div className="create-post-encrypt-search">
                    <div className="create-post-encrypt-search-input-wrap">
                      <FaSearch className="create-post-encrypt-search-icon" />
                      <input
                        className="fc-modal-input create-post-encrypt-search-input"
                        type="text"
                        value={userSearchQuery}
                        onChange={handleUserSearchChange}
                        placeholder={t('create_post.search_users_placeholder') || 'Buscar usuarios...'}
                        autoFocus
                      />
                    </div>

                    {/* Search results */}
                    {searchingUsers && <div className="create-post-encrypt-searching">{t('common.loading') || 'Buscando...'}</div>}
                    {userSearchResults.length > 0 && (
                      <div className="create-post-encrypt-results">
                        {userSearchResults.map(u => (
                          <button
                            key={u.id}
                            type="button"
                            className="create-post-encrypt-result-item"
                            onClick={() => addAllowedUser(u)}
                          >
                            <Avatar className="create-post-encrypt-result-avatar" src={u.avatar_url} alt={u.username} />
                            <span className="create-post-encrypt-result-name">@{u.username}</span>
                            <FaCheck className="create-post-encrypt-result-add" />
                          </button>
                        ))}
                      </div>
                    )}
                    {userSearchQuery.length >= 2 && userSearchResults.length === 0 && !searchingUsers && (
                      <div className="create-post-encrypt-no-results">{t('create_post.no_users_found')}</div>
                    )}

                    {/* Quick add: followed users */}
                    {followedUsers.length > 0 && (
                      <div className="create-post-encrypt-quick">
                        <span className="create-post-encrypt-quick-label">{t('create_post.quick_add') || 'Siguiendo:'}</span>
                        <div className="create-post-encrypt-quick-list">
                          {followedUsers
                            .filter(u => !allowedUsers.some(a => a.id === u.id))
                            .slice(0, 6)
                            .map(u => (
                              <button
                                key={u.id}
                                type="button"
                                className="create-post-encrypt-quick-item"
                                onClick={() => addAllowedUser(u)}
                              >
                                <Avatar className="create-post-encrypt-quick-avatar" src={u.avatar_url} alt={u.username} />
                                <span className="create-post-encrypt-quick-name">@{u.username}</span>
                              </button>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Image URL inputs section ── */}
            {showImageSection && (
              <div className="create-post-image-section">
                <div className="create-post-image-section-header">
                  <FaLink className="create-post-image-section-icon" />
                  <span className="create-post-image-section-label">{t('create_post.image_urls_title')}</span>
                </div>
                {imageUrls.map((url, index) => (
                  <div key={url} className="create-post-image-input-row">
                    <label className="create-post-image-upload-btn">
                      {uploadingPostIndex === index ? <FaSpinner className="fc-spin" /> : <FaUpload />}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp"
                        onChange={(e) => handlePostImageUpload(e, index)}
                        disabled={uploadingPostIndex === index}
                        style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                      />
                    </label>
                    <input
                      className="fc-modal-input create-post-image-input"
                      type="url"
                      value={url}
                      onChange={(e) => handleImageUrlChange(index, e.target.value)}
                      placeholder={`https://.../imagen-${index + 1}.jpg`}
                    />
                    {imageUrls.length > 1 && (
                      <Tooltip text={t('common.delete')} placement="bottom">
                      <button
                        type="button"
                        className="create-post-image-remove"
                        onClick={() => removeImageUrlInput(index)}
                      >
                        <FaTimes />
                      </button>
                      </Tooltip>
                    )}
                    {/* Mini preview */}
                    {url && IMAGE_EXTENSIONS.test(url) && (
                      <div className="create-post-image-mini">
                        <SafeImage
                          src={url}
                          alt={`Preview ${index + 1}`}
                          hideOnError
                        />
                      </div>
                    )}
                  </div>
                ))}
                {imageUrls.length < 4 && (
                  <Tooltip text={t('create_post.add_another_image', { n: imageUrls.length })} placement="bottom">
                  <button
                    type="button"
                    className="create-post-image-add"
                    onClick={addImageUrlInput}
                  >
                    <FaPlus />
                  </button>
                  </Tooltip>
                )}

                {/* ── Video solo por URL (el CDN aún no procesa video) ── */}
                <div className="create-post-video-url">
                  <div className="create-post-image-section-header">
                    <FaVideo className="create-post-image-section-icon" />
                    <span className="create-post-image-section-label">{t('create_post.video_url_title')}</span>
                  </div>
                  <div className="create-post-image-input-row">
                    <input
                      className="fc-modal-input create-post-image-input"
                      type="url"
                      value={videoUrl}
                      onChange={(e) => setVideoUrl(e.target.value)}
                      placeholder="https://.../video.mp4"
                    />
                    {videoUrl && (
                      <button
                        type="button"
                        className="create-post-image-remove"
                        onClick={() => setVideoUrl('')}
                        aria-label={t('common.delete')}
                        title={t('common.delete')}
                      >
                        <FaTimes />
                      </button>
                    )}
                  </div>
                  {videoUrl.trim() && !isAttachableVideoUrl(videoUrl) && (
                    <p className="create-post-video-hint">{t('create_post.invalid_video_url')}</p>
                  )}
                  {validVideoUrl && !getEmbedUrl(validVideoUrl) && (
                    <video src={validVideoUrl} className="create-post-video-preview" controls />
                  )}
                </div>
              </div>
            )}

            {/* ── Aviso de límite de media alcanzado ── */}
            {mediaLimitWarning && (
              <div className="create-post-preview create-post-preview--warning">
                <span>{mediaLimitWarning}</span>
              </div>
            )}
          </div>

          <div className="create-post-body-right">
            {/* ── Live Post Preview ── */}
            <div className="create-post-live-preview">
              <div className="create-post-live-preview-card">
                <Avatar
                  className="create-post-live-preview-avatar"
                  src={profile?.avatar_url}
                  alt={displayName}
                />
                <div className="create-post-live-preview-content">
                  <div className="create-post-live-preview-author">
                    <span className="create-post-live-preview-username">{displayName}</span>
                    <Badge roles={profile?.roles || []} />
                  </div>
                  <div className="create-post-live-preview-text">
                    {cleanPreviewText
                      ? <PostMarkdown text={cleanPreviewText} className="post-markdown create-post-live-preview-markdown" />
                      : <span className="create-post-live-preview-placeholder">{t('create_post.placeholder')}</span>}
                  </div>
                  {/* Preview images from image_urls */}
                  {showImageSection && getValidImageUrls().length > 0 && (
                    <div className={`post-card-image-grid post-card-image-grid--${Math.min(getValidImageUrls().length, 4)}`}>
                      {getValidImageUrls().slice(0, 4).map((url, i) => (
                        <div key={url} className="post-card-image-grid-item">
                          <SafeImage src={url} alt={`Preview ${i + 1}`} />
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Preview auto-detected media from content */}
                  {previewUrl && previewType === 'image' && getValidImageUrls().length === 0 && (
                    <div className="post-card-media">
                      <SafeImage src={previewUrl} alt="Preview" hideOnError />
                    </div>
                  )}
                  {previewUrl && isVideoPreview && (
                    <div className="post-card-media">
                      {getEmbedUrl(previewUrl) ? (
                        <iframe src={getEmbedUrl(previewUrl)} title="Video preview" allowFullScreen />
                      ) : (
                        <video src={previewUrl} controls />
                      )}
                    </div>
                  )}
                  {/* Video adjuntado en el campo de URL */}
                  {validVideoUrl && validVideoUrl !== previewUrl && (
                    <div className="post-card-media">
                      {getEmbedUrl(validVideoUrl) ? (
                        <iframe src={getEmbedUrl(validVideoUrl)} title="Video preview" allowFullScreen />
                      ) : (
                        <video src={validVideoUrl} controls />
                      )}
                    </div>
                  )}
                  {/* Visual action buttons (disabled) */}
                  <div className="create-post-live-preview-actions">
                    <span className="create-post-live-preview-action">
                      <FaRegHeart /> <span className="create-post-live-preview-count">0</span>
                    </span>
                    <span className="create-post-live-preview-action">
                      <FaHeartBroken /> <span className="create-post-live-preview-count">0</span>
                    </span>
                    <span className="create-post-live-preview-action">
                      <FaComment /> <span className="create-post-live-preview-count">0</span>
                    </span>
                    <span className="create-post-live-preview-action">
                      <FaRetweet /> <span className="create-post-live-preview-count">0</span>
                    </span>
                    <span className="create-post-live-preview-action">
                      <FaRegBookmark />
                    </span>
                    <span className="create-post-live-preview-action">
                      <FaEye /> <span className="create-post-live-preview-count">0</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Obfuscated preview: cómo lo ven los no autorizados ── */}
            {showObfuscatedPreview && (
              <div className="create-post-obfuscated-preview">
                <div className="create-post-live-preview-header">
                  <FaLock className="create-post-obfuscated-preview-icon" />
                  <span className="create-post-live-preview-label">
                    {t('create_post.obfuscated_preview_label') || 'Cómo lo ven los demás:'}
                  </span>
                </div>
                <div className="create-post-live-preview-card">
                  <Avatar
                    className="create-post-live-preview-avatar"
                    src={profile?.avatar_url}
                    alt={displayName}
                  />
                  <div className="create-post-live-preview-content">
                    <div className="create-post-live-preview-author">
                      <span className="create-post-live-preview-username">{displayName}</span>
                      <Badge roles={profile?.roles || []} />
                    </div>
                    <p className="create-post-live-preview-text">
                      <FaLock style={{ marginRight: 6, fontSize: '0.75rem', opacity: 0.6 }} />
                      {t('post.encrypted_hidden_placeholder')}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

      {/* ── Discard changes confirmation ── */}
      {pendingClose && (
        <ConfirmModal
          message={t('modal.discard_changes') || '¿Descartar cambios?'}
          onConfirm={executeClose}
          onCancel={() => setPendingClose(false)}
        />
      )}
    </ModalShell>
  );
}
