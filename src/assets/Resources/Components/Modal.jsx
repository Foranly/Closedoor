import React, { useEffect, useState, useCallback, useRef } from 'react';
import ModalShell from './ModalShell';
import './css/modal.css';
import '../Styles/explore.css';
import Badge from './Badge';
import ConfirmModal from './ConfirmModal';
import Avatar from './Avatar';
import { DEFAULT_AVATAR, getImageStyle, getBackgroundStyle, sanitizeUrl } from '../../services/helpers';
import { USERNAME_MIN, USERNAME_MAX, USERNAME_RE, DISPLAYNAME_MAX, PRONOUNS_MAX } from '../../services/userService';
import ImagePositionEditor from './ImagePositionEditor';
import { detectPlatform, getPlatformIcon, getPlatformName } from '../../services/socialPlatforms';
import { extractColors } from '../../services/colorExtractor';
import { useI18n } from '../../services/i18n/useI18n';
import { FaCamera, FaUpload, FaSpinner, FaEdit, FaCheck, FaTimes } from 'react-icons/fa';
import { toast } from 'react-toastify';

import { uploadImage, uploadWithLocalPreview } from '../../services/cdnService';
import { useAuth } from '../../../hooks/useAuth';

// Module-level color cache persists across modal mounts/unmounts
const colorCache = {};

// Lista curada de intereses generales sugeridos
const SUGGESTED_INTERESTS = [
  'Videojuegos', 'Películas', 'Música', 'Arte', 'Fotografía',
  'Deportes', 'Lectura', 'Escritura', 'Viajes', 'Cocina',
  'Tecnología', 'Ciencia', 'Naturaleza', 'Animales', 'Moda',
  'Diseño', 'Baile', 'Teatro', 'Yoga', 'Meditación',
  'Cine', 'Series', 'Anime', 'Manga', 'Cómics',
  'Programación', 'IA', 'Ciberseguridad', 'Blockchain', 'Data Science',
  'Fitness', 'Running', 'Fútbol', 'Baloncesto', 'Tenis',
  'Natación', 'Senderismo', 'Acampar', 'Pesca', 'Jardinería',
  'DIY', 'Manualidades', 'Coleccionismo', 'Astronomía', 'Historia',
  'Filosofía', 'Psicología', 'Economía', 'Política', 'Medio Ambiente',
  'Voluntariado', 'Idiomas', 'Mascotas', 'Autos', 'Motos',
  'Rock', 'Pop', 'Hip Hop', 'Jazz', 'Electrónica',
  'Reggaeton', 'K-Pop', 'Instrumentos', 'Piano', 'Guitarra',
  'Batería', 'Producción Musical', 'DJ', 'Podcast', 'Streaming',
  'YouTube', 'TikTok', 'Redes Sociales', 'Marketing', 'Emprendimiento',
  'Negocios', 'Inversiones', 'Bienes Raíces', 'Arquitectura', 'Decoración',
  'Ilustración', 'Pixel Art', '3D', 'Animación', 'Edición de Video',
  'Astrología', 'Desarrollo Personal', 'Minimalismo', 'Sostenibilidad', 'Criptomonedas'
];

export default function Modal({
  isOpen,
  onClose,
  onSave,
  initialUsername = '',
  initialDisplayname = '',
  initialBanner = '',
  initialAvatar = '',
  initialBio = '',
  initialSocialLinks = [],
  initialAccentColor = '',
  initialAccentColorSecondary = '',
  initialInterests = [],

  initialAccentSurface = '',
  initialAccentSurfaceGlass = false,
  initialProfileBg = '',
  initialAvatarPosition = '',
  initialBannerPosition = '',
  initialProfileBgPosition = '50% 50%',
  initialProfileBgBlur = 0,
  initialProfileBgDim = 50,
  initialBannerDim = 50,
  initialPronouns = '',
  initialFollowersCount = 0,
  userRoles = ['user'],
  initialBannerCredits = '',
  initialAvatarCredits = '',
  initialProfileTextColor = '',
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  // ── Estados inicializados con fallback '' para prevenir
  //    TypeError: Cannot read properties of undefined (reading 'trim')
  //    cuando normalizeCdnUrl devuelve '' o el prop no llega a tiempo.
  const [username, setUsername] = useState(initialUsername || '');
  const [displayname, setDisplayname] = useState(initialDisplayname || '');
  const [banner, setBanner] = useState(initialBanner || '');
  const [avatar, setAvatar] = useState(initialAvatar || '');
  const [bio, setBio] = useState(initialBio || '');
  const [pronouns, setPronouns] = useState(initialPronouns || '');
  const [bannerCredits, setBannerCredits] = useState(initialBannerCredits || '');
  const [avatarCredits, setAvatarCredits] = useState(initialAvatarCredits || '');
  const [saving, setSaving] = useState(false);
  const [bannerPosition, setBannerPosition] = useState(initialBannerPosition);
  const [avatarPosition, setAvatarPosition] = useState(initialAvatarPosition);
  const [socialLinks, setSocialLinks] = useState([]);
  const [newSocial, setNewSocial] = useState('');
  const [socialError, setSocialError] = useState('');
  const [detected, setDetected] = useState(null); // { platform, username, url } preview before adding
  const [detectedUsername, setDetectedUsername] = useState('');
  // ── Edición de un social link existente ──
  const [editingSocialIndex, setEditingSocialIndex] = useState(null);
  const [editSocialInput, setEditSocialInput] = useState('');

  // Auto-detect platform as user types
  useEffect(() => {
    const input = newSocial.trim();
    if (!input) {
      setDetected(null);
      setSocialError('');
      return;
    }
    const result = detectPlatform(input);
    if (result && result.platform.id !== 'custom' && result.platform.id !== 'website') {
      setDetected(result);
      setDetectedUsername(result.username);
      setSocialError('');
    } else {
      setDetected(null);
      setSocialError('');
    }
  }, [newSocial]);
  const [extractedColors, setExtractedColors] = useState(() => {
    // Restore from cache on mount (no flash)
    const cached = initialBanner ? colorCache[initialBanner.trim()] : null;
    return cached || [];
  });
  const [selectedAccent, setSelectedAccent] = useState(initialAccentColor);
  const [selectedAccentSecondary, setSelectedAccentSecondary] = useState(initialAccentColorSecondary);
  const [selectedAccentSurface, setSelectedAccentSurface] = useState(initialAccentSurface);
  const [useGlassSurface, setUseGlassSurface] = useState(initialAccentSurfaceGlass);
  const [profileBg, setProfileBg] = useState(initialProfileBg);
  const [profileBgPosition, setProfileBgPosition] = useState(initialProfileBgPosition || '50% 50%');
  const [profileBgBlur, setProfileBgBlur] = useState(initialProfileBgBlur);
  const [profileBgDim, setProfileBgDim] = useState(initialProfileBgDim);
  const [bannerDim, setBannerDim] = useState(initialBannerDim);
  const [selectedProfileTextColor, setSelectedProfileTextColor] = useState(initialProfileTextColor);
  const [interests, setInterests] = useState(initialInterests);
  const [interestInput, setInterestInput] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [extracting, setExtracting] = useState(false);

  // ── Ratio del viewport del cliente ──
  // El fondo del perfil se renderiza a pantalla completa (.profile-page::before,
  // position: fixed; inset: 0), así que su contenedor real tiene el ratio de la
  // pantalla del usuario. El editor de fondo usa este ratio (en vez de un 16:9
  // fijo) para que la posición ajustada coincida exactamente con lo que se ve
  // en el perfil, sea cual sea la resolución del cliente.
  const [clientViewportRatio, setClientViewportRatio] = useState(() => {
    const w = window.innerWidth || 16;
    const h = window.innerHeight || 9;
    return w / h;
  });
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = window.innerWidth || 16;
        const h = window.innerHeight || 9;
        setClientViewportRatio(w / h);
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);


  // Submodal state: null | { type: 'avatar' | 'banner', value: string }
  const [showUrlModal, setShowUrlModal] = useState(null);
  const [urlInput, setUrlInput] = useState('');
  const [uploadingToCdn, setUploadingToCdn] = useState(false);
  const [uploadingBgToCdn, setUploadingBgToCdn] = useState(false);
  const [showSuggested, setShowSuggested] = useState(false);
  const [socialLinksExpanded, setSocialLinksExpanded] = useState(false);
  const [showProfileBgSubmodal, setShowProfileBgSubmodal] = useState(null);
  const [profileBgUrlInput, setProfileBgUrlInput] = useState('');
  const [pendingClose, setPendingClose] = useState(false);
  // ── Drag & drop state ──
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer?.types?.includes('Files')) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    dragCounterRef.current = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result;
      if (typeof dataUrl === 'string') {
        // Determine which input is active and set it
        if (showUrlModal) {
          setUrlInput(dataUrl);
        } else if (showProfileBgSubmodal) {
          setProfileBgUrlInput(dataUrl);
        }
      }
    };
    reader.onerror = () => {
      // Silently fail
    };
    reader.readAsDataURL(file);
  };

  // Resetear todos los campos solo al ABRIR el modal (isOpen → true), no cuando cambian los initial* props
  // Esto evita que Supabase Realtime (que actualiza ownProfile al reconectar) borre las ediciones del usuario
  useEffect(() => {
    if (!isOpen) return;
    setUsername(initialUsername || '');
    setDisplayname(initialDisplayname || '');
    setBanner(initialBanner || '');
    setAvatar(initialAvatar || '');
    setBannerPosition(initialBannerPosition);
    setAvatarPosition(initialAvatarPosition);
    setBio(initialBio || '');
    setPronouns(initialPronouns || '');
    setSocialLinks(Array.isArray(initialSocialLinks) ? initialSocialLinks : []);
    setSelectedAccent(initialAccentColor || '');
    setSelectedAccentSecondary(initialAccentColorSecondary || '');
    setSelectedAccentSurface(initialAccentSurface || '');
    setUseGlassSurface(initialAccentSurfaceGlass);
    setSelectedProfileTextColor(initialProfileTextColor || '');
    setInterests(Array.isArray(initialInterests) ? initialInterests : []);
    setInterestInput('');
    setNewSocial('');
    setSocialError('');
    setEditingSocialIndex(null);
    setEditSocialInput('');
    setShowUrlModal(null);
    setUrlInput('');
    setHasChanges(false);
    setShowSuggested(false);
    setBannerCredits(initialBannerCredits || '');
    setAvatarCredits(initialAvatarCredits || '');
    setSelectedAccentSurface(initialAccentSurface || '');
    setSelectedProfileTextColor(initialProfileTextColor || '');
    setProfileBg(initialProfileBg || '');
    setProfileBgPosition(initialProfileBgPosition || '50% 50%');
    setProfileBgBlur(initialProfileBgBlur);
    setProfileBgDim(initialProfileBgDim);
    setBannerDim(initialBannerDim);
    // Restore cached colors immediately (no flash)
    const cached = initialBanner ? colorCache[initialBanner.trim()] : null;
    if (cached) {
      setExtractedColors(cached);
    } else {
      setExtractedColors([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ── Detectar cambios pendientes ──
  useEffect(() => {
    const changed =
      username !== (initialUsername || '') ||
      displayname !== (initialDisplayname || '') ||
      banner !== (initialBanner || '') ||          avatar !== (initialAvatar || '') ||
          avatarPosition !== initialAvatarPosition ||
          bannerPosition !== initialBannerPosition ||
          bio !== (initialBio || '') ||
      pronouns !== (initialPronouns || '') ||
      bannerCredits !== (initialBannerCredits || '') ||
      avatarCredits !== (initialAvatarCredits || '') ||
      JSON.stringify(socialLinks) !== JSON.stringify(initialSocialLinks || []) ||
      selectedAccent !== (initialAccentColor || '') ||
      selectedAccentSecondary !== (initialAccentColorSecondary || '') ||
      selectedAccentSurface !== (initialAccentSurface || '') ||
      useGlassSurface !== !!initialAccentSurfaceGlass ||
      profileBg !== (initialProfileBg || '') ||

      profileBgBlur !== initialProfileBgBlur ||
      profileBgDim !== initialProfileBgDim ||
      bannerDim !== initialBannerDim ||
      selectedProfileTextColor !== (initialProfileTextColor || '') ||
      JSON.stringify(interests) !== JSON.stringify(initialInterests || []) ||
      false;
    setHasChanges(changed);
  }, [
    username, displayname, banner, avatar, bio, pronouns, bannerCredits, avatarCredits, socialLinks,    selectedAccent, selectedAccentSecondary, interests,
    initialUsername, initialDisplayname, initialBanner, initialAvatar, initialBio, initialPronouns,
    initialBannerCredits, initialAvatarCredits,
    initialSocialLinks, initialAccentColor, initialAccentColorSecondary, initialAccentSurface, initialAccentSurfaceGlass, initialProfileBg, initialProfileBgPosition, initialProfileBgBlur,    initialProfileBgDim, initialBannerDim, initialInterests, initialAvatarPosition, initialBannerPosition,
  ]);

  // Extract colors when banner URL changes (with cache + debounce)
  useEffect(() => {
    const bannerUrl = banner.trim();
    if (!bannerUrl) {
      setExtractedColors([]);
      setExtracting(false);
      return;
    }

    const cached = colorCache[bannerUrl];
    if (cached) {
      setExtractedColors(cached);
      if (!selectedAccent) {
        setSelectedAccent(cached[0]);
      }
      setExtracting(false);
      return;
    }

    // Debounce 400ms: no extraer colores mientras el usuario escribe la URL
    setExtracting(false);

    const timer = setTimeout(async () => {
      try {
        setExtracting(true);
        const colors = await extractColors(bannerUrl);

        // Solo aplicar si la URL sigue siendo la misma después de la extracción
        if (banner.trim() === bannerUrl && colors.length >= 4) {
          setExtractedColors(colors);
          colorCache[bannerUrl] = colors;
          if (!selectedAccent) {
            setSelectedAccent(colors[0]);
          }
        }
      } catch {
        // Silently fail
      } finally {
        setExtracting(false);
      }
    }, 400);

    return () => {
      clearTimeout(timer);
    };
  }, [banner, selectedAccent]);

  const confirmClose = useCallback(() => {
    if (hasChanges) {
      setPendingClose(true);
    } else {
      onClose();
    }
  }, [hasChanges, onClose]);

  // Ref estable para evitar que el efecto se re-ejecute al cambiar de dependencias
  const confirmCloseRef = useRef(confirmClose);
  confirmCloseRef.current = confirmClose;

  const executeClose = useCallback(() => {
    setPendingClose(false);
    onClose();
  }, [onClose]);

  // ── Cerrar con Escape y scroll locking: manejado por ModalShell (<dialog> nativo)

  const handleSave = async () => {
    // ── Validación de límites coherentes (mismos que el servicio) ──
    const u = username.trim();
    const d = displayname.trim();
    const p = pronouns.trim();
    if (!USERNAME_RE.test(u)) {
      toast.error(t('auth.username_invalid_chars') || 'Username can only contain letters, numbers and underscores');
      return;
    }
    if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) {
      toast.error(t('auth.username_length') || `Username must be between ${USERNAME_MIN} and ${USERNAME_MAX} characters`);
      return;
    }
    if (d.length > DISPLAYNAME_MAX) {
      toast.error(t('modal.displayname_length') || `Display name can't exceed ${DISPLAYNAME_MAX} characters`);
      return;
    }
    if (p.length > PRONOUNS_MAX) {
      toast.error(t('modal.pronouns_length') || `Pronouns can't exceed ${PRONOUNS_MAX} characters`);
      return;
    }
    setSaving(true);
    try {
      await onSave({
        username: u,
        displayname: d || null,
        avatar_url: avatar.trim() || null,
        avatar_position: avatarPosition || null,
        banner_url: banner.trim() || null,
        banner_position: bannerPosition || null,
        banner_credits: bannerCredits.trim() || null,
        avatar_credits: avatarCredits.trim() || null,
        bio: bio.trim(),
        pronouns: p || null,
        social_links: socialLinks,
        accent_color: selectedAccent || null,
        accent_color_secondary: selectedAccentSecondary || null,
        accent_surface_color: selectedAccentSurface || null,
        accent_surface_glass: useGlassSurface,
        profile_text_color: selectedProfileTextColor || null,
        interests: interests,
        profile_background_url: profileBg.trim() || null,
        profile_background_position:      profileBgPosition,
        profile_background_blur: profileBgBlur,
        profile_background_dim: profileBgDim,
        banner_dim: bannerDim,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAddSocial = () => {
    if (!detected) {
      setSocialError(t('modal.social_detect_error'));
      return;
    }
    const username = detectedUsername.trim();
    if (!username) {
      setSocialError(t('modal.social_detect_error'));
      return;
    }
    // Rebuild URL with possibly edited username (sanitizada: solo http/https/mailto)
    const finalUrl = sanitizeUrl(detected.platform.urlTemplate(username));
    if (!finalUrl) {
      setSocialError(t('modal.social_detect_error'));
      return;
    }
    if (socialLinks.some((s) => s.url === finalUrl)) {
      setSocialError(t('modal.social_duplicate'));
      return;
    }
    setSocialLinks((prev) => [...prev, {
      platform: detected.platform.id,
      username,
      url: finalUrl,
    }]);
    setNewSocial('');
    setDetected(null);
    setDetectedUsername('');
    setSocialError('');
  };

  const handleCancelDetected = () => {
    setDetected(null);
    setDetectedUsername('');
    setNewSocial('');
    setSocialError('');
  };

  const handleRemoveSocial = (index) => {
    setSocialLinks((prev) => prev.filter((_, i) => i !== index));
    // Si se elimina un item mientras otro está en edición, los índices se
    // desplazan y editingSocialIndex apuntaría al link equivocado → cancelar.
    setEditingSocialIndex(null);
    setEditSocialInput('');
  };

  const handleSocialKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddSocial();
    }
  };

  // ── Editar un social link existente (re-detecta la plataforma al guardar) ──
  const handleStartEditSocial = (i) => {
    setEditingSocialIndex(i);
    setEditSocialInput(socialLinks[i]?.url || '');
    setSocialError('');
  };

  const handleCancelEditSocial = () => {
    setEditingSocialIndex(null);
    setEditSocialInput('');
    setSocialError('');
  };

  const handleSaveEditSocial = () => {
    if (editingSocialIndex === null) return;
    const input = editSocialInput.trim();
    if (!input) {
      setSocialError(t('modal.social_detect_error'));
      return;
    }
    const result = detectPlatform(input);
    if (!result) {
      setSocialError(t('modal.social_detect_error'));
      return;
    }
    // En edición se preserva la URL exacta que escribió el usuario: result.url
    // ya viene normalizada con protocolo por detectPlatform (el icono y el
    // username se actualizan igual por detección). NO se usa urlTemplate aquí
    // porque reconstruiría desde el username y truncaría la edición
    // (ej. https://x.com/user/status/123 → https://x.com/user).
    const finalUrl = sanitizeUrl(result.url || input);
    if (!finalUrl) {
      setSocialError(t('modal.social_detect_error'));
      return;
    }
    // Duplicado contra el resto de links (excluyendo el que se edita)
    if (socialLinks.some((s, i) => i !== editingSocialIndex && s.url === finalUrl)) {
      setSocialError(t('modal.social_duplicate'));
      return;
    }
    setSocialLinks((prev) => prev.map((link, i) =>
      i === editingSocialIndex
        ? { platform: result.platform.id, username: result.username || input, url: finalUrl }
        : link
    ));
    setEditingSocialIndex(null);
    setEditSocialInput('');
    setSocialError('');
  };

  const handleEditSocialKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSaveEditSocial(); }
    else if (e.key === 'Escape') {
      // stopPropagation: evitar que ModalShell cierre el modal entero al cancelar la edición
      e.preventDefault();
      e.stopPropagation();
      handleCancelEditSocial();
    }
  };

  // ── Submodal URL editing ──
  const urlInitialRef = useRef('');
  const [urlSubPendingClose, setUrlSubPendingClose] = useState(false);
  const hasUrlChanges = showUrlModal !== null && urlInput.trim() !== urlInitialRef.current;

  const handleOpenUrlModal = (type) => {
    const current = type === 'avatar' ? avatar : banner;
    urlInitialRef.current = current;
    setUrlInput(current);
    setShowUrlModal(type);
  };

  // ── Upload file to CDN (avatar/banner or profile background) ──
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !user?.id) return;

    if (!file.type.startsWith('image/')) {
      toast.error(t('modal.invalid_image_type') || 'Invalid image type');
      return;
    }

    const isBg = !!showProfileBgSubmodal;
    const uploadType = isBg ? 'banner' : showUrlModal;
    if (!uploadType) return;

    // Activar spinner en botón (para uploads no cacheados se verá;
    // para uploads cacheados React 18 batch los state updates y el
    // spinner queda invisible — es el comportamiento deseado).
    if (isBg) {
      setUploadingBgToCdn(true);
    } else {
      setUploadingToCdn(true);
    }

    try {
      // Mostrar preview local instantáneo mientras se sube en background
      const { localUrl, realUrlPromise } = uploadWithLocalPreview(file, user.id, uploadType);

      // Actualizar vista previa y también el input del submodal
      // para que ImagePositionEditor muestre la imagen inmediatamente
      if (isBg) {
        setProfileBg(localUrl);
        setProfileBgUrlInput(localUrl);
      } else if (showUrlModal === 'avatar') {
        setAvatar(localUrl);
        setUrlInput(localUrl);
      } else if (showUrlModal === 'banner') {
        setBanner(localUrl);
        setUrlInput(localUrl);
      }

      // Esperar subida real (desde caché o red)
      const realUrl = await realUrlPromise;

      // Usar uploadType capturado (const antes del await) en vez de
      // showUrlModal (que puede ser null si el usuario ya hizo Apply)
      if (isBg) {
        setProfileBg(realUrl);
        setProfileBgUrlInput(realUrl);
      } else if (uploadType === 'avatar') {
        setAvatar(realUrl);
        setUrlInput(realUrl);
      } else if (uploadType === 'banner') {
        setBanner(realUrl);
        setUrlInput(realUrl);
      }

      // Toast único de éxito — sin containerId para que use el
      // contenedor permanente de App.jsx (no el de ModalShell que
      // se destruye al cerrar el submodal).
      toast.success(t('upload.uploaded') || 'Image uploaded', { autoClose: 2000 });
    } catch (err) {
      console.error('CDN upload error:', err);
      toast.error(err.message || 'Upload failed', { autoClose: 3000 });
    } finally {
      if (isBg) {
        setUploadingBgToCdn(false);
      } else {
        setUploadingToCdn(false);
      }
      e.target.value = '';
    }
  };

  const handleUrlModalSave = () => {
    const url = urlInput.trim();
    if (showUrlModal === 'avatar') {
      setAvatar(url);
    } else if (showUrlModal === 'banner') {
      setBanner(url);
    }
    setShowUrlModal(null);
    setUrlInput('');
  };

  const closeUrlSubmodal = () => {
    if (hasUrlChanges) {
      setUrlSubPendingClose(true);
    } else {
      // Restaurar valor original al cancelar
      if (showUrlModal === 'avatar') {
        setAvatar(urlInitialRef.current);
        setAvatarPosition(initialAvatarPosition);
      } else if (showUrlModal === 'banner') {
        setBanner(urlInitialRef.current);
        setBannerPosition(initialBannerPosition);
      }
      setShowUrlModal(null);
      setUrlInput('');
    }
  };

  const confirmUrlDiscard = () => {
    setUrlSubPendingClose(false);
    // Restaurar valor original al descartar cambios
    if (showUrlModal === 'avatar') {
      setAvatar(urlInitialRef.current);
      setAvatarPosition(initialAvatarPosition);
    } else if (showUrlModal === 'banner') {
      setBanner(urlInitialRef.current);
      setBannerPosition(initialBannerPosition);
    }
    setShowUrlModal(null);
    setUrlInput('');
  };

  const handleUrlModalKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleUrlModalSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeUrlSubmodal(); }
  };


  // ── Profile Background submodal ──
  const bgUrlInitialRef = useRef('');
  const bgPositionInitialRef = useRef(profileBgPosition);
  const [bgSubPendingClose, setBgSubPendingClose] = useState(false);
  const hasBgChanges = showProfileBgSubmodal && profileBgUrlInput.trim() !== bgUrlInitialRef.current;

  const handleOpenProfileBgModal = () => {
    bgUrlInitialRef.current = profileBg;
    bgPositionInitialRef.current = profileBgPosition;
    setProfileBgUrlInput(profileBg);
    setShowProfileBgSubmodal(true);
  };

  const handleProfileBgModalSave = () => {
    const url = profileBgUrlInput.trim();
    setProfileBg(url);
    setShowProfileBgSubmodal(null);
    setProfileBgUrlInput('');
  };

  const closeBgSubmodal = () => {
    if (hasBgChanges) {
      setBgSubPendingClose(true);
    } else {
      // Restaurar valor original al cancelar
      setProfileBg(bgUrlInitialRef.current);
      setProfileBgPosition(bgPositionInitialRef.current);
      setShowProfileBgSubmodal(null);
      setProfileBgUrlInput('');
    }
  };

  const confirmBgDiscard = () => {
    setBgSubPendingClose(false);
    // Restaurar valor original al descartar cambios
    setProfileBg(bgUrlInitialRef.current);
    setProfileBgPosition(bgPositionInitialRef.current);
    setShowProfileBgSubmodal(null);
    setProfileBgUrlInput('');
  };

  const handleProfileBgUrlKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleProfileBgModalSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeBgSubmodal(); }
  };

  const BIO_MAX_LENGTH = 80;
  const defaultAvatar = DEFAULT_AVATAR;
  const previewDisplayname = displayname || username || 'username';

  return (
    <>
    <ModalShell isOpen={isOpen} onClose={onClose} onEscape={() => confirmCloseRef.current()}>
      {/* ── Header bar: title + actions ── */}
      <div className="fc-modal-header">
        <h3 className="fc-modal-title">{t('modal.edit_title')}</h3>
        <div className="fc-modal-header-actions">
          <button className="fc-modal-save" onClick={handleSave} disabled={saving}>
            {saving ? t('modal.saving') : t('modal.save')}
          </button>
          <button className="fc-modal-close" onClick={confirmClose} disabled={saving} title={t('modal.cancel')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Two-column grid layout ── */}
        <div className="fc-modal-grid">
          {/* ── LEFT COLUMN ── */}
          <div className="fc-modal-grid-left">
            {/* ── Preview Card (grande) ── */}
            <div className="fc-preview-card fc-preview-card--large"
              style={{
                '--accent-color': selectedAccent || 'transparent',
                '--accent-color-2': selectedAccentSecondary || selectedAccent || 'transparent',
              }}
            >
              <div className="fc-preview-card-banner" style={{ position: 'relative', overflow: 'hidden' }}>
                {banner ? (
                  <img
                    src={banner}
                    alt=""
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      ...getImageStyle(bannerPosition),
                    }}
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                ) : null}
                <div className="fc-preview-card-overlay"></div>
                {/* Edit banner icon — top right */}
                <button
                  type="button"
                  className="fc-preview-banner-edit"
                  onClick={(e) => { e.stopPropagation(); handleOpenUrlModal('banner'); }}
                  title={t('modal.edit_banner')}
                >
                  <FaCamera />
                </button>

                <div className="fc-preview-card-avatar">
                  <img
                    src={avatar || defaultAvatar}
                    alt="Preview"
                    style={getImageStyle(avatarPosition)}
                    onError={(e) => { e.target.src = defaultAvatar; }}
                  />
                  {/* Edit avatar icon — centered on avatar */}
                  <button
                    type="button"
                    className="fc-preview-avatar-edit"
                    onClick={(e) => { e.stopPropagation(); handleOpenUrlModal('avatar'); }}
                    title={t('modal.edit_avatar')}
                  >
                    <FaCamera />
                  </button>
                </div>                <div className="fc-preview-card-info" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                  <div style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                    <span className="fc-preview-card-name">{previewDisplayname}</span>
                    <span style={{ fontSize: '0.68rem', fontWeight: 400, opacity: 0.6, color: 'rgba(255,255,255,0.7)' }}>@{username}</span>
                    <Badge roles={userRoles} />
                  </div>

                  {/* Stats */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10, marginTop: 1,
                    fontSize: '0.7rem', color: 'rgba(255,255,255,0.7)',
                    textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                  }}>
                    <span style={{ display: 'flex', gap: 2 }}>
                      <strong style={{ color: '#fff', fontWeight: 700, fontSize: '0.75rem' }}>{initialFollowersCount}</strong>
                      {t('profile.followers')}
                    </span>
                  </div>

                  {/* Bio + pronouns inline */}
                  {(bio.trim() || pronouns.trim()) && (
                    <p style={{
                      margin: 0, fontSize: '0.7rem', lineHeight: 1.4,
                      color: 'rgba(255,255,255,0.75)', textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                      maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    }}>
                      {bio.trim()}
                      {bio.trim() && pronouns.trim() && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.5 }}> · {pronouns.trim()}</span>}
                      {!bio.trim() && pronouns.trim() && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.5 }}>{pronouns.trim()}</span>}
                    </p>
                  )}

                  {/* Social links */}
                  {socialLinks.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 1 }}>
                      {socialLinks.slice(0, 3).map((link, i) => (
                        <span key={link.url} style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 22, height: 22, borderRadius: '50%',
                          background: 'rgba(255,255,255,0.07)', backdropFilter: 'blur(6px)',
                          fontSize: '0.6rem', color: 'rgba(255,255,255,0.7)',
                        }}>
                          {React.createElement(getPlatformIcon(link.platform))}
                        </span>
                      ))}
                      {socialLinks.length > 3 && (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 22, height: 22, borderRadius: '50%',
                          background: 'rgba(255,255,255,0.07)', backdropFilter: 'blur(6px)',
                          fontSize: '0.55rem', fontWeight: 700, color: 'rgba(255,255,255,0.7)',
                        }}>
                          +{socialLinks.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── (URL submodal now rendered outside as independent dialog) ── */}

            {/* Perfil — Username + Bio */}
            <div className="fc-modal-card">
              <label className="fc-modal-label">
                {t('modal.nickname_label') || 'Nickname'}
                <input
                  className="fc-modal-input"
                  value={displayname}
                  onChange={(e) => setDisplayname(e.target.value)}
                  placeholder={t('modal.nickname_placeholder') || 'Your display name'}
                  maxLength={DISPLAYNAME_MAX}
                />
                <span className="fc-modal-char-count">{displayname.length}/{DISPLAYNAME_MAX}</span>
              </label>
              <label className="fc-modal-label">
                {t('modal.username_label')}
                <input
                  className="fc-modal-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="username"
                  maxLength={USERNAME_MAX}
                />
                <span className="fc-modal-char-count">{username.length}/{USERNAME_MAX}</span>
              </label>
              <label className="fc-modal-label" style={{ marginTop: 2 }}>
                {t('modal.pronouns_label')}
                <input
                  className="fc-modal-input"
                  value={pronouns}
                  onChange={(e) => setPronouns(e.target.value)}
                  placeholder={t('modal.pronouns_placeholder')}
                  maxLength={PRONOUNS_MAX}
                />
                <span className="fc-modal-char-count">{pronouns.length}/{PRONOUNS_MAX}</span>
                {/* Hint text below the input
                <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted, #6b7280)', marginTop: 2, display: 'block' }}>
                  {t('modal.pronouns_hint')}
                </span>
                */}
              </label>
              <label className="fc-modal-label">
                {t('modal.bio_label')}
                <textarea
                  className="fc-modal-input"
                  value={bio}
                  onChange={(e) => {
                    if (e.target.value.length <= BIO_MAX_LENGTH) setBio(e.target.value);
                  }}
                  rows={2}
                  maxLength={BIO_MAX_LENGTH}
                  placeholder={t('modal.bio_label')}
                />
                <span className="fc-modal-char-count">
                  {bio.length}/{BIO_MAX_LENGTH}
                </span>
              </label>
            </div>

            {/* ── Interests ── */}
            <div className="fc-modal-card">
              <label className="fc-modal-label">{t('modal.interests')}</label>

              {/* Input + add button */}
              <div className="fc-modal-interests-input-row">
                <input
                  className="fc-modal-input fc-modal-interests-input"
                  value={interestInput}
                  onChange={(e) => setInterestInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const val = interestInput.trim();
                      if (val && !interests.includes(val)) {
                        setInterests((prev) => [...prev, val]);
                      }
                      setInterestInput('');
                    }
                  }}
                  placeholder={t('modal.interests_placeholder')}
                />
                <button
                  type="button"
                  className="fc-modal-interests-add"
                  onClick={() => {
                    const val = interestInput.trim();
                    if (val && !interests.includes(val)) {
                      setInterests((prev) => [...prev, val]);
                    }
                    setInterestInput('');
                  }}
                  disabled={!interestInput.trim()}
                >
                  +
                </button>
              </div>

              {/* Pills de intereses seleccionados */}
              {interests.length > 0 && (
                <div className="fc-modal-interests-pills">
                  {interests.map((interest, i) => (
                    <span key={interest} className="fc-modal-interest-pill">
                      {interest}
                      <button
                        type="button"
                        className="fc-modal-interest-pill-remove"
                        onClick={() => setInterests((prev) => prev.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* ── Lista de intereses sugeridos (expandible) ── */}
              <div className="fc-modal-suggested-wrapper">
                <button
                  type="button"
                  className="fc-modal-suggested-toggle"
                  onClick={() => setShowSuggested((prev) => !prev)}
                >
                  <span>{t('modal.suggested_interests')}</span>
                  <svg
                    className={`fc-modal-suggested-chevron ${showSuggested ? 'fc-modal-suggested-chevron--open' : ''}`}
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                <div className={`fc-modal-suggested-collapse ${showSuggested ? 'fc-modal-suggested-collapse--open' : ''}`}>
                  <div className="fc-modal-suggested-list">
                    {SUGGESTED_INTERESTS.filter((s) => !interests.includes(s)).map((interest) => (
                      <button
                        key={interest}
                        type="button"
                        className="fc-modal-suggested-chip"
                        onClick={() => setInterests((prev) => [...prev, interest])}
                      >
                        + {interest}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Social Links ── */}
            <div className="fc-modal-card">
              <label className="fc-modal-label">{t('modal.social_links')}</label>
              <div className="fc-modal-social-input-row">
                <input
                  className="fc-modal-input fc-modal-social-input"
                  value={newSocial}
                  onChange={(e) => { setNewSocial(e.target.value); setSocialError(''); }}
                  onKeyDown={handleSocialKeyDown}
                  placeholder={t('modal.social_placeholder')}
                />
                <button
                  type="button"
                  className="fc-modal-social-add"
                  onClick={handleAddSocial}
                  disabled={!detected}
                >
                  {detected ? t('modal.social_add') : '+'}
                </button>
              </div>
              {socialError && <p className="fc-modal-social-error">{socialError}</p>}

              {detected && (
                <div className="fc-modal-social-detected">
                  <span className="fc-modal-social-detected-icon">
                    {React.createElement(getPlatformIcon(detected.platform.id))}
                  </span>
                  <span className="fc-modal-social-detected-name">{getPlatformName(detected.platform.id)}</span>
                  <input
                    className="fc-modal-input fc-modal-social-detected-input"
                    value={detectedUsername}
                    onChange={(e) => setDetectedUsername(e.target.value)}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="fc-modal-social-detected-cancel"
                    onClick={handleCancelDetected}
                    title={t('common.cancel')}
                  >
                    ×
                  </button>
                </div>
              )}
              {/* ── Social links list (colapsable) ── */}
              {socialLinks.length > 0 && (
              <div className="fc-modal-suggested-wrapper">
                <button
                  type="button"
                  className="fc-modal-suggested-toggle"
                  onClick={() => setSocialLinksExpanded((prev) => !prev)}
                >
                  <span>{t('modal.social_links')} ({socialLinks.length})</span>
                  <svg
                    className={`fc-modal-suggested-chevron ${socialLinksExpanded ? 'fc-modal-suggested-chevron--open' : ''}`}
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                <div className={`fc-modal-suggested-collapse ${socialLinksExpanded ? 'fc-modal-suggested-collapse--open' : ''}`}>
                <div className="fc-modal-social-list">
                  {socialLinks.map((link, i) =>
                    editingSocialIndex === i ? (
                      <div key={link.url} className="fc-modal-social-item fc-modal-social-item--editing">
                        <span className="fc-modal-social-icon">{React.createElement(getPlatformIcon(link.platform))}</span>
                        <input
                          className="fc-modal-input fc-modal-social-edit-input"
                          value={editSocialInput}
                          onChange={(e) => { setEditSocialInput(e.target.value); setSocialError(''); }}
                          onKeyDown={handleEditSocialKeyDown}
                          autoFocus
                          placeholder={t('modal.social_placeholder')}
                        />
                        <button
                          type="button"
                          className="fc-modal-social-edit-save"
                          onClick={handleSaveEditSocial}
                          title={t('modal.save')}
                        >
                          <FaCheck />
                        </button>
                        <button
                          type="button"
                          className="fc-modal-social-edit-cancel"
                          onClick={handleCancelEditSocial}
                          title={t('modal.cancel')}
                        >
                          <FaTimes />
                        </button>
                      </div>
                    ) : (
                      <div key={link.url} className="fc-modal-social-item">
                        <span className="fc-modal-social-icon">{React.createElement(getPlatformIcon(link.platform))}</span>
                        <span className="fc-modal-social-username">@{link.username}</span>
                        <button
                          type="button"
                          className="fc-modal-social-edit"
                          onClick={() => handleStartEditSocial(i)}
                          title={t('common.edit')}
                        >
                          <FaEdit />
                        </button>
                        <button
                          type="button"
                          className="fc-modal-social-remove"
                          onClick={() => handleRemoveSocial(i)}
                          title={t('common.delete')}
                        >
                          ×
                        </button>
                      </div>
                    )
                  )}
                </div>
                </div>
              </div>
              )}
              <p className="fc-modal-social-hint">{t('modal.social_example')}</p>
            </div>
          </div>

          {/* ── RIGHT COLUMN: Explore card preview + Accent colors + Surface color ── */}
          <div className="fc-modal-grid-right">
            {/* ── Explore card preview (reusa las clases reales de explore.css) ── */}
            <div className={`explore-card${(selectedAccent || selectedAccentSecondary) ? ' explore-card--accent' : ''}`}
              style={{
                '--accent-color': selectedAccent || 'transparent',
                '--accent-color-2': selectedAccentSecondary || selectedAccent || 'transparent',
                marginBottom: 0,
              }}
            >
              <div className="explore-card-banner">
                {banner.trim() ? (
                  <img
                    className="explore-card-banner-img"
                    src={banner.trim()}
                    alt=""
                    style={{ objectFit: 'cover', width: '100%', height: '100%', ...getImageStyle(bannerPosition) }}
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                ) : (
                  <div style={{ width: '100%', height: '100%', background: 'var(--color-surface-hover, #252525)' }} />
                )}
                <div className="explore-card-overlay" />
              </div>

              <div className="explore-card-body">
              <Avatar
                  className="explore-card-avatar"
                  src={avatar || defaultAvatar}
                  alt=""
                  style={getImageStyle(avatarPosition)}
                />

                <div className="explore-card-info">
                  <div className="explore-card-name-row">
                    <span className="explore-card-name">{previewDisplayname}</span>
                    <span style={{ fontSize: '0.68rem', fontWeight: 400, opacity: 0.5 }}>@{username}</span>
                    <Badge roles={userRoles} />
                  </div>
                  <span className="explore-card-followers">
                    {initialFollowersCount} {initialFollowersCount === 1 ? t('explore.followers_singular') : t('explore.followers_plural')}
                  </span>
                  {(bio.trim() || pronouns.trim()) && (
                    <p className="explore-card-bio">
                      {bio.trim()}
                      {bio.trim() && pronouns.trim() && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.5 }}> · {pronouns.trim()}</span>}
                      {!bio.trim() && pronouns.trim() && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.5 }}>{pronouns.trim()}</span>}
                    </p>
                  )}

                  {/* ── Interests (max 3, then "see more" → profile) ── */}
                  {interests?.length > 0 && (
                    <div className="explore-card-interests">
                      {interests.slice(0, 3).map((interest, i) => (
                        <span key={interest} className="explore-card-interest">{interest}</span>
                      ))}
                      {interests.length > 3 && (
                        <button
                          type="button"
                          className="explore-card-interests-more"
                          disabled
                        >
                          {t('profile.show_more', { count: interests.length - 3 })}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="explore-card-action">
                  <button type="button" className="follow-btn follow-btn--follow" disabled>
                    {t('follow.follow')}
                  </button>
                </div>
              </div>
            </div>

            {/* ── Profile Background ── */}
            <div className="fc-modal-card">
              <label className="fc-modal-label">{t('modal.profile_background')}</label>

              <div className="fc-modal-bg-preview-row">
                {profileBg.trim() ? (
                  <div
                    className="fc-modal-bg-thumb"
                    style={{ backgroundImage: `url(${profileBg.trim()})`, ...getBackgroundStyle(profileBgPosition) }}
                  />
                ) : (
                  <div className="fc-modal-bg-thumb fc-modal-bg-thumb--empty">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </div>
                )}
                <button
                  type="button"
                  className="fc-modal-bg-edit-btn"
                  onClick={handleOpenProfileBgModal}
                  title={t('modal.profile_bg_edit')}
                >
                  <FaCamera />
                </button>
              </div>

              {profileBg.trim() && (
                <>
                  {/* Blur slider */}
                  <div className="fc-modal-range-row">
                    <span className="fc-modal-range-label">{t('modal.profile_bg_blur')}</span>
                    <div className="fc-modal-range-control">
                      <input
                        type="range"
                        min="0"
                        max="20"
                        step="2"
                        value={profileBgBlur}
                        onChange={(e) => setProfileBgBlur(Number(e.target.value))}
                        className="fc-modal-range"
                      />
                      <span className="fc-modal-range-value">{profileBgBlur}px</span>
                    </div>
                  </div>
                  {/* Dim slider */}
                  <div className="fc-modal-range-row">
                    <span className="fc-modal-range-label">{t('modal.profile_bg_dim')}</span>
                    <div className="fc-modal-range-control">
                      <input
                        type="range"
                        min="0"
                        max="80"
                        step="5"
                        value={profileBgDim}
                        onChange={(e) => setProfileBgDim(Number(e.target.value))}
                        className="fc-modal-range"
                      />
                      <span className="fc-modal-range-value">{profileBgDim}%</span>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* ── Accent Color — consolidado (principal, secundario, superficie + glass) ── */}
            <div className="fc-modal-card">
              <label className="fc-modal-label">{t('modal.accent_color')}</label>

              {/* ── Color principal ── */}
              {banner.trim() && extracting && (
                <p className="fc-modal-social-hint">{t('modal.extracting_colors')}</p>
              )}
              {banner.trim() && !extracting && extractedColors.length < 4 && (
                <p className="fc-modal-social-hint">{t('modal.add_banner_hint')}</p>
              )}

              <div className="fc-modal-color-section">
                <span className="fc-modal-color-subtitle">{t('modal.color_primary')}</span>
                <div className="fc-modal-color-picker">
                  {banner.trim() && !extracting && extractedColors.length >= 4 && extractedColors.map((color, i) => (
                    <button
                      key={color}
                      type="button"
                      className={`fc-modal-color-swatch ${selectedAccent === color ? 'fc-modal-color-swatch--selected' : ''}`}
                      style={{ '--swatch-color': color }}
                      onClick={() => setSelectedAccent(color)}
                      title={`${t('modal.accent_color')}: ${color}`}
                    >
                      {selectedAccent === color && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  ))}

                  <label className="fc-modal-color-swatch fc-modal-custom-swatch"
                    htmlFor="accent-color-input"
                    title={`${t('modal.accent_color_custom')}: ${selectedAccent || '#000000'}`}
                    style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <input
                      id="accent-color-input"
                      type="color"
                      value={selectedAccent || '#000000'}
                      onChange={(e) => setSelectedAccent(e.target.value)}
                      style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
                    />
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </label>
                  <span style={{ fontSize: '0.78rem', color: 'var(--color-text-muted, #6b7280)', whiteSpace: 'nowrap', alignSelf: 'center' }}>
                    {t('modal.accent_color_custom')}
                  </span>
                </div>

                {selectedAccent && extractedColors.length > 0 && !extractedColors.includes(selectedAccent) && (
                  <button
                    type="button"
                    onClick={() => setSelectedAccent(extractedColors[0] || '')}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--color-text-muted, #6b7280)',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      padding: '2px 0',
                      marginTop: 4,
                      textDecoration: 'underline',
                      textUnderlineOffset: 2,
                    }}
                  >
                    {t('common.reset')}
                  </button>
                )}
              </div>

              {/* ── Color secundario ── */}
              <div className="fc-modal-color-section">
                <span className="fc-modal-color-subtitle">{t('modal.accent_color_secondary')}</span>
                <div className="fc-modal-color-picker">
                  <label
                    htmlFor="accent-secondary-input"
                    className="fc-modal-color-swatch"
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: selectedAccentSecondary || '#000000',
                      border: '2px solid var(--color-border, #2a2a2a)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      transition: 'transform 0.15s ease',
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
                    onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                    title={`${t('modal.accent_color_secondary')}: ${selectedAccentSecondary || '#000000'}`}
                  >
                  <input
                    id="accent-secondary-input"
                    type="color"
                    value={selectedAccentSecondary || '#000000'}
                    onChange={(e) => setSelectedAccentSecondary(e.target.value)}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
                  />
                  </label>
                  {selectedAccentSecondary && (
                    <button
                      type="button"
                      onClick={() => setSelectedAccentSecondary('')}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-text-muted, #6b7280)',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        padding: '2px 6px',
                      }}
                    >
                      {t('common.clear')}
                    </button>
                  )}
                </div>
              </div>

              {/* ── Color de superficie + Glass ── */}
              <div className="fc-modal-color-section">
                <span className="fc-modal-color-subtitle">{t('modal.accent_surface')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <label
                    htmlFor="accent-surface-input"
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: selectedAccentSurface || 'rgba(28, 28, 30, 0.7)',
                      border: selectedAccentSurface ? '2px solid var(--color-border, #2a2a2a)' : '2px dashed var(--color-text-muted, #6b7280)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      transition: 'transform 0.15s ease',
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
                    onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                    title={`${t('modal.accent_surface')}: ${selectedAccentSurface || t('modal.accent_surface_default')}`}
                  >
                  <input
                    id="accent-surface-input"
                    type="color"
                    value={selectedAccentSurface || '#1c1c1e'}
                    onChange={(e) => setSelectedAccentSurface(e.target.value)}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
                  />
                  </label>
                  <span style={{ fontSize: '0.78rem', color: 'var(--color-text-muted, #6b7280)' }}>
                    {selectedAccentSurface ? selectedAccentSurface : t('modal.accent_surface_default')}
                  </span>
                  {selectedAccentSurface && (
                    <button
                      type="button"
                      onClick={() => setSelectedAccentSurface('')}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-text-muted, #6b7280)',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        padding: '2px 6px',
                      }}
                    >
                      {t('common.clear')}
                    </button>
                  )}
                </div>
              </div>

              {/* ── Profile text color ── */}
              <div className="fc-modal-color-section">
                <span className="fc-modal-color-subtitle">{t('modal.profile_text_color')}</span>
                <div className="fc-modal-color-picker">
                  <label
                    htmlFor="profile-text-color-input"
                    className="fc-modal-color-swatch"
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: selectedProfileTextColor || 'var(--color-text, #ffffff)',
                      border: selectedProfileTextColor ? '2px solid var(--color-border, #2a2a2a)' : '2px dashed var(--color-text-muted, #6b7280)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      transition: 'transform 0.15s ease',
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
                    onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                    title={`${t('modal.profile_text_color')}: ${selectedProfileTextColor || '#ffffff'}`}
                  >
                  <input
                    id="profile-text-color-input"
                    type="color"
                    value={selectedProfileTextColor || '#ffffff'}
                    onChange={(e) => setSelectedProfileTextColor(e.target.value)}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
                  />
                  </label>
                  <span style={{ fontSize: '0.78rem', color: 'var(--color-text-muted, #6b7280)' }}>
                    {selectedProfileTextColor || t('modal.profile_text_color_default')}
                  </span>
                  {selectedProfileTextColor && (
                    <button
                      type="button"
                      onClick={() => setSelectedProfileTextColor('')}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-text-muted, #6b7280)',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        padding: '2px 6px',
                      }}
                    >
                      {t('common.clear')}
                    </button>
                  )}
                </div>
              </div>

              {/* ── Glass mode toggle ── */}
              <div className="fc-modal-glass-toggle">
                <span className="fc-modal-glass-toggle-label">{t('modal.accent_surface_glass')}</span>
                <button
                  type="button"
                  className={`fc-modal-glass-switch ${useGlassSurface ? 'fc-modal-glass-switch--on' : ''}`}
                  onClick={() => setUseGlassSurface((prev) => !prev)}
                  role="switch"
                  aria-checked={useGlassSurface}
                >
                  <div className="fc-modal-glass-switch-knob" />
                </button>
              </div>
            </div>



          </div>
        </div>

      {/* ── Discard changes confirmation ── */}
      {pendingClose && (
        <ConfirmModal
          message={t('modal.discard_changes')}
          onConfirm={executeClose}
          onCancel={() => setPendingClose(false)}
        />
      )}
    </ModalShell>

      {/* ── URL submodal as independent dialog ── */}
      <ModalShell
        isOpen={showUrlModal !== null}
        onClose={closeUrlSubmodal}
        className="fc-modal--confirm"
      >
        <h4 className="fc-modal-sub-title">
          {showUrlModal === 'avatar' ? t('modal.avatar_url') : t('modal.banner_url')}
        </h4>
        <div
          className={`fc-modal-drag-zone ${isDragOver ? 'fc-modal-drag-zone--active' : ''}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="fc-modal-upload-row">
            <label className="fc-modal-upload-btn">
              {uploadingToCdn ? <FaSpinner className="fc-spin" /> : <FaUpload />}
              <span>{uploadingToCdn ? t('common.loading') : (t('modal.upload_image') || 'Subir imagen')}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handleFileUpload}
                disabled={uploadingToCdn}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
            </label>
            <span className="fc-modal-upload-or">{t('modal.or_paste_url') || 'O pega una URL'}</span>
          </div>
          <input
            className="fc-modal-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleUrlModalKeyDown}
            placeholder={showUrlModal === 'avatar' ? 'https://.../avatar.jpg' : 'https://.../banner.jpg'}
            autoFocus
          />
          {isDragOver && (
            <div className="fc-modal-drag-overlay">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span>{t('modal.drop_image') || 'Drop image here'}</span>
            </div>
          )}
        </div>
        {/* ── Credits input ── */}
        <input
          className="fc-modal-input"
          value={showUrlModal === 'avatar' ? avatarCredits : bannerCredits}
          onChange={(e) => {
            if (showUrlModal === 'avatar') setAvatarCredits(e.target.value);
            else setBannerCredits(e.target.value);
          }}
          placeholder={t('modal.credits_placeholder')}
          style={{ marginTop: 8 }}
        />        {/* ── Banner dim slider (only for banner) ── */}
        {showUrlModal === 'banner' && (
          <div style={{ marginTop: 12 }}>
            <div className="fc-modal-range-row">
              <span className="fc-modal-range-label">{t('modal.banner_dim') || 'Banner darkness'}</span>
              <div className="fc-modal-range-control">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={bannerDim}
                  onChange={(e) => setBannerDim(Number(e.target.value))}
                  className="fc-modal-range"
                />
                <span className="fc-modal-range-value">{bannerDim}%</span>
              </div>
            </div>
          </div>
        )}
        {/* ── Image position editor ── */}
        {urlInput.trim() && (
          <div style={{ marginTop: 10 }}>              <ImagePositionEditor
              key={showUrlModal}
              imageUrl={urlInput.trim()}
              initialPosition={showUrlModal === 'avatar' ? avatarPosition : bannerPosition}
              aspectRatio={showUrlModal === 'avatar' ? 1 : 40 / 11}
              circular={showUrlModal === 'avatar'}
              onPositionChange={(pos) => {
                if (showUrlModal === 'avatar') setAvatarPosition(pos);
                else if (showUrlModal === 'banner') setBannerPosition(pos);
              }}
            />
          </div>
        )}
        <div className="fc-modal-sub-actions">
          <button type="button" className="fc-modal-sub-save" onClick={handleUrlModalSave} disabled={uploadingToCdn}>
            {uploadingToCdn ? (t('common.loading') || 'Cropping...') : t('modal.apply')}
          </button>            <button type="button" className="fc-modal-sub-cancel" onClick={closeUrlSubmodal}>
              {t('modal.cancel')}
            </button>
          </div>
      </ModalShell>

      {/* ── URL submodal confirm discard ── */}
      {urlSubPendingClose && (
        <ConfirmModal
          message={t('modal.discard_changes')}
          onConfirm={confirmUrlDiscard}
          onCancel={() => setUrlSubPendingClose(false)}
        />
      )}

      {/* ── Profile Background submodal as independent dialog ── */}
      <ModalShell
        isOpen={showProfileBgSubmodal}
        onClose={closeBgSubmodal}
        className="fc-modal--confirm"
      >
        <h4 className="fc-modal-sub-title">{t('modal.profile_background')}</h4>
        <div
          className={`fc-modal-drag-zone ${isDragOver ? 'fc-modal-drag-zone--active' : ''}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="fc-modal-upload-row">
            <label className="fc-modal-upload-btn">
              {uploadingBgToCdn ? <FaSpinner className="fc-spin" /> : <FaUpload />}
              <span>{uploadingBgToCdn ? t('common.loading') : t('modal.upload_image') || 'Subir imagen'}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handleFileUpload}
                disabled={uploadingBgToCdn}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
            </label>
            <span className="fc-modal-upload-or">{t('modal.or_paste_url') || 'O pega una URL'}</span>
          </div>
          <input
            className="fc-modal-input"
            value={profileBgUrlInput}
            onChange={(e) => setProfileBgUrlInput(e.target.value)}
            onKeyDown={handleProfileBgUrlKeyDown}
            placeholder="https://.../background.jpg"
            autoFocus
          />
          {isDragOver && (
            <div className="fc-modal-drag-overlay">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span>{t('modal.drop_image') || 'Drop image here'}</span>
            </div>
          )}
        </div>
        {profileBgUrlInput.trim() && (
          <div style={{ marginTop: 10 }}>
            <ImagePositionEditor
              key="profile-bg"
              imageUrl={profileBgUrlInput.trim()}
              initialPosition={profileBgPosition}
              aspectRatio={clientViewportRatio}
              circular={false}
              backgroundMode
              onPositionChange={(pos) => setProfileBgPosition(pos)}
            />
          </div>
        )}
        <div className="fc-modal-sub-actions">
          <button type="button" className="fc-modal-sub-save" onClick={handleProfileBgModalSave} disabled={uploadingBgToCdn}>
            {t('modal.apply')}
          </button>              <button type="button" className="fc-modal-sub-cancel" onClick={closeBgSubmodal}>
              {t('modal.cancel')}
            </button>
          </div>
      </ModalShell>

      {/* ── Background submodal confirm discard ── */}
      {bgSubPendingClose && (
        <ConfirmModal
          message={t('modal.discard_changes')}
          onConfirm={confirmBgDiscard}
          onCancel={() => setBgSubPendingClose(false)}
        />
      )}
    </>
  );
}
