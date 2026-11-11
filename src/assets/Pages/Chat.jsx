import React, { useState, useEffect, useCallback, useRef, useLayoutEffect, useContext } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../services/i18n/useI18n';
import {
  getConversations,
  getMessages,
  sendMessage,
  decryptMessage,
  markAsRead,
  getOrCreateConversation,
  deleteMessage,
  deleteMessageForMe,
  editMessage,
  pinMessage,
  addReaction,
  togglePinConversation,
  subscribeToMessages,
  subscribeToConversations,
  broadcastTyping,
  subscribeToTyping,
  getNicknames, getCachedNicknames, cacheNicknames,
  getBubbleColors, getCachedBubbleColors, cacheBubbleColors,
  getChatBackgrounds,
  getPinnedMessages, getDecryptedMessages,
} from '../services/chatService';
import { getFollowing } from '../services/followService';
import { getUserProfile } from '../services/userService';
import { isBlocked, blockUser, unblockUser, unfollowBothWays, getCachedBlockStatus, cacheBlockStatus } from '../services/blockService';
import FollowButton from '../Resources/Components/FollowButton';
import ModalShell from '../Resources/Components/ModalShell';
import { FaComment, FaSearch, FaArrowLeft, FaPlus, FaTimes, FaUserPlus, FaUsers, FaTrash, FaPalette, FaBan, FaThumbtack, FaCopy, FaEdit, FaCheck, FaSmile, FaReply, FaImage, FaMusic, FaUser, FaPhone, FaLock, FaSpinner,  FaEllipsisH, FaArrowDown, FaPhoneSlash, FaMicrophone, FaMicrophoneSlash, FaPhoneAlt, FaVideo } from 'react-icons/fa';
import Avatar from '../Resources/Components/Avatar';
import Badge from '../Resources/Components/Badge';
import Tooltip from '../Resources/Components/Tooltip';
import GifPicker from '../Resources/Components/GifPicker';
import SongPicker from '../Resources/Components/SongPicker';
import MediaPicker from '../Resources/Components/MediaPicker';
import ChatSongCard from '../Resources/Components/ChatSongCard';
import ChatCommunityCard from '../Resources/Components/ChatCommunityCard';
import ChatSharedPostCard from '../Resources/Components/ChatSharedPostCard';
import ChatAccountCard from '../Resources/Components/ChatAccountCard';
import { withPreviewFallback } from '../services/musicService';
import { getTimeAgo, IMG_RE, isAttachableVideoUrl, getEmbedUrl, detectMediaFromContent, getImageStyle, sanitizeUrl } from '../services/helpers';
import PostVideoPlayer from '../Resources/Components/PostVideoPlayer';
import { getClipboardImageFile } from '../services/clipboard';
import NicknameModal from '../Resources/Components/NicknameModal';
import BubbleColorModal from '../Resources/Components/BubbleColorModal';
import ChatBackgroundModal from '../Resources/Components/ChatBackgroundModal';
import { getPost } from '../services/postService';
import { ensureDarkSurface, extractColors, getContrastFromHex, hexToRgba, mixHex } from '../services/colorExtractor';
import RichText from '../Resources/Components/RichText';
import SafeImage from '../Resources/Components/SafeImage';
import ConfirmModal from '../Resources/Components/ConfirmModal';
import LinkPreview from '../Resources/Components/LinkPreview';
import { toast } from 'react-toastify';
import { supabase } from '../services/supabaseclient';
import { uploadImage } from '../services/cdnService';
import usePageTitle from '../../hooks/usePageTitle';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import '../Resources/Styles/chat.css';
import '../Resources/Styles/explore.css';
import '../Resources/Styles/profiles.css';
import '../Resources/Styles/post.css';
import '../Resources/Components/css/modal.css';
import '../Resources/Components/css/postCard.css';
import { getItem, setItem, removeItem, getSessionItem, setSessionItem, removeSessionItem } from '../services/secureStorage';
import { useUserStatus } from '../services/useUserStatus';
import { useRegisterMultipleUserStatus, UserStatusContext } from '../../context/UserStatusContext';
import { useCall } from '../../context/CallContext';
import { getCallsForConversations, subscribeToCalls } from '../services/callService';

// ── Helper: corrige estados obsoletos usando user_status_updated_at ──
const STALE_STATUS_MS = 60 * 1000;
function computeEffectiveStatus(user) {
  if (!user?.user_status) return null;
  if (user.user_status === 'disconnected') return 'disconnected';
  if (!user.user_status_updated_at) return user.user_status;
  const ageMs = Date.now() - new Date(user.user_status_updated_at).getTime();
  return ageMs > STALE_STATUS_MS ? 'disconnected' : user.user_status;
}

// ── Historial de llamadas ──
// Solo las terminadas cuentan como historial: la que está en curso ya tiene su
// propio overlay (CallOverlay) y no debe duplicarse en el hilo.
const CALL_HISTORY_STATUSES = ['ended', 'missed', 'declined'];

/** Duración "m:ss" de una llamada (vacío si nunca llegó a empezar). */
function formatCallDuration(call) {
  if (!call?.started_at || !call?.ended_at) return '';
  const secs = Math.max(0, Math.round((new Date(call.ended_at) - new Date(call.started_at)) / 1000));
  if (secs < 1) return '';
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** Texto del evento: perdida / rechazada / saliente / entrante. */
function callEventLabel(call, userId, t) {
  if (call.status === 'missed') return t('chat.call_missed');
  if (call.status === 'declined') return t('chat.call_declined');
  return call.caller_id === userId ? t('chat.call_log_outgoing') : t('chat.call_log_incoming');
}

/** Evento de llamada dentro del hilo: fila centrada, sin burbuja. */
function ChatCallEvent({ call, userId, t, locale }) {
  const missed = call.status === 'missed' || call.status === 'declined';
  const duration = formatCallDuration(call);
  return (
    <div className={`chat-call-event${missed ? ' chat-call-event--missed' : ''}`}>
      <span className="chat-call-event-icon"><FaPhoneAlt /></span>
      <span className="chat-call-event-label">{callEventLabel(call, userId, t)}</span>
      {duration && <span className="chat-call-event-duration">{duration}</span>}
      <span className="chat-call-event-time">{getTimeAgo(t, locale, call.created_at)}</span>
    </div>
  );
}

/**
 * Imagen de una burbuja del chat. En cuanto conoce el tamaño real fija su
 * ancho (respetando el ratio) para que la burbuja se ajuste a la imagen y no
 * quede hueco a los lados en fotos verticales.
 */
const CHAT_IMG_MAX_W = 320;
const CHAT_IMG_MAX_H = 260;

function ChatImage({ src, alt, onClick }) {
  const [width, setWidth] = useState(null);

  const handleLoad = (e) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    if (!naturalWidth || !naturalHeight) return;
    const scale = Math.min(1, CHAT_IMG_MAX_W / naturalWidth, CHAT_IMG_MAX_H / naturalHeight);
    setWidth(Math.round(naturalWidth * scale));
  };

  return (
    <SafeImage
      src={src}
      alt={alt}
      className="chat-message-media-img"
      onClick={onClick}
      onLoad={handleLoad}
      style={width ? { width: `${width}px` } : undefined}
    />
  );
}

/**
 * Etiqueta corta para el preview de una conversación o de un mensaje citado:
 * si el texto contiene una imagen o un video, se muestra "Image" / "Video".
 * Devuelve null si no hay media (el caller pinta el texto tal cual).
 */
function mediaPreviewLabel(text) {
  if (!text) return null;
  const { imageUrl, videoUrl } = detectMediaFromContent(text);
  if (videoUrl) {
    return <><FaVideo className="chat-list-item-preview-icon" /> Video</>;
  }
  if (imageUrl || /(giphy|tenor|klipy)\.com|(\.|\/)gif/i.test(text)) {
    return <><FaImage className="chat-list-item-preview-icon" /> {/(giphy|tenor|klipy)\.com/i.test(text) ? 'GIF' : 'Image'}</>;
  }
  return null;
}

export default function Chat() {
  const { t, locale } = useI18n();
  const { user, profile, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  // «Abrir en Chat» de la ventana flotante llega como /Chat?c=<convId>.
  const [searchParams, setSearchParams] = useSearchParams();
  usePageTitle(t('chat.title'));

  // ── Redirect if not authenticated (wait for auth to finish loading) ──
  useEffect(() => {
    if (authLoading) return;
    if (!user) navigate('/Login?redirect=/Chat');
  }, [user, authLoading, navigate]);

  // ── State ──
  const [conversations, setConversations] = useState([]);
  const [convsLoading, setConvsLoading] = useState(true);
  // true cuando el primer fetch de la lista terminó (la caché de sesión pone
  // convsLoading=false antes, y abrir un chat pendiente antes del fetch haría
  // que loadConvs lo descartara).
  const [convsFetched, setConvsFetched] = useState(false);
  // Historial de llamadas de todas mis conversaciones (lista + hilo activo).
  const [callHistory, setCallHistory] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  // Refs to avoid `sending` and `replyingTo` in callback dependency arrays
  const sendingRef = useRef(false);
  // Keep sendingRef in sync
  useEffect(() => { sendingRef.current = sending; }, [sending]);
  // New conversation
  const [searchQuery, setSearchQuery] = useState('');
  // Vista del panel izquierdo: lista de chats o historial de llamadas.
  const [listView, setListView] = useState('chats'); // 'chats' | 'calls'
  const [showFollowersModal, setShowFollowersModal] = useState(false);
  const [followers, setFollowers] = useState([]);
  const [followersLoading, setFollowersLoading] = useState(false);

  // Mobile: show conversation list or messages
  const [showList, setShowList] = useState(true);

  // Mobile detection (same breakpoint as chat.css responsive rules)
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1024px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1024px)');
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // On mobile, lock the body scroll while a conversation is open
  // (the chat takes almost the whole viewport)
  useLockBodyScroll(isMobile && !showList);

  // On mobile, hide the bottom nav while a conversation is open
  // (the chat is full-viewport; body.fc-chat-open-mobile drives the CSS)
  useEffect(() => {
    if (isMobile && !showList) {
      document.body.classList.add('fc-chat-open-mobile');
    } else {
      document.body.classList.remove('fc-chat-open-mobile');
    }
    return () => document.body.classList.remove('fc-chat-open-mobile');
  }, [isMobile, showList]);

  // ── iOS: cancelar el auto-scroll del documento al abrir el teclado ──
  // Al enfocar el input, Safari scrollea el documento para "mostrarlo" usando
  // la altura vieja (sin teclado). Cuando luego --app-height se reduce, el
  // chat-page ya encaja en el viewport del teclado pero el documento quedó
  // scrolleado → el composer se eleva hasta el top. Como el chat se ajusta
  // solo con --app-height y el scroll real vive en .chat-messages, el
  // documento nunca debe scrollear: mientras el teclado esté abierto, se
  // devuelve el scroll del documento a 0 en cada cambio del visual viewport.
  useEffect(() => {
    if (!isMobile || showList) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const cancelIOSAutoScroll = () => {
      // Teclado abierto ⇔ visual viewport más bajo que el layout viewport
      const keyboardOpen = vv.height < window.innerHeight;
      if (keyboardOpen) {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }
    };

    vv.addEventListener('resize', cancelIOSAutoScroll);
    vv.addEventListener('scroll', cancelIOSAutoScroll);
    return () => {
      vv.removeEventListener('resize', cancelIOSAutoScroll);
      vv.removeEventListener('scroll', cancelIOSAutoScroll);
    };
  }, [isMobile, showList]);

  // Nicknames: map of target_user_id → nickname (cache-first)
  const [nicknames, setNicknames] = useState(() => {
    if (user?.id) {
      const cached = getCachedNicknames(user.id);
      if (cached) return cached;
    }
    return {};
  });
  // Nickname modal state
  const [nicknameModal, setNicknameModal] = useState({ open: false, targetUserId: null, currentName: '', userData: null });
  // Bubble colors: map conversation_id → { own, other } (cache-first)
  const [bubbleColors, setBubbleColors] = useState(() => {
    const cached = getCachedBubbleColors(user?.id);
    return cached || {};
  });
  // Bubble color modal state
  const [bubbleColorModal, setBubbleColorModal] = useState({ open: false, convId: null });
  // Fondo del chat: map conversation_id → url (solo del usuario actual, DB privada)
  const [chatBackgrounds, setChatBackgrounds] = useState({});
  // Chat background modal state
  const [chatBackgroundModal, setChatBackgroundModal] = useState({ open: false, convId: null });
  // ── Chat header dropdown (desktop): más opciones ──
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef(null);
  const [confirmBlock, setConfirmBlock] = useState(false);

  // Helper: get display name with nickname override
  const getDisplayName = useCallback((otherUser) => {
    if (!otherUser) return t('common.unknown');
    const nick = nicknames[otherUser.id];
    return nick || otherUser.displayname || otherUser.username || t('common.unknown');
  }, [nicknames]);

  // Context menu state (conversation list)
  const [contextMenu, setContextMenu] = useState({ open: false, x: 0, y: 0, convId: null });
  const contextMenuRef = useRef(null);

  // Message context menu state
  const [msgMenu, setMsgMenu] = useState({ open: false, x: 0, y: 0, msg: null });
  const msgMenuRef = useRef(null);

  // Edit message state
  const [editMsgId, setEditMsgId] = useState(null);
  const [editText, setEditText] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null); // mensaje al que se está respondiendo
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showSongPicker, setShowSongPicker] = useState(false);
  const [showMediaInput, setShowMediaInput] = useState(false);
  const [mediaUrl, setMediaUrl] = useState('');
  const [showInputEmojiPicker, setShowInputEmojiPicker] = useState(false);
  const [inputEmojiTab, setInputEmojiTab] = useState(0);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState('');
  const [uploadingChatMedia, setUploadingChatMedia] = useState(false);
  // Media/Pinned cargados DIRECTAMENTE de la BD al abrir la conversación (sin
  // esperar a que la lista de mensajes termine). Se guardan con el convId al
  // que pertenecen para no mostrar datos viejos al cambiar de chat.
  const [eagerPinned, setEagerPinned] = useState({ convId: null, items: [] });
  const [eagerMedia, setEagerMedia] = useState({ convId: null, urls: [] });
  // Fetch único por conversación: evita duplicarlo con StrictMode y permite
  // reintentar al abrir el panel si el primer intento falló.
  const eagerLoadRef = useRef({ convId: null, promise: null });
  // Mensaje al que hay que saltar cuando termine una carga puntual.
  const pendingJumpRef = useRef(null);
  const jumpingRef = useRef(false);
  const editRef = useRef(null);
  // Preserve content during modal close animation (ref survives state clears)
  const editContentRef = useRef('');
  // Preserve the editing message's image URL for the edit modal preview
  const editMediaUrlRef = useRef('');

  // Emoji picker state
  const [emojiPickerMsgId, setEmojiPickerMsgId] = useState(null);
  const [emojiPickerPos, setEmojiPickerPos] = useState({ x: 0, y: 0 });
  const [emojiTab, setEmojiTab] = useState(0);
  const [recentEmojis, setRecentEmojis] = useState([]);
  const emojiPickerRef = useRef(null);

  // Categorized emojis for reactions
  const MAX_RECENT = 30;

  const EMOJI_CATEGORIES = [
    {
      name: '😀', emojis: ['😀','😃','😄','😁','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🫢','🫣','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','😮','😯','😲','😳','🥺','😢','😭','😤','😠','😡','🤬','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾']
    },
    {
      name: '👋', emojis: ['👍','👎','👊','✊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✌️','🤟','🤘','👌','🤌','🤏','👉','👈','👆','👇','☝️','✋','🤚','🖐','🖖','👋','🤙','🫶','💪','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','👀','👁️','👅','👄','🦷','🦴','👶','🧒','👦','👧','🧑','👱','👨','👩','🧔','👴','👵','🙍','🙎','🙅','🙆','💁','🙋','🧏','🤦','🤷','👮','🕵️','💂','🥷','👷','🫅','🤴','👸','👳','👲','🧕','🤵','👰','🤰','🫃','🫄','🤱','👼','🎅','🤶','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞','🧟','🧌']
    },
    {
      name: '❤️', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','❤️‍🔥','❤️‍🩹','💔','❣️','💕','💞','💗','💖','💘','💝','💟','💌','💋','💑','💏','👩‍❤️‍👨','👨‍❤️‍👨','👩‍❤️‍👩','💒','❤️‍💋‍👨','❤️‍💋‍👩']
    },
    {
      name: '🐱', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🪸','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🪶','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔','🐾','🐉','🐲']
    },
    {
      name: '🔥', emojis: ['🔥','⭐','🌟','✨','💫','⚡','🌈','🌊','☀️','🌤️','⛅','🌥️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','💧','💦','🫧','☔','☂️','🌫️','🌪️','🌙','🌚','🌛','🌜','🌝','🌞','🪐','💥','☄️','🌍','🌎','🌏','🌑','🌒','🌓','🌔','🌕','🌖','🌗','🌘']
    },
    {
      name: '🌸', emojis: ['🌸','💐','💮','🪷','🌹','🥀','🌺','🌻','🌼','🌷','🪻','🌱','🪴','🌿','☘️','🍀','🍁','🍂','🍃','🪹','🪺','🍄','🌾','🌵','🎄','🌲','🌳','🌴','🪵']
    },
    {
      name: '🎉', emojis: ['🎉','🎊','🎈','🎁','🎀','🎃','🎄','🎆','🎇','🧨','✨','🎶','🎵','🎸','🎹','🎺','🎻','🥁','🪘','🎷','📯','🎙️','🎚️','🎛️','🎤','🎧','📻','🎯','🎱','🎲','🎮','🕹️','🎭','🎨','🎪','🎼','🪕','🎬','🎟️','🎫','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️']
    },
    {
      name: '🍕', emojis: ['🍇','🍈','🍉','🍊','🍋','🍌','🍍','🥭','🍎','🍏','🍐','🍑','🍒','🍓','🫐','🥝','🍅','🫒','🥥','🥑','🍆','🥔','🥕','🌽','🌶️','🫑','🥒','🥬','🥦','🧄','🧅','🍄','🥜','🫘','🌰','🍞','🥐','🥖','🫓','🥨','🥯','🥞','🧇','🧀','🍖','🍗','🥩','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🫔','🥙','🧆','🥚','🍳','🥘','🍲','🫕','🥣','🥗','🍿','🧈','🧂','🥫','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🥠','🥡','🦀','🦞','🦐','🦑','🦪','🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍼','🥛','☕','🫖','🍵','🍶','🍾','🍷','🍸','🍹','🍺','🍻','🥂','🥃','🫗','🥤','🧋','🧃','🧉','🧊']
    },
  ];

  // Compute categories with "Recent" tab prepended when there are recent emojis
  const categoriesWithRecent = React.useMemo(() => {
    const cats = [...EMOJI_CATEGORIES];
    if (recentEmojis.length > 0) {
      cats.unshift({ name: '🕐', emojis: recentEmojis });
    }
    return cats;
  }, [recentEmojis]);

  // Smart context menu positioning — flips if menu would overflow viewport
  const getSmartMenuPosition = useCallback((clientX, clientY, menuWidth = 180, menuHeight = 220) => {
    let x = clientX;
    let y = clientY;

    // Check right edge
    if (x + menuWidth > window.innerWidth) {
      x = clientX - menuWidth;
    }
    // Check bottom edge
    if (y + menuHeight > window.innerHeight) {
      y = clientY - menuHeight;
    }
    // Clamp to viewport
    x = Math.max(4, Math.min(x, window.innerWidth - menuWidth - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - menuHeight - 4));

    return { x, y };
  }, []);

  // Close context menus on click outside + on scroll (but ignore scrolls originating inside the menus)
  useEffect(() => {
    const handleClick = (e) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target)) {
        setContextMenu({ open: false, x: 0, y: 0, convId: null });
      }
      if (msgMenuRef.current && !msgMenuRef.current.contains(e.target)) {
        setMsgMenu({ open: false, x: 0, y: 0, msg: null });
      }
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target)) {
        setEmojiPickerMsgId(null);
      }
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target)) {
        setHeaderMenuOpen(false);
      }
    };

    // Scroll handler will close menus only when the scroll event does NOT originate
    // from inside any of the interactive menu elements (context menu, message menu, emoji picker).
    const handleScroll = (e) => {
      const target = e?.target;
      // If the scroll target is inside any menu, do nothing.
      if (target) {
        if (contextMenuRef.current && contextMenuRef.current.contains(target)) return;
        if (msgMenuRef.current && msgMenuRef.current.contains(target)) return;
        if (emojiPickerRef.current && emojiPickerRef.current.contains(target)) return;
      }
      // Otherwise, close all menus
      setContextMenu({ open: false, x: 0, y: 0, convId: null });
      setMsgMenu({ open: false, x: 0, y: 0, msg: null });
      setEmojiPickerMsgId(null);
      setShowMobileMenu(false);
      setHeaderMenuOpen(false);
    };

    document.addEventListener('click', handleClick);
    // Use capture so we receive scroll events from nested scrollable elements; handler filters internal scrolls.
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('scroll', handleScroll, { capture: true });
    };
  }, []);

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (showEditModal && editMsgId && editRef.current) {
      editRef.current.focus();
      const len = editRef.current.value.length;
      editRef.current.setSelectionRange(len, len);
    }
  }, [showEditModal, editMsgId]);

  // Refs
  const messagesContainerRef = useRef(null);
  const inputRef = useRef(null);
  const messagesCacheRef = useRef({});
  // Debounce del guardado a sessionStorage: cada mensaje realtime muta `messages`
  // y serializar TODO el caché en cada cambio bloquearía el hilo. El flush en
  // unmount/pagehide persiste al salir, así que el debounce es seguro.
  const cacheSaveTimerRef = useRef(null);
  const skipCacheWipeRef = useRef(false);  // prevents useLayoutEffect from wiping messages when resolving pending conv
  const skipMsgLoadRef = useRef(false);   // prevents useEffect from fetching messages when sendContent resolves pending conv
  const staleBackgroundFetchRef = useRef(false); // true cuando se muestran datos stale mientras se fetchea en bg
  const messagesRef = useRef(messages); // ref sincronizada para evitar race conditions con Realtime
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ══ DEBUG: track every messages state change ══
  useEffect(() => {
    console.log(`[CHAT MSGS] state changed: conv=${activeConvId} owner=${messagesOwnerRef.current} count=${messages.length} firstId=${messages[0]?.id ?? 'none'} lastId=${messages[messages.length - 1]?.id ?? 'none'}`);
  }, [messages]);
  // ── Overrides locales para preview de conversaciones (persisten a loadConvs) ──
  const localConvOverridesRef = useRef({});
  const overridesRestoredRef = useRef(false);
  if (!overridesRestoredRef.current && user?.id) {
    overridesRestoredRef.current = true;
    try {
      const saved = getSessionItem(`chatConvOverrides_${user.id}`);
      if (saved && typeof saved === 'object') localConvOverridesRef.current = saved;
    } catch {}
  }
  // ── Flush overrides a sessionStorage en unmount/pagehide ──
  useEffect(() => {
    const flush = () => {
      if (!user?.id) return;
      setSessionItem(`chatConvOverrides_${user.id}`, localConvOverridesRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => { flush(); window.removeEventListener('pagehide', flush); };
  }, [user?.id]);
  const draftsRef = useRef({}); // borradores del input por conversation ID
  const prevConvIdRef = useRef(null);
  const messagesOwnerRef = useRef(null); // tracks which conversation the current `messages` state belongs to
  const [otherUserTyping, setOtherUserTyping] = useState(false);
  // ── Shared post data cache (state to trigger re-render) ──
  const [sharedPosts, setSharedPosts] = useState({});
  // ── Shared community data cache ──
  const [sharedCommunities, setSharedCommunities] = useState({});

  // ── SessionStorage cache helpers (survives page reload, cleared on tab close) ──
  const getSessionCacheKey = () => `chatMessagesCache_${user?.id || 'anon'}`;
  const loadCacheFromSession = () => {
    try {
      const saved = getSessionItem(getSessionCacheKey());
      if (saved) return saved;
    } catch {}
    return {};
  };
  const saveCacheToSession = (cache) => {
    // Intento 1: guardar la conversación COMPLETA (todo lo cargado, incluyendo
    // los mensajes antiguos traídos con loadOlderMessages). El caché se limpia
    // en cada carga de página (ver restore abajo), así que no hay acumulación
    // de datos stale. Si la cuota de sessionStorage se supera, se degrada
    // guardando solo los mensajes más recientes en vez de tirar todo.
    if (setSessionItem(getSessionCacheKey(), cache)) return;

    // Intento 2 (fallback por cuota): recortar cada conversación a los N
    // mensajes más recientes y reintentar. Así el restore al volver al chat
    // al menos devuelve los últimos mensajes, no un caché vacío.
    try {
      const MAX_CACHED_PER_CONV = 150;
      const trimmed = { _meta: cache._meta };
      for (const [convId, msgs] of Object.entries(cache)) {
        if (convId === '_meta') continue;
        if (Array.isArray(msgs) && msgs.length > MAX_CACHED_PER_CONV) {
          trimmed[convId] = msgs.slice(msgs.length - MAX_CACHED_PER_CONV);
          // El meta de esa conversación ya no coincide con los mensajes
          // recortados: forzar hasMoreMessages=true y el cursor al mensaje
          // más antiguo del recorte para que la paginación siga bien.
          if (trimmed._meta?.[convId]) {
            trimmed._meta[convId] = {
              ...trimmed._meta[convId],
              hasMoreMessages: true,
              oldestMessageDate: trimmed[convId][0]?.created_at ?? null,
            };
          }
        } else {
          trimmed[convId] = msgs;
        }
      }
      // Si incluso el recorte no cabe (cuota mínima), limpiar para que el chat
      // se repueble con fetch fresco en la próxima visita (setSessionItem ya no
      // lanza — devuelve false, por eso se comprueba el retorno).
      const saved = setSessionItem(getSessionCacheKey(), trimmed);
      if (!saved) {
        try { removeSessionItem(getSessionCacheKey()); } catch {}
      }
    } catch {
      try { removeSessionItem(getSessionCacheKey()); } catch {}
    }
  };

  // ── Flag de sesión: limpia el caché en CADA carga de página, no en cada SPA ──
  // `performance.getEntriesByType('navigation')` retorna el tipo de carga ORIGINAL
  // de la página ('navigate' | 'reload'). Al navegar por SPA el componente se
  // monta de nuevo pero el tipo SIGUE siendo el original — sin el flag, el caché
  // se borraría en cada ruta. window.__fc_cacheClearedOnLoad persiste a través de
  // montajes/desmontajes: limpia 1 vez por carga de página, y los remounts SPA
  // restauran desde sessionStorage.

  // Restore cache from sessionStorage — only when user is available (not during auth loading)
  const sessionRestoredRef = useRef(false);
  if (!sessionRestoredRef.current && user?.id) {
    let navType = 'navigate';
    try {
      const navEntries = performance.getEntriesByType ? performance.getEntriesByType('navigation') : null;
      navType = navEntries?.[0]?.type || (performance.navigation && performance.navigation.type === 1 ? 'reload' : 'navigate');
    } catch (e) { /* ignore */ }

    // Cada carga COMPLETA de página (onload: navigate o reload) limpia el caché
    // de sesión → el chat arranca fresco y repuebla con fetch. Los remounts SPA
    // (flag ya seteado en esta carga) restauran desde sessionStorage.
    const isFullPageLoad = navType === 'navigate' || navType === 'reload';
    if (isFullPageLoad && !window.__fc_cacheClearedOnLoad) {
      window.__fc_cacheClearedOnLoad = true;
      try { removeSessionItem(getSessionCacheKey()); } catch (e) {}
      messagesCacheRef.current = {};
    } else {
      // SPA navigation → restaurar desde sessionStorage
      const restored = loadCacheFromSession();
      if (Object.keys(restored).length > 0) {
        messagesCacheRef.current = restored;
      }
    }

    sessionRestoredRef.current = true;
  }

  // ── Conversations sessionStorage cache ──
  const getConvsSessionCacheKey = () => `chatConvsCache_${user?.id || 'anon'}`;
  const loadConvsFromSession = () => {
    try {
      const saved = getSessionItem(getConvsSessionCacheKey());
      if (saved) return saved;
    } catch {}
    return [];
  };
  const saveConvsToSession = (convs) => {
    try {
      setSessionItem(getConvsSessionCacheKey(), convs);
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.code === 22) {
        try { removeSessionItem(getConvsSessionCacheKey()); } catch {}
      }
    }
  };

  // Restore conversations from sessionStorage on mount
  const convsSessionRestoredRef = useRef(false);
  // Restore from cache DURING RENDER phase (before first paint)
  // This prevents the skeleton flash on SPA navigation
  if (!convsSessionRestoredRef.current && user?.id) {
    convsSessionRestoredRef.current = true;
    const cached = loadConvsFromSession();
    if (cached.length > 0 && conversations.length === 0) {
      // React 18 allows setState during render — triggers re-render before commit
      setConversations(cached);
      setConvsLoading(false);
    }
  }

  // ── Pagination state (infinite scroll / load older messages) ──
  const PAGE_SIZE = 40;
  const INITIAL_BATCH_LIMIT = 40; // fetch first 40 messages on initial load, then lazy load more via scroll
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [oldestMessageDate, setOldestMessageDate] = useState(null);
  // Ref to preserve scroll position when prepending older messages
  const scrollBeforeLoadRef = useRef(null);
  // Cooldown to prevent cascading loads after scroll restoration
  const lastLoadTimeRef = useRef(0);
  // Sync ref: prevents multiple loadOlderMessages calls in same event loop tick
  // (setLoadingMore(true) is async - React batches until next render)
  const loadingMoreRef = useRef(false);
  // ── "New messages" floating button counter ──
  const [newMsgCount, setNewMsgCount] = useState(0);
  // ── Track if user has scrolled up (show scroll-to-bottom button) ──
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  // ── Acumula URLs de imágenes de TODOS los mensajes cargados (incluyendo paginación) ──
  const allChatMediaUrlsRef = useRef([]);
  const prevConvForMediaRef = useRef(null);
  // ── Blocked status: null=unknown, 'blocked_by_me', 'blocked_by_them' ──
  const [isBlockedConv, setIsBlockedConv] = useState(null);

  // ── Voice call state (LiveKit) — global en CallContext (ring en cualquier ruta) ──
  const { callSession, startCall } = useCall();
  const scrollToBottom = useCallback(() => {
    messagesContainerRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    setNewMsgCount(0);
    setIsScrolledUp(false);
  }, []);

  // ── useLayoutEffect: runs BEFORE browser paint — garantiza que no haya flash de mensajes viejos ──
  useLayoutEffect(() => {
    if (!activeConvId) return;
    if (prevConvIdRef.current === activeConvId) {
      return;
    }
    console.log(`[CHAT LAYOUT] activeConvId=${activeConvId} prev=${prevConvIdRef.current}`);

    // Save current messages to the OLD conversation's cache before switching
    if (prevConvIdRef.current && messagesOwnerRef.current === prevConvIdRef.current) {
      // Don't overwrite — the cache is already up-to-date from the sync effect
    }

    // Don't wipe messages when resolving a pending conversation to real ID
    if (skipCacheWipeRef.current) {
      skipCacheWipeRef.current = false;
      prevConvIdRef.current = activeConvId;
      messagesOwnerRef.current = activeConvId;
      return;
    }

    // Limpiar/restaurar mensajes inmediatamente ANTES del paint
    const cached = messagesCacheRef.current[activeConvId];
    const cachedMeta = messagesCacheRef.current._meta?.[activeConvId];

    const cacheLen = cached && Array.isArray(cached) ? cached.length : 0;
    const cacheMeta = cachedMeta?.hasMoreMessages;
    if (cached && Array.isArray(cached)) {
      // Check if cache is stale by comparing with conv.last_message_at
      const activeConv = conversations.find(c => c.id === activeConvId);
      const lastMsgAt = activeConv?.last_message_at;
      const fetchedAt = cachedMeta?.fetchedAt;
      const isStale = lastMsgAt && fetchedAt && new Date(lastMsgAt) > new Date(fetchedAt);
      if (isStale) {
        // Mostrar mensajes cacheados inmediatamente SIN skeleton
        console.log(`[CHAT LAYOUT] ${activeConvId}: STALE cache, showing ${cached.length} msgs, bg fetch`);
        setMessages(cached);
        setMsgsLoading(false); // false para NO mostrar el skeleton
        staleBackgroundFetchRef.current = true; // evita que sync effect guarde datos stale
        setHasMoreMessages(true);
        setOldestMessageDate(null);
        // skipMsgLoadRef se deja en false para que msgEffect haga el fetch
      } else {
        console.log(`[CHAT LAYOUT] ${activeConvId}: FRESH cache, ${cached.length} msgs, skipFetch`);
        setMessages(cached);
        setMsgsLoading(false);
        if (cached.length > 0 && cachedMeta?.hasMoreMessages === false) {
          setHasMoreMessages(true);
        } else {
          const newVal = cachedMeta?.hasMoreMessages ?? true;
          setHasMoreMessages(newVal);
        }
        const restoredDate = cachedMeta?.oldestMessageDate ?? (cached.length > 0 ? cached[0].created_at : null);
        setOldestMessageDate(restoredDate);
        skipMsgLoadRef.current = true;
      }
    } else {
      console.log(`[CHAT LAYOUT] ${activeConvId}: NO cache, clearing messages`);
      setMessages([]);
      setMsgsLoading(true);
      setHasMoreMessages(true);
      setOldestMessageDate(null);
    }
    messagesOwnerRef.current = activeConvId;
    prevConvIdRef.current = activeConvId;
  }, [activeConvId, conversations]);

  // ── Reset loadingMore when conversation changes (pagination state reset is handled in layout effect) ──
  useEffect(() => {
    setLoadingMore(false);
    loadingMoreRef.current = false; // sync ref must also reset to prevent stale blocking
  }, [activeConvId]);

  // ── Load conversations ──
  const loadConvs = useCallback(async () => {
    if (!user?.id) return;
    try {
      const convs = await getConversations(user.id);
      setConversations(convs);
      // Load nicknames (cache-first — DB fetch refreshes cache)
      getNicknames(user.id).then((map) => {
        setNicknames(map);
        cacheNicknames(user.id, map);
      }).catch(() => {});
      // Load bubble colors (cache-first — DB fetch refreshes cache)
      getBubbleColors(user.id).then((map) => {
        setBubbleColors(map);
        cacheBubbleColors(user.id, map);
      }).catch(() => {});
      // Limpiar overrides locales para conversaciones donde la DB tiene mensajes más nuevos
      for (const conv of convs) {
        const override = localConvOverridesRef.current[conv.id];
        if (override && conv.last_message_at) {
          // Comparar contra deletedMsgAt (timestamp del mensaje borrado), NO contra override.at
          // Para distinguir entre "no hay mensajes nuevos" vs "llegaron mensajes nuevos"
          if (new Date(conv.last_message_at) > new Date(override.deletedMsgAt || 0)) {
            delete localConvOverridesRef.current[conv.id];
          }
        }
      }
      // Persist to sessionStorage after successful fetch
      saveConvsToSession(convs);
    } catch (err) {
      console.warn('Error loading conversations:', err);
    } finally {
      setConvsLoading(false);
      setConvsFetched(true);
    }
  }, [user?.id]);

  useEffect(() => {
    // NotificationContext mantiene el caché de conversaciones actualizado
    // en sessionStorage incluso cuando Chat está desmontado.
    // El caché se restaura en render-phase para evitar el skeleton flash.
    // Pero SIEMPRE hacemos un fetch en background al montar para capturar
    // cualquier mensaje que haya llegado durante el throttle de 3s de
    // refreshConversationsCache.
    if (!user?.id) return;

    loadConvs();
  }, [loadConvs]);

  // Real-time subscription to conversation updates
  useEffect(() => {
    if (!user?.id) return;
    const unsub = subscribeToConversations(user.id, loadConvs);
    return () => unsub?.unsubscribe();
  }, [user?.id, loadConvs]);

  // ── Historial de llamadas de mis conversaciones ──
  // Una consulta por conjunto de conversaciones (la clave evita refetch en
  // cada render) y actualizaciones en vivo por Realtime.
  // Ordenada para que el orden de la lista (que cambia con cada mensaje) no
  // provoque refetch del historial de llamadas.
  const convIdsKey = React.useMemo(
    () => conversations.map((c) => c.id).sort().join(','),
    [conversations]
  );

  useEffect(() => {
    if (!user?.id || !convIdsKey) return undefined;
    const ids = convIdsKey.split(',');
    let cancelled = false;
    (async () => {
      try {
        const rows = await getCallsForConversations(ids);
        if (!cancelled) setCallHistory(rows);
      } catch (err) {
        // Sin historial si la consulta falla: el chat sigue funcionando igual.
        console.warn('Error loading call history:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, convIdsKey]);

  // Realtime: guarda o actualiza la fila cuando la llamada cambia de estado
  // (ringing → active → ended/missed/declined). Canal propio ('-history') para
  // no compartir topic con el CallContext global.
  useEffect(() => {
    if (!user?.id) return undefined;
    const channel = subscribeToCalls(user.id, (call, eventType) => {
      setCallHistory((prev) => {
        const rest = prev.filter((c) => c.id !== call.id);
        if (eventType === 'DELETE') return rest;
        return [call, ...rest].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      });
    }, '-history');
    return () => { channel?.unsubscribe?.(); };
  }, [user?.id]);

  // ── Nickname channel ref: evita recrear la suscripción en re-renders ──
  const nicknameChannelRef = useRef(null);

  // Real-time subscription to nickname changes (syncs across tabs)
  // El ref evita recrear el canal en re-renders. El cleanup en unmount
  // previene fugas al navegar entre rutas SPA.
  useEffect(() => {
    if (!user?.id) return;
    // Ya hay un canal activo para este usuario → no recrear
    if (nicknameChannelRef.current) return;

    nicknameChannelRef.current = supabase
      .channel(`nicknames-${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'chat_nicknames', filter: `user_id=eq.${user.id}` },
        async (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const { target_user_id, nickname } = payload.new;
            if (target_user_id && nickname) {
              setNicknames(prev => ({ ...prev, [target_user_id]: nickname }));
            }
          } else if (payload.eventType === 'DELETE') {
            const target_user_id = payload.old?.target_user_id;
            if (target_user_id) {
              setNicknames(prev => {
                const next = { ...prev };
                delete next[target_user_id];
                return next;
              });
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(nicknameChannelRef.current);
      nicknameChannelRef.current = null;
    };
  }, [user?.id]);

  // ── Bubble colors channel ref: evita recrear la suscripción en re-renders ──
  const bubbleColorsChannelRef = useRef(null);

  // Real-time subscription to bubble color changes (syncs across tabs)
  useEffect(() => {
    if (!user?.id) return;
    if (bubbleColorsChannelRef.current) return;

    bubbleColorsChannelRef.current = supabase
      .channel(`bubble-colors-${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'chat_bubble_settings', filter: `user_id=eq.${user.id}` },
        async (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const { conversation_id, own_color, other_color } = payload.new;
            if (conversation_id) {
              setBubbleColors(prev => ({ ...prev, [conversation_id]: { own: own_color || null, other: other_color || null } }));
            }
          } else if (payload.eventType === 'DELETE') {
            const conversation_id = payload.old?.conversation_id;
            if (conversation_id) {
              setBubbleColors(prev => {
                const next = { ...prev };
                delete next[conversation_id];
                return next;
              });
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(bubbleColorsChannelRef.current);
      bubbleColorsChannelRef.current = null;
    };
  }, [user?.id]);

  // Fondo de la conversación abierta ('' si no tiene): privado del usuario.
  const activeChatBackground = (activeConvId && chatBackgrounds[activeConvId]) || '';

  // ── Acento del fondo (color dominante) ──
  // Se extrae de la propia imagen con colorExtractor (cachea por URL en
  // localStorage) y tiñe cabecera + caja de entrada (ver chat.css
  // `.chat-messages--accent`). Si la imagen no se puede leer (CORS/red) NO se
  // pinta nada: se queda el estilo por defecto en vez de un gris que parecía
  // un fallo del acento.
  const [chatAccent, setChatAccent] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!activeChatBackground) {
      setChatAccent('');
      return () => { cancelled = true; };
    }
    extractColors(activeChatBackground)
      .then((colors) => {
        if (cancelled) return;
        const accent = Array.isArray(colors) ? String(colors[0] || '') : '';
        // '#ffffff' como color dominante NO es un acento real: el algoritmo
        // descarta los píxeles casi blancos, así que ese valor es la paleta de
        // RESPALDO que devuelve extractColors cuando no pudo leer la imagen
        // (CORS/red/timeout). Pintar con ella dejaba cabecera e input grises y
        // parecía que el acento no se había aplicado. Sin acento, no se pinta.
        const usable = /^#[0-9a-f]{6}$/i.test(accent) && accent.toLowerCase() !== '#ffffff';
        setChatAccent(usable ? accent : '');
      })
      .catch(() => {
        if (!cancelled) setChatAccent('');
      });
    return () => { cancelled = true; };
  }, [activeChatBackground]);

  // ── Fondos de chat del usuario (uno por conversación, privados) ──
  // Se cargan una vez por sesión: la tabla es pequeña (una fila por conversación
  // con fondo) y el RLS ya limita el resultado a las filas de auth.uid().
  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setChatBackgrounds({});
      return () => { cancelled = true; };
    }
    getChatBackgrounds(user.id).then((map) => {
      if (!cancelled) setChatBackgrounds(map || {});
    });
    return () => { cancelled = true; };
  }, [user?.id]);

  // ── Load messages when active conversation changes ──
  useEffect(() => {
    if (!activeConvId) return;
    console.log(`[CHAT EFFECT] RUN conv=${activeConvId} skipFetch=${skipMsgLoadRef.current} owner=${messagesOwnerRef.current}`);
    // Skip DB ops for pending conversations (temp IDs like "pending_xxx" are not real UUIDs)
    if (activeConvId.startsWith('pending_')) {
      setMsgsLoading(false);
      return;
    }

    // Determine whether to skip the DB fetch (fresh cache restored by layout effect)
    const skipFetch = skipMsgLoadRef.current;
    skipMsgLoadRef.current = false;
    let aborted = false;
    const convForThisEffect = activeConvId;

    markAsRead(activeConvId, user.id);

    // ══ DB fetch — skipped when layout effect restored from fresh cache ══
    if (!skipFetch) {
      (async () => {
        try {
          let attempts = 0;
          let raw = [];
          let filtered = [];
          let decrypted = [];
          let hasMore = false;
          let cursor = null;
          const fetchLimit = INITIAL_BATCH_LIMIT + 1; // request one extra to detect 'more'
          console.log(`[CHAT FETCH] START conv=${convForThisEffect}`);

          do {
            attempts += 1;
            raw = await getMessages(convForThisEffect, fetchLimit, cursor);
            if (aborted) return;
            hasMore = (raw.length > INITIAL_BATCH_LIMIT);
            // If we requested extra, drop the OLDEST message (index 0 in ascending order)
            // NOT the newest (which would be at the end of the array)
            if (raw.length > INITIAL_BATCH_LIMIT) raw = raw.slice(1);

            filtered = raw.filter(m => !m.deleted_for?.includes(user.id));
            // Decrypt visible messages
            decrypted = await Promise.all(
              filtered.map(async (msg) => {
                const content = await decryptMessage(msg, user.id);
                return { ...msg, decryptedContent: content };
              })
            );

            // If we got no visible messages (all were deleted), but there are more on the server,
            // advance the cursor to the last raw item's created_at and retry up to 3 attempts.
            if (decrypted.length === 0 && hasMore && attempts < 3) {
              cursor = raw.length ? raw[raw.length - 1].created_at : null;
              continue;
            }
            break;
          } while (attempts < 3);

          if (aborted) return;

          // ══ Stale refresh: MERGE con el caché existente en vez de reemplazar ══
          // Si el caché estaba marcado como stale (llegaron mensajes nuevos mientras
          // no se veía la conversación), el fetch de background trae solo el primer
          // batch (INITIAL_BATCH_LIMIT). Reemplazar el caché con ese batch tiraba
          // todos los mensajes antiguos ya cargados con loadOlderMessages → el caché
          // quedaba pegado en ~40 mensajes. Aquí fusionamos: viejos cacheados (que no
          // estén en el batch nuevo) + batch nuevo, deduplicando por id y ordenando.
          const prevCached = messagesCacheRef.current[convForThisEffect];
          const prevMeta = messagesCacheRef.current._meta?.[convForThisEffect];
          let finalMessages = decrypted;
          if (Array.isArray(prevCached) && prevCached.length > 0) {
            const fetchedIds = new Set(decrypted.map(m => m.id));
            const keptOlder = prevCached.filter(m => !fetchedIds.has(m.id));
            finalMessages = [...keptOlder, ...decrypted];
            // Orden ascendente defensivo (el realtime puede intercalar mensajes)
            finalMessages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
          }
          // ══ Guard: if the user switched conversations during the async fetch,
          // writing to state/cache would corrupt the new conversation's data.
          // Only cache the result; don't overwrite the live state.
          if (messagesOwnerRef.current !== convForThisEffect || aborted) {
            console.log(`[CHAT FETCH] GUARD HIT conv=${convForThisEffect} owner=${messagesOwnerRef.current} aborted=${aborted} → caching only`);
            messagesCacheRef.current[convForThisEffect] = finalMessages;
            if (!messagesCacheRef.current._meta) messagesCacheRef.current._meta = {};
            messagesCacheRef.current._meta[convForThisEffect] = {
              fetchedAt: new Date().toISOString(),
              hasMore: hasMore,
              oldestMessageDate: finalMessages.length > 0 ? finalMessages[0].created_at : null,
            };
            return;
          }
          console.log(`[CHAT FETCH] OK conv=${convForThisEffect} msgs=${finalMessages.length} → setMessages`);
          messagesCacheRef.current[convForThisEffect] = finalMessages;
          messagesOwnerRef.current = convForThisEffect;
          setMessages(finalMessages);
          if (finalMessages.length > 0) {
            setOldestMessageDate(finalMessages[0].created_at);
          }
          // Si ya teníamos TODO cargado (hasMore=false en caché), mantenerlo en vez
          // de usar el hasMore del primer batch, que siempre es true con >40 msgs.
          setHasMoreMessages(prevMeta?.hasMoreMessages ?? hasMore);
        } catch {
        } finally {
          staleBackgroundFetchRef.current = false;
          // Only clear loading if this conversation is still the active one
          if (!aborted && messagesOwnerRef.current === convForThisEffect) {
            setMsgsLoading(false);
          }
        }
      })();
    } else {
      staleBackgroundFetchRef.current = false;
      setMsgsLoading(false);
    }

    // ══ Realtime subscription — ALWAYS subscribed, even when cache was fresh ══
    const unsub = subscribeToMessages(
      convForThisEffect,
      async (newMsg, eventType) => {
        if (aborted) return;
        // Guard: messages state may already belong to a different conversation
        // (useLayoutEffect sets the new state before useEffect cleanup runs)
        if (messagesOwnerRef.current !== convForThisEffect) {
          console.log(`[CHAT RT] BLOCKED owner=${messagesOwnerRef.current} !== conv=${convForThisEffect} msg_id=${newMsg.id}`);
          return;
        }
        const content = await decryptMessage(newMsg, user.id);
        if (aborted) return;
        if (messagesOwnerRef.current !== convForThisEffect) return;
        if (newMsg.shared_post_id && !sharedPosts[newMsg.shared_post_id]) {
          try {
            const postData = await getPost(newMsg.shared_post_id);
            setSharedPosts(prev => ({ ...prev, [newMsg.shared_post_id]: postData }));
          } catch {}
        }
        if (newMsg.shared_community_id && !sharedCommunities[newMsg.shared_community_id]) {
          try {
            const { data } = await supabase.from('communities').select('*').eq('id', newMsg.shared_community_id).single();
            if (data) setSharedCommunities(prev => ({ ...prev, [newMsg.shared_community_id]: data }));
          } catch {}
        }
        if (eventType === 'UPDATE') {
          setMessages((prev) => prev.map((msg) => msg.id === newMsg.id ? { ...msg, ...newMsg, decryptedContent: content } : msg));
        } else {
          setMessages((prev) => {
            const exists = prev.some(m => m.id === newMsg.id);
            if (exists) {
              return prev.map(m => m.id === newMsg.id ? { ...m, ...newMsg, decryptedContent: content } : m);
            }
            return [...prev, { ...newMsg, decryptedContent: content }];
          });
          // Nuevo mensaje recibido → limpiar override local para que el preview real se muestre
          delete localConvOverridesRef.current[convForThisEffect];
          updateConvPreview(
            convForThisEffect,
            newMsg.shared_song
              ? '🎵 Shared a song'
              : detectMediaFromContent(content || '').videoUrl
              ? '🎬 Video'
              : (content || ''),
            newMsg.created_at,
            newMsg.sender_id !== user.id
          );
          // Only auto-scroll if user is near the bottom of the chat
          // En column-reverse, scrollTop ≈ 0 al fondo, negativo al tope
          const el = messagesContainerRef.current;
          const isNearBottom = el && el.scrollTop > -80;
          if (isNearBottom) {
            setTimeout(() => messagesContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 50);
            setNewMsgCount(0);
          } else {
            setNewMsgCount(prev => prev + 1);
          }
        }
        markAsRead(convForThisEffect, user.id);
      },
      // onDelete: called when a message is deleted by the other user
      (deletedId) => {
        if (aborted) return;
        if (messagesOwnerRef.current !== convForThisEffect) return;
        setMessages((prev) => {
          const filtered = prev.filter(m => m.id !== deletedId);
          // If deleted message was the last one, update the conversation preview
          const wasLast = prev.length > 0 && prev[prev.length - 1].id === deletedId;
          if (wasLast) {
            const newLast = filtered[filtered.length - 1];
            updateConvPreview(
              convForThisEffect,
              newLast?.decryptedContent || null,
              newLast?.created_at || null
            );
          }
          return filtered;
        });
        markAsRead(convForThisEffect, user.id);
      }
    );

    return () => {
      aborted = true;
      unsub?.unsubscribe();
    };
  }, [activeConvId, user?.id]);

  // ── Typing indicator: subscribe to other user's typing events ──
  useEffect(() => {
    if (!activeConvId || !user?.id) return;
    setOtherUserTyping(false);

    const unsub = subscribeToTyping(
      activeConvId,
      user.id,
      () => setOtherUserTyping(true),
      () => setOtherUserTyping(false)
    );

    return () => {
      unsub();
      setOtherUserTyping(false);
    };
  }, [activeConvId, user?.id]);

  // ── Load stored emojis on mount, persist on change ──
  useEffect(() => {
    const stored = getItem('chatRecentEmojis');
    if (Array.isArray(stored) && stored.length > 0) {
      setRecentEmojis(stored);
    }
  }, []);
  useEffect(() => {
    setItem('chatRecentEmojis', recentEmojis);
  }, [recentEmojis]);

  // ── Pre-fetch shared posts para los mensajes visibles ──
  // Corre SIEMPRE que `messages` cambie (fetch inicial, restore desde caché,
  // loadOlder, realtime) para que ningún shared post quede en loading.
  useEffect(() => {
    const sharedPostIds = [...new Set(
      messages.filter((m) => m.shared_post_id).map((m) => m.shared_post_id)
    )];
    if (sharedPostIds.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const pid of sharedPostIds) {
        if (cancelled) break;
        if (sharedPosts[pid]) continue;
        try {
          const postData = await getPost(pid);
          if (!cancelled && postData) {
            setSharedPosts((prev) => (prev[pid] ? prev : { ...prev, [pid]: postData }));
          }
        } catch { /* ignore */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // ── Pre-fetch shared communities for visible messages ──
  useEffect(() => {
    const sharedCommunityIds = [...new Set(
      messages.filter((m) => m.shared_community_id).map((m) => m.shared_community_id)
    )];
    if (sharedCommunityIds.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const cid of sharedCommunityIds) {
        if (cancelled) break;
        if (sharedCommunities[cid]) continue;
        try {
          const { data } = await supabase.from('communities').select('*').eq('id', cid).single();
          if (!cancelled && data) {
            setSharedCommunities((prev) => (prev[cid] ? prev : { ...prev, [cid]: data }));
          }
        } catch { /* ignore */ }
      }
    })();
    return () => { cancelled = true; };
  }, [messages]);

  // Sync messages cache on every update (realtime, delete, edit, etc.)
  // Only writes to cache if the messages actually belong to activeConvId
  // IMPORTANT: Skip saving while loading (msgsLoading) to avoid a race condition:
  //   When switching chats, the layout effect sets messages=[] before the DB fetch
  //   completes. Without this guard, the cache for the old conversation gets
  //   overwritten with [], destroying valid cached data.
  useEffect(() => {
    if (!activeConvId || messagesOwnerRef.current !== activeConvId) return;
    if (msgsLoading || staleBackgroundFetchRef.current) return;
    // ABSOLUTE GUARD: verify messages actually belong to this conversation.
    // Prevents a stale async fetch from writing wrong data to the active cache.
    if (messages.length > 0 && messages[0].conversation_id && messages[0].conversation_id !== activeConvId) {
      console.log(`[CHAT SYNC] BLOCKED conv_id mismatch: active=${activeConvId} msg_conv_id=${messages[0].conversation_id}`);
      return;
    }
    console.log(`[CHAT SYNC] WRITE activeConv=${activeConvId} msgs=${messages.length} owner=${messagesOwnerRef.current}`);
    messagesCacheRef.current[activeConvId] = messages;
    // Update fetchedAt + pagination state for staleness check on next conversation switch
    if (!messagesCacheRef.current._meta) messagesCacheRef.current._meta = {};
    messagesCacheRef.current._meta[activeConvId] = {
      fetchedAt: new Date().toISOString(),
      hasMoreMessages,
      oldestMessageDate,
    };
    // Persist to sessionStorage so cache survives page reload (debounced)
    if (cacheSaveTimerRef.current) clearTimeout(cacheSaveTimerRef.current);
    cacheSaveTimerRef.current = setTimeout(() => {
      cacheSaveTimerRef.current = null;
      saveCacheToSession(messagesCacheRef.current);
    }, 400);
  }, [messages, activeConvId, msgsLoading]);

  // ── Flush messages cache on pagehide & unmount (navegación entre rutas) ──
  // NOTE: This effect must NOT write to the in-memory cache. The cleanup
  // closure captures stale values from the previous render (e.g. old
  // messages with a new activeConvId during conversation switches), which
  // would corrupt the cache for the new conversation. The SYNC effect
  // (line 1024) already keeps messagesCacheRef up-to-date in real time;
  // this effect only needs to persist the current cache to sessionStorage.
  useEffect(() => {
    const flushCache = () => {
      // Cancelar el save pendiente: aquí se persiste de inmediato
      if (cacheSaveTimerRef.current) {
        clearTimeout(cacheSaveTimerRef.current);
        cacheSaveTimerRef.current = null;
      }
      saveCacheToSession(messagesCacheRef.current);
    };
    const handlePageHide = () => flushCache();
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      flushCache(); // flush on unmount (route change)
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [activeConvId, messages, hasMoreMessages, oldestMessageDate]);

  // Persist conversations to sessionStorage on every change
  useEffect(() => {
    if (!user?.id) return;
    if (!convsSessionRestoredRef.current) return; // don't save before initial restore
    saveConvsToSession(conversations);
  }, [conversations, user?.id]);

  // ── Broadcast typing when input changes (throttled inside broadcastTyping) ──
  useEffect(() => {
    if (!activeConvId || !user?.id || !inputValue) return;
    broadcastTyping(activeConvId, user.id);
  }, [inputValue, activeConvId, user?.id]);

  // ── Select conversation (con borradores por chat) ──
  const selectConversation = (convId) => {
    // Guardar borrador del chat actual antes de cambiar
    if (activeConvId) {
      draftsRef.current[activeConvId] = inputValue;
    }
    // Cargar borrador del nuevo chat
    const draft = draftsRef.current[convId] || '';
    setInputValue(draft);

    // ── Restaurar mensajes desde caché inmediatamente (síncrono) ──
    // Así, al cambiar de ruta y volver, los mensajes aparecen al instante
    // sin pasar por el estado de carga (spinner/skeleton).
    const cached = messagesCacheRef.current[convId];
    if (cached && Array.isArray(cached) && cached.length > 0) {
      const meta = messagesCacheRef.current._meta?.[convId];
      const conv = conversations.find(c => c.id === convId);
      const lastMsgAt = conv?.last_message_at;
      const fetchedAt = meta?.fetchedAt;
      const isStale = lastMsgAt && fetchedAt && new Date(lastMsgAt) > new Date(fetchedAt);
      if (!isStale) {
        setMessages(cached);
        setMsgsLoading(false);
        skipMsgLoadRef.current = true;
        if (meta) {
          setHasMoreMessages(meta.hasMoreMessages ?? true);
          setOldestMessageDate(meta.oldestMessageDate ?? null);
        }
      }
    }

    setActiveConvId(convId);
    setShowList(false);
    // Cerrar paneles flotantes al cambiar de chat
    setShowMsgSearch(false);
    setShowMediaGallery(false);
    setShowPinnedPanel(false);
    setShowProfileCard(false);
    // Resetear scroll al fondo (top: 0 en column-reverse = mensajes nuevos)
    setTimeout(() => {
      messagesContainerRef.current?.scrollTo({ top: 0, behavior: 'instant' });
      if (inputRef.current) {
        inputRef.current.focus();
        const len = inputRef.current.value.length;
        inputRef.current.setSelectionRange(len, len);
      }
    }, 100);
  };

  // ── Abrir la conversación pedida por URL (?c=<convId>) ──
  // Lo usa el botón «abrir en Chat» de la ventana flotante para aterrizar en
  // la misma conversación. Se espera a que la lista esté cargada y se limpia
  // el parámetro para que un refresh no la reabra.
  const openedFromUrlRef = useRef(false);
  const wantedConvId = searchParams.get('c');

  useEffect(() => {
    if (!wantedConvId || openedFromUrlRef.current) return;
    if (!conversations.some((c) => c.id === wantedConvId)) return;
    openedFromUrlRef.current = true;
    selectConversation(wantedConvId);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedConvId, conversations, setSearchParams]);

  const goBackToList = () => {
    // Guardar borrador antes de ir a la lista
    if (activeConvId) {
      draftsRef.current[activeConvId] = inputValue;
    }
    setActiveConvId(null);
    setShowList(true);
    // Cerrar paneles flotantes al volver a la lista
    setShowMsgSearch(false);
    setShowMediaGallery(false);
    setShowPinnedPanel(false);
    setShowProfileCard(false);
  };

  // ── Abrir un post compartido desde el chat, recordando la conversación ──
  // Se guarda la conversación activa en sessionStorage para que al volver
  // con el botón back del PostDetail, Chat se monte y restaure la misma
  // conversación + scroll en vez de caer en la lista.
  const openSharedPost = (postId) => {
    if (activeConvId) {
      try { setSessionItem('fc_chat_restore_conv', activeConvId); } catch {}
    }
    navigate(`/post/${postId}`);
  };

  // ── Restaurar conversación al volver de un post compartido (botón back) ──
  useEffect(() => {
    if (!user?.id || !showList) return;
    let savedConvId = null;
    try { savedConvId = getSessionItem('fc_chat_restore_conv') || null; } catch {}
    if (!savedConvId) return;
    try { removeSessionItem('fc_chat_restore_conv'); } catch {}

    // La conversación debe existir en el listado ya cargado (caché o fetch)
    const convExists = conversations.some((c) => c.id === savedConvId);
    if (!convExists) return;

    // Restaurar en el próximo tick para que el layout effect y el scroll
    // corran con los mensajes ya restaurados desde el caché.
    setTimeout(() => selectConversation(savedConvId), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showList, conversations, user?.id]);

  // ── Send message — solo enviar si no hay subida en curso ──
  const handleSend = async () => {
    if (uploadingChatMedia) {
      toast.info(t('chat.waiting_upload') || 'Espera a que la imagen termine de subirse');
      return;
    }
    const trimmed = inputValue.trim();
    const hasPreview = !!mediaPreviewUrl;
    if (!trimmed && !hasPreview) return;
    const content = hasPreview
      ? (trimmed ? `${trimmed}\n${mediaPreviewUrl}` : mediaPreviewUrl)
      : trimmed;
    // Clear preview IMMEDIATELY (optimistic) BEFORE the async sendContent
    if (hasPreview) setMediaPreviewUrl('');
    await sendContent(content, { clearInput: true });
  };

  // ── Editar un mensaje (desde menú contextual o atajo ↑) ──
  const startEditingMessage = useCallback((msg) => {
    if (!msg?.decryptedContent) return;
    editContentRef.current = msg.decryptedContent;
    const { imageUrl, videoUrl } = detectMediaFromContent(msg.decryptedContent);
    const mediaUrl = imageUrl || videoUrl || '';
    editMediaUrlRef.current = mediaUrl;
    // Strip media URL from text, so the user only edits the text portion
    let cleanText = msg.decryptedContent;
    if (mediaUrl) {
      cleanText = cleanText.replace(mediaUrl, '').replace(/\n{2,}/g, '\n').trim();
    }
    setEditMsgId(msg.id);
    setEditText(cleanText);
    setShowEditModal(true);
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    // Atajo: flecha ↑ con el input vacío → editar el último mensaje propio
    if (e.key === 'ArrowUp' && !inputValue) {
      const lastOwn = [...messages].reverse().find(
        (m) => m.sender_id === user?.id && m.decryptedContent
      );
      if (lastOwn) {
        e.preventDefault();
        startEditingMessage(lastOwn);
      }
    }
  };

  // ── Ref for pending conversations (created locally, not yet in DB) ──
  const pendingConvRef = useRef(null);

  // ── Filter conversations by username/displayname ──
  const handleSearchChange = useCallback((e) => {
    setSearchQuery(e.target.value);
  }, []);

  const startConversation = async (otherUser) => {
    if (!user?.id || !otherUser?.id) return;

    // ── Block check: both directions ──
    const cachedBlocked = getCachedBlockStatus(user.id, otherUser.id);
    if (cachedBlocked === true) {
      toast.error(t('chat.blocked_cannot_send'), { className: 'fc-toast' });
      return;
    }
    const cachedBlockedByThem = getCachedBlockStatus(otherUser.id, user.id);
    if (cachedBlockedByThem === true) {
      toast.error(t('chat.blocked_by_them'), { className: 'fc-toast' });
      return;
    }

    // Double-check with server (cache might be stale)
    try {
      const blockedByMe = await isBlocked(user.id, otherUser.id);
      if (blockedByMe) {
        cacheBlockStatus(user.id, otherUser.id, true);
        toast.error(t('chat.blocked_cannot_send'), { className: 'fc-toast' });
        return;
      }
      const blockedByThem = await isBlocked(otherUser.id, user.id);
      if (blockedByThem) {
        cacheBlockStatus(otherUser.id, user.id, true);
        toast.error(t('chat.blocked_by_them'), { className: 'fc-toast' });
        return;
      }
    } catch {}

    // ── Check if there's already an existing conversation (was hidden/deleted locally) ──
    // If so, unhide and select it directly so messages load immediately
    try {
      const { data: myConvs } = await supabase
        .from('chat_participants')
        .select('conversation_id')
        .eq('user_id', user.id);

      const myConvIds = (myConvs || []).map(p => p.conversation_id);

      if (myConvIds.length > 0) {
        const { data: match } = await supabase
          .from('chat_participants')
          .select('conversation_id')
          .in('conversation_id', myConvIds)
          .eq('user_id', otherUser.id)
          .maybeSingle();

        if (match) {
          // Existing conversation found — unhide and select it
          setHiddenConvIds((prev) => prev.filter(id => id !== match.conversation_id));
          setSearchQuery('');
          selectConversation(match.conversation_id);
          return;
        }
      }
    } catch { /* fall through to pending flow */ }

    // ── No existing conversation — use pending flow to avoid creating empty conv in DB ──
    const tempId = `pending_${crypto.randomUUID()}`;
    pendingConvRef.current = { otherUser, tempId };

    // Add local conversation entry so the UI shows it immediately
    setConversations(prev => [{
      id: tempId,
      otherUser,
      unreadCount: 0,
      last_message_text: null,
      last_message_at: null,
      _pending: true,
    }, ...prev.filter(c => c.id !== tempId)]);

    setSearchQuery('');
    selectConversation(tempId);
  };

  // ── Abrir el chat con un usuario pedido por URL (?u=<userId>) ──
  // Lo usa el botón «Mensaje» del perfil. Se espera a que la lista esté
  // cargada para que loadConvs no descarte la conversación pendiente.
  const openedFromUserUrlRef = useRef(false);
  const wantedChatUserId = searchParams.get('u');

  useEffect(() => {
    if (!wantedChatUserId || openedFromUserUrlRef.current) return;
    if (authLoading || !convsFetched || !user?.id) return;
    openedFromUserUrlRef.current = true;
    setSearchParams({}, { replace: true });
    if (wantedChatUserId === user.id) return;
    getUserProfile(wantedChatUserId)
      .then((target) => {
        if (target) startConversation(target);
      })
      .catch((err) => console.warn('Could not open chat from URL:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedChatUserId, convsFetched, authLoading, user?.id, setSearchParams]);

  // ── Context menu handlers (conversation list) ──
  const handleContextMenu = useCallback((e, convId) => {
    e.preventDefault();
    const pos = getSmartMenuPosition(e.clientX, e.clientY, 160, 170);
    setContextMenu({ open: true, x: pos.x, y: pos.y, convId });
  }, [getSmartMenuPosition]);

  const [hiddenConvIds, setHiddenConvIds] = useState(() => {
    try {
      const saved = getItem('hiddenConvIds');
      return Array.isArray(saved) ? saved : [];
    } catch { return []; }
  });

  // Filter out hidden + searched conversations from the list
  const visibleConversations = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return conversations.filter(c => !hiddenConvIds.includes(c.id));
    }
    return conversations.filter(c => {
      if (hiddenConvIds.includes(c.id)) return false;
      const name = (c.otherUser?.displayname || c.otherUser?.username || '').toLowerCase();
      const uname = (c.otherUser?.username || '').toLowerCase();
      const nick = (nicknames[c.otherUser?.id] || '').toLowerCase();
      return name.includes(q) || uname.includes(q) || nick.includes(q);
    });
  }, [conversations, hiddenConvIds, searchQuery, nicknames]);

  // Persist hidden IDs (saved by lazy initializer on mount, persisted on every change)
  useEffect(() => {
    setItem('hiddenConvIds', hiddenConvIds);
  }, [hiddenConvIds]);

  const handleDeleteConversation = useCallback(() => {
    const convId = contextMenu.convId;
    if (!convId) return;
    setContextMenu({ open: false, x: 0, y: 0, convId: null });
    // Solo local: ocultar la conversación, no tocar la DB
    setHiddenConvIds((prev) => [...prev, convId]);
    if (activeConvId === convId) {
      setActiveConvId(null);
    }
  }, [contextMenu.convId, activeConvId]);

  // ── Set nickname for a conversation partner ──
  const handleSetNickname = useCallback(() => {
    const convId = contextMenu.convId;
    const conv = conversations.find(c => c.id === convId);
    if (!conv?.otherUser?.id) return;
    const currentNick = nicknames[conv.otherUser.id] || '';
    setNicknameModal({ open: true, targetUserId: conv.otherUser.id, currentName: currentNick, userData: conv.otherUser });
    setContextMenu({ open: false, x: 0, y: 0, convId: null });
  }, [contextMenu.convId, conversations, nicknames]);

  // ── Open nickname modal for any user (followers card, profile card, etc.) ──
  const openNicknameModal = useCallback((targetUserId, userData) => {
    if (!targetUserId) return;
    const currentNick = nicknames[targetUserId] || '';
    setNicknameModal({ open: true, targetUserId, currentName: currentNick, userData: userData || null });
  }, [nicknames]);

  // ── Click en el avatar de una burbuja ──
  // Abre el perfil del usuario directamente; con tu propio avatar, el tuyo.
  const handleMessageAvatarClick = useCallback((targetUser) => {
    const isOwnAvatar = !targetUser?.id || targetUser.id === user?.id;
    const targetUsername = isOwnAvatar
      ? (profile?.username || user?.username)
      : targetUser?.username;
    if (targetUsername) navigate(`/profile/${targetUsername}`);
  }, [user?.id, user?.username, profile?.username, navigate]);

  // ── Block/unblock the chat partner (header dropdown) ──
  const handleBlockFromChat = useCallback(async (targetUser) => {
    if (!targetUser?.id || !user?.id) return;
    try {
      const blocked = await isBlocked(user.id, targetUser.id);
      if (blocked) {
        await unblockUser(user.id, targetUser.id);
        cacheBlockStatus(user.id, targetUser.id, false);
        toast.success(t('block.unblock') || 'Unblocked');
      } else {
        await blockUser(user.id, targetUser.id);
        try { await unfollowBothWays(user.id, targetUser.id); } catch (e) { console.warn('Could not unfollow on block:', e); }
        cacheBlockStatus(user.id, targetUser.id, true);
        toast.success(t('block.blocked_user', { user: targetUser.username || '' }));
      }
      goBackToList();
    } catch (err) {
      console.error('Error toggling block:', err);
      toast.error(err?.message || t('common.error') || 'Error');
    } finally {
      setConfirmBlock(false);
    }
  }, [user?.id, t]);

  // ── Open bubble colors modal for any conversation (header/dropdown) ──
  const openBubbleColorModal = useCallback((convId) => {
    if (!convId) return;
    setBubbleColorModal({ open: true, convId });
  }, []);

  // ── Open chat background modal (header/dropdown) ──
  const openChatBackgroundModal = useCallback((convId) => {
    if (!convId) return;
    setChatBackgroundModal({ open: true, convId });
  }, []);

  // ── Pin/unpin conversation ──
  const handlePinConversation = useCallback(async () => {
    const convId = contextMenu.convId;
    const conv = conversations.find(c => c.id === convId);
    if (!convId || !conv) return;
    setContextMenu({ open: false, x: 0, y: 0, convId: null });
    try {
      await togglePinConversation(convId, user.id, conv.is_pinned);
      // Update local state optimistically + refetch to get updated sort order
      setConversations(prev => prev.map(c =>
        c.id === convId
          ? { ...c, is_pinned: !c.is_pinned, pinned_at: !c.is_pinned ? new Date().toISOString() : null }
          : c
      ));
      loadConvs(); // re-sort from DB
    } catch (err) {
      // Revert optimistic update on error
      loadConvs();
      if (err.message?.includes('Maximum 3')) {
        toast.warning(t('chat.max_pinned') || 'Maximum 3 pinned conversations');
      } else {
        console.error('Error pinning conversation:', err);
      }
    }
  }, [contextMenu.convId, conversations, user?.id, loadConvs]);

  // ── Message context menu handlers ──
  const handleMsgContextMenu = useCallback((e, msg) => {
    e.preventDefault();
    e.stopPropagation();

    const menuWidth = 180;
    const menuHeight = 260;

    // Posicionar relativo a la burbuja del mensaje, no al cursor
    const bubbleEl = e.currentTarget.querySelector('.chat-message-bubble');
    const rect = bubbleEl ? bubbleEl.getBoundingClientRect() : e.currentTarget.getBoundingClientRect();
    const isOwn = msg.sender_id === user?.id;

    let x, y;
    const gap = 6; // separación visual de la burbuja
    if (isOwn) {
      // Mensaje propio (derecha) → menú a la IZQUIERDA de la burbuja
      x = rect.left - menuWidth - gap;
    } else {
      // Mensaje ajeno (izquierda) → menú a la DERECHA de la burbuja
      x = rect.right + gap;
    }
    // Vertical: alinear con el top de la burbuja
    y = rect.top;

    // Ajustar si se sale del viewport
    if (x < 4) x = 4;
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 4;
    if (y < 4) y = 4;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 4;

    setMsgMenu({ open: true, x, y, msg });
  }, [user?.id]);

  const handleCopyMessage = useCallback(async () => {
    const msg = msgMenu.msg;
    setMsgMenu({ open: false, x: 0, y: 0, msg: null });
    if (!msg?.decryptedContent) return;
    try {
      await navigator.clipboard.writeText(msg.decryptedContent);
      toast.success(t('chat.copied'), { className: 'fc-toast' });
    } catch (err) {
      console.warn('Copy failed:', err);
    }
  }, [msgMenu.msg]);

  const handlePinMessage = useCallback(async () => {
    const msg = msgMenu.msg;
    setMsgMenu({ open: false, x: 0, y: 0, msg: null });
    if (!msg) return;
    const newPinned = !msg.is_pinned;
    try {
      await pinMessage(msg.id, newPinned);
      setMessages((prev) => prev.map(m => m.id === msg.id ? { ...m, is_pinned: newPinned } : m));
      // Mantener el panel de fijados (datos eager) en sincronía al instante.
      setEagerPinned((prev) => {
        if (prev.convId !== activeConvId) return prev;
        const exists = prev.items.some(m => m.id === msg.id);
        if (newPinned) {
          return exists ? prev : { convId: prev.convId, items: [{ ...msg, is_pinned: true }, ...prev.items] };
        }
        return { convId: prev.convId, items: prev.items.filter(m => m.id !== msg.id) };
      });
    } catch (err) {
      console.error('Error pinning message:', err);
    }
  }, [msgMenu.msg, activeConvId]);

  const handleStartEdit = useCallback(() => {
    const msg = msgMenu.msg;
    setMsgMenu({ open: false, x: 0, y: 0, msg: null });
    startEditingMessage(msg);
  }, [msgMenu.msg, startEditingMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditMsgId(null);
    setEditText('');
    setShowEditModal(false);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editMsgId || (!editText.trim() && !editMediaUrlRef.current) || !user?.id) return;
    try {
      // Reconstruct full content: text + image URL
      const textPart = editText.trim();
      const imagePart = editMediaUrlRef.current || '';
      const fullContent = imagePart ? (textPart ? `${textPart}\n${imagePart}` : imagePart) : textPart;

      // Get participant IDs
      const { data: participants } = await supabase
        .from('chat_participants')
        .select('user_id')
        .eq('conversation_id', activeConvId);
      const participantIds = (participants || []).map(p => p.user_id).filter(id => id !== user.id);

      await editMessage(editMsgId, user.id, fullContent, participantIds);
      // Update local state with edited content
      setMessages((prev) => prev.map(m =>
        m.id === editMsgId
          ? { ...m, decryptedContent: fullContent, edited_at: new Date().toISOString() }
          : m
      ));
      setEditMsgId(null);
      setEditText('');
      setShowEditModal(false);
    } catch (err) {
      console.error('Error editing message:', err);
    }
  }, [editMsgId, editText, user?.id, activeConvId]);

  const handleEditKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    }
    if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  const handleReact = useCallback(async (emoji, msgIdOverride) => {
    const msgId = msgIdOverride || emojiPickerMsgId || msgMenu.msg?.id;
    if (!msgId || !user?.id) return;
    setEmojiPickerMsgId(null);
    setMsgMenu({ open: false, x: 0, y: 0, msg: null });

    // Track emoji as recently used (move to front, no duplicates, max limit)
    setRecentEmojis((prev) => {
      const next = prev.filter(e => e !== emoji);
      next.unshift(emoji);
      return next.slice(0, MAX_RECENT);
    });

    // Optimistic update: apply to local state immediately, no waiting for API
    const prevMessages = messages;
    const toggleReaction = (prev) => prev.map(m => {
      if (m.id !== msgId) return m;
      const reactions = { ...(m.reactions || {}) };
      if (reactions[user.id] === emoji) {
        delete reactions[user.id];
      } else {
        reactions[user.id] = emoji;
      }
      return { ...m, reactions };
    });
    setMessages(toggleReaction);

    try {
      await addReaction(msgId, user.id, emoji);
    } catch (err) {
      // Revert on error
      setMessages(prevMessages);
      console.error('Error reacting:', err);
    }
  }, [emojiPickerMsgId, msgMenu.msg, user?.id, messages]);

  // ── External link warning state ──
  const [confirmExternalLink, setConfirmExternalLink] = useState(null);

  // ── External link warning handlers ──
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

  const handleCancelExternalLink = useCallback(() => {
    setConfirmExternalLink(null);
  }, []);

  // ── Reply to message ──
  const handleStartReply = useCallback((msg) => {
    setReplyingTo(msg);
    setMsgMenu({ open: false, x: 0, y: 0, msg: null });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const cancelReply = useCallback(() => {
    setReplyingTo(null);
  }, []);

  // ── Swipe a la derecha sobre un mensaje → responder (móvil) ──
  const swipeStartRef = useRef(null);

  const handleMsgTouchStart = useCallback((e) => {
    const t = e.touches[0];
    if (!t) return;
    swipeStartRef.current = { x: t.clientX, y: t.clientY };
  }, []);

  const handleMsgTouchCancel = useCallback(() => {
    swipeStartRef.current = null;
  }, []);

  const handleMsgTouchEnd = useCallback((e, msg) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start || !msg) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Swipe horizontal hacia la derecha con dominancia clara sobre el vertical
    if (dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      e.preventDefault();
      handleStartReply(msg);
    }
  }, [handleStartReply]);

  // ── Add media URL as preview above input (not pasted into textarea) ──
  const handleMediaSend = useCallback(() => {
    const url = mediaUrl.trim();
    if (!url) return;
    // El CDN no procesa video: solo se aceptan URLs de imagen o de video
    // directo/YouTube/Vimeo.
    if (!IMG_RE.test(url) && !isAttachableVideoUrl(url)) {
      toast.error(t('chat.invalid_media_url'));
      return;
    }
    setMediaPreviewUrl(url);
    setShowMediaInput(false);
    setMediaUrl('');
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [mediaUrl, t]);

  // ── Subir imagen a CDN para el chat (compartido: input file + pegado Ctrl+V) ──
  const uploadChatImageFile = useCallback(async (file) => {
    if (!file || !user?.id) return;

    if (!file.type.startsWith('image/')) {
      toast.error(t('modal.invalid_image_type') || 'Invalid image type');
      return;
    }

    setUploadingChatMedia(true);
    setMediaPreviewUrl('');
    setShowMediaInput(false);
    const toastId = toast.loading(t('upload.uploading') || 'Subiendo imagen...');

    try {
      const result = await uploadImage(file, user.id, 'chat');
      const realUrl = result.url || '';
      if (!realUrl) throw new Error('Upload returned empty URL');

      setMediaPreviewUrl(realUrl);
      setTimeout(() => inputRef.current?.focus(), 50);

      toast.update(toastId, {
        render: t('upload.uploaded') || 'Imagen subida',
        type: 'success',
        isLoading: false,
        autoClose: 2000,
      });
    } catch (err) {
      console.error('CDN upload error:', err);
      setMediaPreviewUrl('');
      toast.update(toastId, {
        render: err.message || 'Upload failed',
        type: 'error',
        isLoading: false,
        autoClose: 3000,
      });
    } finally {
      setUploadingChatMedia(false);
    }
  }, [user?.id, t]);

  // ── Pegar imagen (Ctrl+V) en el input → sube directo y muestra preview ──
  const handleChatPaste = useCallback((e) => {
    if (uploadingChatMedia) return; // evita uploads concurrentes (mismo guard que el input file)
    const file = getClipboardImageFile(e.clipboardData);
    if (!file) return; // texto pegado normal → no se toca
    e.preventDefault();
    uploadChatImageFile(file);
  }, [uploadChatImageFile, uploadingChatMedia]);

  // ── Insert emoji at cursor position in the input ──
  const handleInputEmojiSelect = useCallback((emoji) => {
    const el = inputRef.current;
    if (!el) {
      setInputValue((prev) => prev + emoji);
    } else {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);
      const newVal = before + emoji + after;
      setInputValue(newVal);
      // Restore cursor position after the inserted emoji
      requestAnimationFrame(() => {
        const pos = start + emoji.length;
        el.setSelectionRange(pos, pos);
        el.focus();
      });
    }
    // Track as recent
    setRecentEmojis((prev) => {
      const next = prev.filter(e => e !== emoji);
      next.unshift(emoji);
      return next.slice(0, MAX_RECENT);
    });
  }, []);

  // ── Panel states for header actions ──
  const [showMsgSearch, setShowMsgSearch] = useState(false);
  const [msgSearchQuery, setMsgSearchQuery] = useState('');
  const [showMediaGallery, setShowMediaGallery] = useState(false);
  const [showPinnedPanel, setShowPinnedPanel] = useState(false);
  const [showProfileCard, setShowProfileCard] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [mobileMenuTop, setMobileMenuTop] = useState(0);

  // ── Gallery state for chat images ──
  const [chatGalleryUrls, setChatGalleryUrls] = useState(null);
  const [chatGalleryIndex, setChatGalleryIndex] = useState(0);

  const openChatGallery = useCallback((e, urls, index) => {
    if (e) e.stopPropagation();
    setChatGalleryUrls(urls);
    setChatGalleryIndex(index);
  }, []);

  const closeChatGallery = useCallback(() => setChatGalleryUrls(null), []);

  const goChatGalleryPrev = useCallback(() => {
    setChatGalleryIndex((prev) => (prev > 0 ? prev - 1 : chatGalleryUrls.length - 1));
  }, [chatGalleryUrls]);

  const goChatGalleryNext = useCallback(() => {
    setChatGalleryIndex((prev) => (prev < chatGalleryUrls.length - 1 ? prev + 1 : 0));
  }, [chatGalleryUrls]);

  // ── Close floating panels (media, pinned, profile) on outside click ──
  useEffect(() => {
    if (!showMediaGallery && !showPinnedPanel && !showProfileCard) return;
    const handleClick = (e) => {
      if (!e.target.closest('.chat-float-panel') && !e.target.closest('.chat-header-action-btn')) {
        setShowMediaGallery(false);
        setShowPinnedPanel(false);
        setShowProfileCard(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMediaGallery, showPinnedPanel, showProfileCard]);

  // ── Keyboard nav for gallery ──
  useEffect(() => {
    if (!chatGalleryUrls) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') { closeChatGallery(); return; }
      if (e.key === 'ArrowLeft') goChatGalleryPrev();
      if (e.key === 'ArrowRight') goChatGalleryNext();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [chatGalleryUrls, chatGalleryIndex, closeChatGallery, goChatGalleryPrev, goChatGalleryNext]);

  const highlightTimeoutRef = useRef(null);
  // ── Scroll + highlight de un mensaje ya montado ──
  const scrollToMessageEl = useCallback((el) => {
    if (!el) return;
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
      document.querySelectorAll('.chat-message--highlighted')
        .forEach(node => node.classList.remove('chat-message--highlighted'));
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('chat-message--highlighted');
    highlightTimeoutRef.current = setTimeout(() => el.classList.remove('chat-message--highlighted'), 2000);
  }, []);

  // ── Navigate to a message by ID (scroll + highlight) ──
  // Si el mensaje fijado NO está en la página actual (los fijados pueden ser
  // muy antiguos), carga páginas hacia atrás hasta encontrarlo y luego salta.
  const handleGoToMessage = useCallback(async (msgId) => {
    if (!msgId || !messagesContainerRef.current) return;

    const existing = document.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
    if (existing) {
      scrollToMessageEl(existing);
      return;
    }

    if (!activeConvId || !user?.id || jumpingRef.current) return;
    jumpingRef.current = true;
    const convIdAtStart = activeConvId;
    const userId = user.id;

    try {
      let cursor = messages.length ? messages[0].created_at : null;
      let collected = [];
      let found = false;
      let moreAvailable = false;

      for (let page = 0; page < 25; page += 1) {
        const raw = await getMessages(convIdAtStart, PAGE_SIZE + 1, cursor);
        if (convIdAtStart !== activeConvId) return;
        if (raw.length === 0) { moreAvailable = false; break; }
        collected = raw.concat(collected);
        if (raw.some(m => m.id === msgId)) {
          found = true;
          moreAvailable = raw.length > PAGE_SIZE || page > 0;
          break;
        }
        moreAvailable = raw.length > PAGE_SIZE;
        if (!moreAvailable) break;
        cursor = raw[0].created_at;
      }

      if (!found) return;

      const filtered = collected.filter(m => !m.deleted_for?.includes(userId));
      const decrypted = await Promise.all(
        filtered.map(async (msg) => ({
          ...msg,
          decryptedContent: await decryptMessage(msg, userId),
        }))
      );
      if (convIdAtStart !== activeConvId) return;
      // Si el mensaje estaba eliminado para mí no hay nada a lo que saltar.
      if (!decrypted.some(m => m.id === msgId)) return;

      setMessages(prev => {
        const seen = new Set(prev.map(m => m.id));
        const older = decrypted.filter(m => !seen.has(m.id));
        if (older.length === 0) return prev;
        return [...older, ...prev].sort(
          (a, b) => new Date(a.created_at) - new Date(b.created_at)
        );
      });
      if (decrypted.length) setOldestMessageDate(decrypted[0].created_at);
      setHasMoreMessages(moreAvailable);
      pendingJumpRef.current = msgId;
    } catch (err) {
      console.warn('[Chat] Error jumping to message:', err?.message || err);
    } finally {
      jumpingRef.current = false;
    }
  }, [activeConvId, user?.id, messages, scrollToMessageEl]);

  // El mensaje objetivo puede no existir todavía en el DOM cuando termina la
  // carga: este efecto espera al render con los mensajes nuevos y entonces salta.
  useEffect(() => {
    const id = pendingJumpRef.current;
    if (!id) return;
    const el = document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!el) return;
    pendingJumpRef.current = null;
    requestAnimationFrame(() => scrollToMessageEl(el));
  }, [messages, scrollToMessageEl]);

  const toggleEmojiPicker = useCallback((msgId) => {
    if (!msgId) return;
    setEmojiPickerMsgId(prev => {
      if (prev === msgId) return null; // close

      // Calcular posición relativa a la burbuja del mensaje
      const PICKER_W = 300, PICKER_H = 280;
      const msgEl = document.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
      if (msgEl) {
        const bubbleEl = msgEl.querySelector('.chat-message-bubble');
        const rect = bubbleEl ? bubbleEl.getBoundingClientRect() : msgEl.getBoundingClientRect();
        const targetMsg = messages.find(m => m.id === msgId);
        const isOwn = targetMsg?.sender_id === user?.id;
        const gap = 6;

        let x, y;
        if (isOwn) {
          x = rect.left - PICKER_W - gap;
        } else {
          x = rect.right + gap;
        }
        y = rect.top;

        // Clamp to viewport
        if (x < 4) x = 4;
        if (x + PICKER_W > window.innerWidth) x = window.innerWidth - PICKER_W - 4;
        if (y < 4) y = 4;
        if (y + PICKER_H > window.innerHeight) y = window.innerHeight - PICKER_H - 4;

        setEmojiPickerPos({ x, y });
      }

      setEmojiTab(0);
      return msgId;
    });
    setMsgMenu({ open: false, x: 0, y: 0, msg: null });
  }, [messages, user?.id]);

  // ── Get active conversation's other user ──
  const activeConv = conversations.find((c) => c.id === activeConvId);
  const otherUser = activeConv?.otherUser;

  // ══ Voice call (LiveKit) — la lógica vive en CallContext (global) ══
  const handleStartCall = useCallback(async () => {
    if (!user?.id || !activeConvId || !otherUser?.id) return;
    if (isBlockedConv) {
      toast.error(t('chat.blocked_cannot_send') || 'No puedes llamar a este usuario');
      return;
    }
    try {
      await startCall(activeConvId, otherUser.id);
    } catch (err) {
      console.warn('Error starting call:', err);
      toast.error(t('chat.call_error') || 'No se pudo iniciar la llamada');
    }
  }, [user?.id, activeConvId, otherUser?.id, isBlockedConv, startCall, t]);

  // ── Subscribe to other users' realtime status for the visible conversation list ──
  const visibleConversationUserIds = React.useMemo(() => {
    return (visibleConversations || [])
      .map((conv) => conv.otherUser?.id)
      .filter(Boolean);
  }, [visibleConversations]);

  const otherUserStatuses = useContext(UserStatusContext);
  // ── Registrar participantes en el observador global (persiste entre rutas) ──
  useRegisterMultipleUserStatus(visibleConversationUserIds);
  const activeConversationStatus = otherUser?.id
    ? (otherUserStatuses?.[otherUser.id] ?? computeEffectiveStatus(otherUser))
    : null;

  // ── Blocked status detection (check cache + server) ──
  // Reset when changing conversations
  useEffect(() => {
    setIsBlockedConv(null);
    if (!activeConvId || !user?.id || !otherUser?.id) return;

    const checkBlock = async () => {
      // Cache check first (instant)
      const cachedByMe = getCachedBlockStatus(user.id, otherUser.id);
      const cachedByThem = getCachedBlockStatus(otherUser.id, user.id);
      if (cachedByMe === true) { setIsBlockedConv('blocked_by_me'); return; }
      if (cachedByThem === true) { setIsBlockedConv('blocked_by_them'); return; }

      // Server check in background (the input works normally until verified)
      try {
        const [byMe, byThem] = await Promise.all([
          isBlocked(user.id, otherUser.id),
          isBlocked(otherUser.id, user.id),
        ]);
        if (byMe) { cacheBlockStatus(user.id, otherUser.id, true); setIsBlockedConv('blocked_by_me'); return; }
        if (byThem) { cacheBlockStatus(otherUser.id, user.id, true); setIsBlockedConv('blocked_by_them'); return; }
        setIsBlockedConv(false);
      } catch { setIsBlockedConv(false); }
    };
    checkBlock();
  }, [activeConvId, otherUser?.id, user?.id]);

  // ── Update conversation list preview immediately (optimistic local update) ──
  const updateConvPreview = useCallback((convId, lastMsgText, lastMsgAt, incrementUnread = false) => {
    setConversations(prev => {
      const obfuscated = lastMsgText
        ? (lastMsgText.length > 80 ? lastMsgText.slice(0, 80) + '...' : lastMsgText)
        : lastMsgText;
      return prev
        .map(c => {
          if (c.id !== convId) return c;
          return {
            ...c,
            last_message_text: obfuscated,
            last_message_at: lastMsgAt,
            unreadCount: incrementUnread ? (c.unreadCount || 0) + 1 : c.unreadCount,
          };
        })
        // Move updated conversation to the top (most recent)
        .sort((a, b) => {
          if (a.id === convId) return -1;
          if (b.id === convId) return 1;
          return 0;
        });
    });
  }, []);

  // ── Delete message handlers (defined after updateConvPreview to avoid TDZ) ──
  const handleDeleteMessage = useCallback(async () => {
    const msg = msgMenu.msg;
    const convId = activeConvId;
    setMsgMenu({ open: false, x: 0, y: 0, msg: null });
    if (!msg || !convId) return;
    try {
      // Leer desde messagesRef antes de deleteMessage para evitar race con Realtime
      const currentMsgs = messagesRef.current;
      const wasLast = msg.id === currentMsgs[currentMsgs.length - 1]?.id;
      let newPreviewText = null;
      let newLastAt = null;
      if (wasLast) {
        const filtered = currentMsgs.filter(m => m.id !== msg.id);
        const newLast = filtered[filtered.length - 1];
        newPreviewText = newLast?.content || newLast?.decryptedContent || null;
        newLastAt = newLast?.created_at || null;
      }
      await deleteMessage(msg.id);
      setMessages((prev) => prev.filter(m => m.id !== msg.id));
      if (wasLast) {
        updateConvPreview(convId, newPreviewText, newLastAt);
        if (newPreviewText !== null) {
          const obfuscated = newPreviewText.length > 80 ? newPreviewText.slice(0, 80) + '...' : newPreviewText;
          await supabase
            .from('conversations')
            .update({
              last_message_text: obfuscated,
              last_message_at: newLastAt,
              updated_at: new Date().toISOString(),
            })
            .eq('id', convId);
        }
      }
    } catch (err) {
      console.error('Error deleting message:', err);
    }
  }, [msgMenu.msg, activeConvId, updateConvPreview]);

  const handleDeleteMessageForMe = useCallback(async () => {
    const msg = msgMenu.msg;
    const convId = activeConvId;
    setMsgMenu({ open: false, x: 0, y: 0, msg: null });
    if (!msg || !user?.id || !convId) return;
    try {
      // Leer desde messagesRef antes de deleteMessageForMe para evitar race con Realtime
      const currentMsgs = messagesRef.current;
      const wasLast = msg.id === currentMsgs[currentMsgs.length - 1]?.id;
      let newPreviewText = null;
      let newLastAt = null;
      if (wasLast) {
        const filtered = currentMsgs.filter(m => m.id !== msg.id);
        const newLast = filtered[filtered.length - 1];
        newPreviewText = newLast?.content || newLast?.decryptedContent || null;
        newLastAt = newLast?.created_at || null;
      }
      await deleteMessageForMe(msg.id, user.id);
      setMessages((prev) => prev.filter(m => m.id !== msg.id));
      // Solo actualizar estado LOCAL (la DB NO debe cambiar porque el otro usuario aun ve el mensaje)
      if (wasLast) {
        updateConvPreview(convId, newPreviewText, newLastAt);
        // Guardar override local para que persista a loadConvs()
        if (newPreviewText !== null) {
          localConvOverridesRef.current[convId] = { text: newPreviewText, at: newLastAt, deletedMsgAt: msg.created_at };
        } else {
          delete localConvOverridesRef.current[convId];
        }
      }
    } catch (err) {
      console.error('Error hiding message:', err);
    }
  }, [msgMenu.msg, activeConvId, updateConvPreview, user?.id]);

  // ── Shared send logic (optimistic + API + dedup) ──
  const sendContent = useCallback(async (content, { clearInput = false, sharedSong = null } = {}) => {
    if ((!content && !sharedSong) || !user?.id || sendingRef.current) return null;

    // ── Resolve conversation ID (create pending conversation in DB if needed) ──
    let convId = activeConvId;
    const pendingInfo = pendingConvRef.current;
    if (pendingInfo && activeConvId === pendingInfo.tempId) {
      const pendingOther = pendingInfo.otherUser;
      // Block check for pending conversation
      const cachedBlocked = getCachedBlockStatus(user.id, pendingOther.id);
      if (cachedBlocked === true) {
        toast.error(t('chat.blocked_cannot_send'), { className: 'fc-toast' });
        return null;
      }
      const cachedBlockedByThem = getCachedBlockStatus(pendingOther.id, user.id);
      if (cachedBlockedByThem === true) {
        toast.error(t('chat.blocked_by_them'), { className: 'fc-toast' });
        return null;
      }
      try {
        convId = await getOrCreateConversation(user.id, pendingOther.id);
      } catch (err) {
        console.error('Error creating conversation:', err);
        toast.error(t('chat.send_error'), { className: 'fc-toast' });
        return null;
      }
      pendingConvRef.current = null;
      // Mark that we're resolving a pending conversation — useLayoutEffect should not wipe messages
      skipCacheWipeRef.current = true;
      // Also skip the useEffect that loads messages (conv has no messages yet, sendContent handles them)
      skipMsgLoadRef.current = true;
      // If this conversation was previously hidden (deleted locally), unhide it
      setHiddenConvIds((prev) => prev.filter(id => id !== convId));
      // Update state with the real conversation ID
      setActiveConvId(convId);
      setConversations(prev => prev.map(c => c.id === activeConvId ? { ...c, id: convId } : c));
      // Reload conversations in background
      loadConvs();
    } else if (otherUser) {
      // Existing block check for non-pending conversations (cache + server)
      const cachedBlocked = getCachedBlockStatus(user.id, otherUser.id);
      if (cachedBlocked === true) {
        toast.error(t('chat.blocked_cannot_send'), { className: 'fc-toast' });
        return null;
      }
      const cachedBlockedByThem = getCachedBlockStatus(otherUser.id, user.id);
      if (cachedBlockedByThem === true) {
        toast.error(t('chat.blocked_by_them'), { className: 'fc-toast' });
        return null;
      }
      // Server double-check (cache might be stale)
      try {
        const blockedByMe = await isBlocked(user.id, otherUser.id);
        if (blockedByMe) {
          cacheBlockStatus(user.id, otherUser.id, true);
          toast.error(t('chat.blocked_cannot_send'), { className: 'fc-toast' });
          return null;
        }
        const blockedByThem = await isBlocked(otherUser.id, user.id);
        if (blockedByThem) {
          cacheBlockStatus(otherUser.id, user.id, true);
          toast.error(t('chat.blocked_by_them'), { className: 'fc-toast' });
          return null;
        }
      } catch {}
    }

    if (!convId) return null;

    const replyToId = replyingTo?.id || null;
    const tempId = crypto.randomUUID();
    const optimisticMsg = {
      id: tempId,
      conversation_id: convId,
      sender_id: user.id,
      decryptedContent: content,
      shared_song: sharedSong,
      reply_to: replyToId,
      created_at: new Date().toISOString(),
      edited_at: null,
      is_pinned: false,
      reactions: {},
      deleted_for: null,
      _optimistic: true,
    };

    setMessages((prev) => [...prev, optimisticMsg]);
    if (clearInput) {
      setInputValue('');
      if (convId) draftsRef.current[convId] = '';
    }
    setReplyingTo(null);
    setSending(true);
    setTimeout(() => messagesContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 10);

    try {
      const { data: participants } = await supabase
        .from('chat_participants')
        .select('user_id')
        .eq('conversation_id', convId);
      const participantIds = (participants || []).map(p => p.user_id).filter(id => id !== user.id);
      const sentMsg = await sendMessage(convId, user.id, content, participantIds, replyToId, null, null, null, sharedSong);

      setMessages((prev) => {
        const replaced = prev.map(m =>
          m.id === tempId ? { ...sentMsg, decryptedContent: content, _optimistic: false } : m
        );
        const seen = new Set();
        return replaced.filter(m => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
      });
      // Update conversation preview immediately (optimistic), then sync in background
      // Preview optimista con el mismo texto que guarda chatService en la BD
      const sentPreview = sharedSong
        ? '🎵 Shared a song'
        : detectMediaFromContent(content).videoUrl
        ? '🎬 Video'
        : content;
      updateConvPreview(convId, sentPreview, sentMsg.created_at || new Date().toISOString());
      loadConvs();
      return sentMsg;
    } catch (err) {
      setMessages((prev) => prev.filter(m => m.id !== tempId));
      console.error('Error sending message:', err);
      if (!showRateLimitToast(t, err)) {
        toast.error(t('chat.send_error'), { className: 'fc-toast' });
      }
      return null;
    } finally {
      setSending(false);
    }
  }, [activeConvId, otherUser, user?.id, replyingTo, loadConvs, t]);

  // ── Cargar Media + fijados DIRECTAMENTE de la BD al elegir conversación ──
  // No dependen de `messages` (que puede tardar en cargar o tener solo la
  // primera página): el panel enseña las imágenes y los fijados al instante.
  const loadEagerForConversation = useCallback((convId, userId) => {
    if (!convId || !userId) return null;
    const current = eagerLoadRef.current;
    if (current.convId === convId && current.promise) return current.promise;

    let ownPromise = null;
    ownPromise = (async () => {
      try {
        const [pinned, recent] = await Promise.all([
          getPinnedMessages(convId, userId),
          getDecryptedMessages(convId, userId, 300),
        ]);
        // Otra conversación tomó el relevo: no pisar su estado con datos viejos.
        if (eagerLoadRef.current.convId !== convId) return;
        setEagerPinned({ convId, items: pinned });
        const urls = [];
        const seen = new Set();
        for (const m of recent) {
          if (!m.decryptedContent) continue;
          const { imageUrl } = detectMediaFromContent(m.decryptedContent);
          if (imageUrl && IMG_RE.test(imageUrl) && !seen.has(imageUrl)) {
            seen.add(imageUrl);
            urls.push(imageUrl);
          }
        }
        setEagerMedia({ convId, urls });
      } catch (err) {
        console.warn('[Chat] eager media/pinned load failed:', err?.message || err);
      } finally {
        // Solo limpiar si sigue siendo esta misma carga (evita pisar un reintento).
        if (eagerLoadRef.current.promise === ownPromise) {
          eagerLoadRef.current = { convId, promise: null };
        }
      }
    })();

    eagerLoadRef.current = { convId, promise: ownPromise };
    return ownPromise;
  }, []);

  useEffect(() => {
    if (!activeConvId || !user?.id) return undefined;
    let cancelled = false;
    const convId = activeConvId;
    const userId = user.id;
    // Diferido un tick: setState dentro del callback del fetch, nunca síncrono
    // en el cuerpo del efecto.
    Promise.resolve().then(() => {
      if (!cancelled) loadEagerForConversation(convId, userId);
    });
    return () => { cancelled = true; };
  }, [activeConvId, user?.id, loadEagerForConversation]);

  // Reintento al abrir el panel: si el primer fetch falló (red, RLS temporal,
  // StrictMode) el usuario veía "sin mensajes" para siempre.
  useEffect(() => {
    if (!activeConvId || !user?.id) return;
    if (!showMediaGallery && !showPinnedPanel) return;
    if (eagerPinned.convId === activeConvId && eagerMedia.convId === activeConvId) return;
    Promise.resolve().then(() => loadEagerForConversation(activeConvId, user.id));
  }, [
    showMediaGallery,
    showPinnedPanel,
    activeConvId,
    user?.id,
    eagerPinned.convId,
    eagerMedia.convId,
    loadEagerForConversation,
  ]);

  // ── Actualizar allChatMediaUrlsRef cuando cambian los mensajes ──
  useEffect(() => {
    // Resetear al cambiar de conversación
    if (activeConvId !== prevConvForMediaRef.current) {
      allChatMediaUrlsRef.current = [];
      prevConvForMediaRef.current = activeConvId;
    }
    if (!activeConvId) return;
    const urls = messages
      .map(m => {
        if (!m.decryptedContent) return null;
        const { imageUrl } = detectMediaFromContent(m.decryptedContent);
        return imageUrl && IMG_RE.test(imageUrl) ? imageUrl : null;
      })
      .filter(Boolean);
    // Merge preserving order, deduplicating
    const existing = new Set(urls);
    const merged = [...urls];
    for (const url of allChatMediaUrlsRef.current) {
      if (!existing.has(url)) {
        merged.push(url);
        existing.add(url);
      }
    }
    allChatMediaUrlsRef.current = merged;
  }, [messages, activeConvId]);

  // ── Restaurar scroll tras cargar mensajes antiguos ──
  // Se dispara tras cada cambio de `messages`, pero solo actúa si hay un scroll
  // pendiente (guardado en loadOlderMessages). El guard de convId evita restaurar
  // en otra conversación si la carga se abortó o el usuario cambió de chat.
  useLayoutEffect(() => {
    const saved = scrollBeforeLoadRef.current;
    if (!saved) return;
    scrollBeforeLoadRef.current = null;
    if (saved.convId !== activeConvId) return;
    const sc = messagesContainerRef.current;
    if (sc) sc.scrollTop = saved.scrollTop;
  }, [messages, activeConvId]);

  // ── Load older messages (infinite scroll / pagination) ──
  const loadOlderMessages = useCallback(async () => {
    // SYNCHRONOUS check — prevents cascade from multiple scroll events in same event loop tick
    if (!activeConvId || loadingMoreRef.current || !hasMoreMessages || !oldestMessageDate || !user?.id) return;
    loadingMoreRef.current = true;

    setLoadingMore(true);
    const convIdAtStart = activeConvId;
    let aborted = false;

    // Guardar la posición del scroll ANTES de insertar los viejos para restaurarla
    // tras el commit (useLayoutEffect más arriba). column-reverse ancla al fondo:
    // forzar el MISMO scrollTop mantiene visible exactamente lo mismo mientras
    // los mensajes antiguos aparecen arriba ("coso1" se queda quieto).
    const el = messagesContainerRef.current;
    scrollBeforeLoadRef.current = el ? { scrollTop: el.scrollTop, convId: convIdAtStart } : null;    

    try {
      let attempts = 0;
      let raw = [];
      let filtered = [];
      let decrypted = [];
      let hasMore = false;
      let cursor = oldestMessageDate;
      const fetchLimit = PAGE_SIZE + 1; // request one extra to detect more

      do {
        attempts += 1;
        try {
          raw = await getMessages(convIdAtStart, fetchLimit, cursor);
        } catch (e) {
          raw = [];
        }
        if (aborted || convIdAtStart !== activeConvId) {
          scrollBeforeLoadRef.current = null;
          return;
        }
        hasMore = raw.length > PAGE_SIZE;
        if (raw.length > PAGE_SIZE) raw = raw.slice(0, PAGE_SIZE);
        filtered = raw.filter(m => !m.deleted_for?.includes(user.id));
        decrypted = await Promise.all(
          filtered.map(async (msg) => {
            const content = await decryptMessage(msg, user.id);
            return { ...msg, decryptedContent: content };
          })
        );

        if (decrypted.length === 0 && hasMore && attempts < 3) {
          // advance cursor to last raw item and retry
          cursor = raw.length ? raw[raw.length - 1].created_at : null;
          continue;
        }
        break;
      } while (attempts < 3);

      if (aborted || convIdAtStart !== activeConvId) {
        scrollBeforeLoadRef.current = null;
        return;
      }

      // Safety: user might have switched conversations during shared-post fetch
      if (convIdAtStart !== activeConvId) {
        scrollBeforeLoadRef.current = null;
        return;
      }

      if (decrypted.length === 0) {
        // No visible messages found; if server indicated no more, mark finished
        if (!hasMore) setHasMoreMessages(false);
        // Sin setMessages el useLayoutEffect de restore no se dispara: limpiar
        // el ref pendiente para que no restaure un scroll viejo más tarde.
        scrollBeforeLoadRef.current = null;
        return;
      }

      // Prepend older messages — they will appear at the visual bottom (column-reverse)
      setMessages(prev => [...decrypted, ...prev]);
      // Cursor = oldest in this batch (first in ASC array) — ensures no overlap on next fetch
      setOldestMessageDate(decrypted[0].created_at);
      // Mark timestamp so the scroll handler's cooldown prevents cascade
      lastLoadTimeRef.current = Date.now();
      setHasMoreMessages(hasMore);

    } catch (err) {
      console.warn('Error loading older messages:', err);
      // Este catch solo se alcanza si setMessages NO llegó a ejecutarse
      // (ej. fallo de decryptMessage en el Promise.all): limpiar el ref
      // pendiente para que no restaure un scroll viejo más tarde.
      scrollBeforeLoadRef.current = null;
    } finally {
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [activeConvId, loadingMore, hasMoreMessages, oldestMessageDate, user?.id]);


  // ── Scroll handler to detect when user reaches the visual top (oldest messages) ──
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;

    // Track scroll position for scroll-to-bottom button (SIEMPRE, incluso durante carga)
    // En column-reverse, scrollTop ≈ 0 al fondo (nuevos) y negativo grande al tope (viejos)
    const nearBottom = el.scrollTop > -80;
    setIsScrolledUp(!nearBottom);

    // Reset new messages counter when user scrolls near bottom
    if (newMsgCount > 0 && nearBottom) {
      setNewMsgCount(0);
    }

    // ── Pagination: cargar mensajes antiguos al llegar al tope ──
    if (loadingMoreRef.current || !hasMoreMessages) return;

    // Cooldown: prevent cascade — ignore scroll events within 500ms of a load
    if (Date.now() - lastLoadTimeRef.current < 500) return;

    // In column-reverse, scrollTop is NEGATIVE when scrolling up (toward oldest).
    // At the very top (oldest messages): scrollTop ≈ -(scrollHeight - clientHeight)
    // scrollRemaining = scrollTop + scrollHeight - clientHeight → 0 at the top
    const scrollRemaining = el.scrollTop + el.scrollHeight - el.clientHeight;
    const threshold = 150;
    if (scrollRemaining < threshold) {
      // Pre-mark lastLoadTime to avoid immediate retriggers while async fetch starts
      lastLoadTimeRef.current = Date.now();
      // Call via ref to avoid recreating the scroll handler when the function identity changes
      try { loadOlderMessagesRef.current(); } catch (e) { console.warn('loadOlderMessagesRef failed', e); }
    }
  }, [hasMoreMessages, loadOlderMessages, newMsgCount]);

  // Use a ref to call loadOlderMessages from the scroll handler so the handler
  // identity doesn't change when the callback is recreated, avoiding frequent
  // cleanup/attach of the scroll listener.
  const loadOlderMessagesRef = useRef(loadOlderMessages);
  useEffect(() => { loadOlderMessagesRef.current = loadOlderMessages; }, [loadOlderMessages]);

  // ── Attach scroll listener to messages container ──
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleMessagesScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleMessagesScroll);
    };
  }, [handleMessagesScroll]);

  // ── Restore scroll position after prepending older messages (column-reverse) ──
  useLayoutEffect(() => {
    if (scrollBeforeLoadRef.current == null) return;
    const saved = scrollBeforeLoadRef.current;
    scrollBeforeLoadRef.current = null;
    // Format: { scrollTop, scrollHeight }
    const el = messagesContainerRef.current;
    if (!el) return;
    const { scrollTop: savedTop, scrollHeight: oldH } = saved;
    const diff = el.scrollHeight - oldH;
    // Add a buffer so scrollRemaining > threshold after restoration, preventing immediate re-trigger
    const SCROLL_RESTORE_BUFFER = 200;
    const newScrollTop = savedTop - diff + SCROLL_RESTORE_BUFFER;
    if (diff > 0) {
      el.scrollTop = newScrollTop;
    }
  }, [messages]);

  // ── Send GIF ──
  const handleGifSelect = useCallback(async (gifUrl) => {
    setShowGifPicker(false);
    if (!gifUrl) return;
    await sendContent(gifUrl);
  }, [sendContent]);

  // ── Send song (card fuera de la burbuja, como la invitación a comunidad) ──
  const handleSongSelect = async (song) => {
    setShowSongPicker(false);
    if (!song?.title) return;
    // Los resultados de YouTube no traen preview: se pide uno a iTunes como
    // respaldo del reproductor (best-effort, no bloquea el envío si falla).
    const songToSend = await withPreviewFallback(song);
    await sendContent('', { sharedSong: songToSend });
  };

  // ── Defensive dedup: some async races can introduce duplicate IDs ──
  const dedupedMessages = React.useMemo(() => {
    const seen = new Set();
    return messages.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }, [messages]);

  // ── Compute message grouping (based on chronological order) ──
  const messageGroupMap = React.useMemo(() => {
    const map = {};
    for (let i = 0; i < dedupedMessages.length; i++) {
      const msg = dedupedMessages[i];
      const prev = i > 0 ? dedupedMessages[i - 1] : null;
      const next = i < dedupedMessages.length - 1 ? dedupedMessages[i + 1] : null;
      const isFirst = !prev || prev.sender_id !== msg.sender_id || (new Date(msg.created_at) - new Date(prev.created_at)) > 300000;
      const isLast = !next || next.sender_id !== msg.sender_id || (new Date(next.created_at) - new Date(msg.created_at)) > 300000;
      const isSolo = isFirst && isLast;
      let groupClass;
      let isGrouped = false;
      if (isSolo) groupClass = 'chat-message-bubble--solo';
      else if (isFirst) { groupClass = 'chat-message-bubble--first'; isGrouped = true; }
      else if (isLast) { groupClass = 'chat-message-bubble--last'; isGrouped = true; }
      else { groupClass = 'chat-message-bubble--middle'; isGrouped = true; }
      // Marcar el mensaje que INICIA cada día (el más antiguo del grupo) para
      // renderizar el divisor de fecha por encima de él (estilo Discord/Instagram).
      const sameDayAsPrev = prev && new Date(msg.created_at).toDateString() === new Date(prev.created_at).toDateString();
      map[msg.id] = { groupClass, showAvatar: isFirst, isGrouped, showDayDivider: !sameDayAsPrev };
    }
    return map;
  }, [dedupedMessages]);

  // ── Etiqueta del divisor de día (Hoy / Ayer / fecha localizada) ──
  const getDayDividerLabel = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return ''; // fecha inválida → sin etiqueta
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfMsgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diffDays = Math.round((startOfToday - startOfMsgDay) / 86400000);
    if (diffDays === 0) return t('chat.today');
    if (diffDays === 1) return t('chat.yesterday');
    const dateLocale = locale === 'en' ? 'en-US' : locale === 'ja' ? 'ja-JP' : locale === 'pt' ? 'pt-BR' : locale === 'ru' ? 'ru-RU' : 'es-ES';
    const sameYear = date.getFullYear() === now.getFullYear();
    return date.toLocaleDateString(dateLocale, {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  };

  // ── Reversed messages for column-reverse render (newest first in DOM) ──
  const reversedMessages = React.useMemo(() => [...dedupedMessages].reverse(), [dedupedMessages]);

  // ── Llamadas indexadas por conversación (lista de chats + hilo) ──
  const callsByConv = React.useMemo(() => {
    const map = {};
    for (const call of callHistory) {
      (map[call.conversation_id] ||= []).push(call);
    }
    return map;
  }, [callHistory]);

  const latestCallByConv = React.useMemo(() => {
    const map = {};
    for (const call of callHistory) {
      const current = map[call.conversation_id];
      if (!current || new Date(call.created_at) > new Date(current.created_at)) {
        map[call.conversation_id] = call;
      }
    }
    return map;
  }, [callHistory]);

  // ── Conversaciones indexadas por id (para el historial de llamadas) ──
  const convsById = React.useMemo(() => {
    const map = {};
    for (const conv of conversations) map[conv.id] = conv;
    return map;
  }, [conversations]);

  // ── Historial de llamadas para la vista "Llamadas" del panel izquierdo ──
  const callList = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return callHistory
      .filter((call) => CALL_HISTORY_STATUSES.includes(call.status))
      // Solo conversaciones presentes en la lista: si no, el clic no tendría destino.
      .filter((call) => convsById[call.conversation_id])
      .filter((call) => {
        if (!q) return true;
        const peer = convsById[call.conversation_id]?.otherUser;
        return getDisplayName(peer).toLowerCase().includes(q);
      });
  }, [callHistory, convsById, searchQuery, getDisplayName]);

  // ── Timeline del hilo: mensajes + eventos de llamada intercalados por fecha.
  // Igual que reversedMessages, más nuevo primero (el contenedor es
  // column-reverse). ──
  const reversedTimeline = React.useMemo(() => {
    const calls = (callsByConv[activeConvId] || []).filter((c) => CALL_HISTORY_STATUSES.includes(c.status));
    const items = [
      ...reversedMessages.map((msg) => ({ kind: 'msg', at: msg.created_at, msg })),
      ...calls.map((call) => ({ kind: 'call', at: call.created_at, call })),
    ];
    items.sort((a, b) => new Date(b.at) - new Date(a.at));
    return items;
  }, [reversedMessages, callsByConv, activeConvId]);
  // ── Navigate to profile from header ──
  const goToProfile = useCallback(() => {
    if (otherUser?.username) {
      navigate(`/profile/${otherUser.username}`);
    }
  }, [otherUser?.username, navigate]);

  // ── Open followers modal ──
  const openFollowersModal = useCallback(async () => {
    if (!user?.id) return;
    setShowFollowersModal(true);
    setFollowersLoading(true);
    try {
      const data = await getFollowing(user.id);
      // Filter out users who have blocked the current user or are blocked by the current user
      const filtered = (data || []).filter(u => {
        const blockedByMe = getCachedBlockStatus(user.id, u.id);
        const blockedByThem = getCachedBlockStatus(u.id, user.id);
        return blockedByMe !== true && blockedByThem !== true;
      });
      setFollowers(filtered);
    } catch (err) {
      console.warn('Error fetching following:', err);
      setFollowers([]);
    } finally {
      setFollowersLoading(false);
    }
  }, [user?.id]);

  // ── Followers modal ──
  const renderFollowersModal = () => (
    <ModalShell isOpen={showFollowersModal} onClose={() => setShowFollowersModal(false)} onEscape={() => setShowFollowersModal(false)} className="chat-followers-modal">
      <div className="chat-followers-modal-header">
        <h3 className="fc-modal-title">{t('chat.new')}</h3>
        <button type="button" className="chat-followers-modal-close" onClick={() => setShowFollowersModal(false)}>
          <FaTimes />
        </button>
      </div>        {followersLoading ? (
          <div className="chat-followers-modal-status"><FaSpinner className="fc-spin" /></div>
      ) : followers.length === 0 ? (
        <div className="chat-followers-modal-status">
          <FaUsers className="chat-followers-modal-empty-icon" />
          <p>{t('following.empty')}</p>
        </div>
      ) : (
        <div className="chat-followers-modal-list">
          {followers.map((u) => (
            <button key={u.id} className="chat-followers-modal-card" onClick={() => { setShowFollowersModal(false); startConversation(u); }}>
              <Avatar src={u.avatar_url} alt={u.username} className="chat-followers-modal-card-avatar" />
              <span className="chat-followers-modal-card-name">{getDisplayName(u)}</span>
              {Array.isArray(u.roles) && u.roles.includes('verified') && (
                <img src="/verified_badge2.png" alt="Verified" className="chat-followers-modal-card-verified" draggable={false} loading="lazy" />
              )}
            </button>
          ))}
        </div>
      )}
    </ModalShell>
  );

  if (!user) return null;

  // ── Render conversation list content ──
  // NOTA: devuelve un FRAGMENT — el <div className="chat-list"> lo pone el
  // caller (ver return principal). Anidar otra .chat-list aquí duplicaba la
  // card flotante (card dentro de card desplazando búsqueda e items).
  const renderConversationListContent = () => (
    <>
      <div className="chat-list-header">
        <h2 className="chat-list-title">{listView === 'calls' ? t('chat.call_history') : t('chat.title')}</h2>
        <Tooltip
          text={listView === 'calls' ? t('chat.title') : t('chat.call_history')}
          placement="bottom"
        >
          <button
            className={`chat-list-new-btn chat-list-view-btn${listView === 'calls' ? ' chat-list-view-btn--active' : ''}`}
            onClick={() => setListView((v) => (v === 'calls' ? 'chats' : 'calls'))}
            aria-pressed={listView === 'calls'}
            aria-label={t('chat.call_history')}
          >
            {listView === 'calls' ? <FaComment /> : <FaPhoneAlt />}
          </button>
        </Tooltip>
        <Tooltip text={t('chat.new')} placement="bottom">
          <button className="chat-list-new-btn" onClick={openFollowersModal}>
            <FaPlus />
          </button>
        </Tooltip>
      </div>

      {/* Persistent search bar — filters conversations by name */}
      <div className="chat-search-bar">
        <div className="chat-search-bar-wrap">
          <FaSearch className="chat-search-bar-icon" />
          <input
            className="chat-search-bar-input"
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder={t('chat.search_placeholder') || 'Filter conversations...'}
          />
          {searchQuery && (
            <button className="chat-search-bar-clear" onClick={() => setSearchQuery('')}>
              <FaTimes />
            </button>
          )}
        </div>
      </div>

      {/* Conversaciones o historial de llamadas */}
      <div className="chat-list-items">
        {listView === 'calls' ? (
          callList.length === 0 ? (
            <div className="chat-list-empty">
              <div className="chat-list-empty-icon"><FaPhoneAlt /></div>
              <p>{t('chat.calls_empty')}</p>
            </div>
          ) : (
            callList.map((call) => {
              const conv = convsById[call.conversation_id];
              const peer = conv?.otherUser;
              const missed = call.status === 'missed' || call.status === 'declined';
              const duration = formatCallDuration(call);
              return (
                <button
                  key={call.id}
                  className="chat-list-item chat-call-item"
                  onClick={() => selectConversation(call.conversation_id)}
                  title={getDisplayName(peer)}
                  style={{ '--fc-user-accent': peer?.accent_color || undefined }}
                >
                  <Avatar
                    src={peer?.avatar_url}
                    alt={peer?.username || '?'}
                    className="chat-list-item-avatar"
                    status={otherUserStatuses?.[peer?.id] ?? computeEffectiveStatus(peer)}
                  />
                  <div className="chat-list-item-info">
                    <div className="chat-list-item-top">
                      <span className="chat-list-item-name">{getDisplayName(peer)}</span>
                      <span className="chat-list-item-time">
                        {getTimeAgo(t, locale, call.created_at)}
                      </span>
                    </div>
                    <div className="chat-list-item-bottom">
                      <span className={`chat-list-item-preview chat-call-item-preview${missed ? ' chat-call-item-preview--missed' : ''}`}>
                        <FaPhoneAlt className="chat-list-item-preview-icon" />{' '}
                        {callEventLabel(call, user.id, t)}
                        {duration && <span className="chat-call-item-duration">· {duration}</span>}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })
          )
        ) : convsLoading ? (
          <div className="chat-list-loading">
            {[1,2,3,4,5].map((i) => (
              <div key={i} className="chat-list-skeleton-item">
                <div className="chat-list-skeleton-avatar" />
                <div className="chat-list-skeleton-lines">
                  <div className="chat-list-skeleton-line" />
                  <div className="chat-list-skeleton-line chat-list-skeleton-line--short" />
                </div>
              </div>
            ))}
          </div>
        ) : visibleConversations.length === 0 ? (
          <div className="chat-list-empty">
            <div className="chat-list-empty-icon"><FaComment /></div>
            <p>{t('chat.empty')}</p>
            <p className="chat-list-empty-sub">{t('chat.empty_sub')}</p>
          </div>
        ) : (
          visibleConversations.map((conv) => (
            <button
              key={conv.id}
              className={`chat-list-item ${conv.id === activeConvId ? 'chat-list-item--active' : ''}`}
              onClick={() => selectConversation(conv.id)}
              onContextMenu={(e) => handleContextMenu(e, conv.id)}
              style={{ '--fc-user-accent': conv.otherUser?.accent_color || undefined }}
            >
              <Avatar
                src={conv.otherUser?.avatar_url}
                alt={conv.otherUser?.username || '?'}
                className="chat-list-item-avatar"
                status={otherUserStatuses?.[conv.otherUser?.id] ?? computeEffectiveStatus(conv.otherUser)}
              />
              <div className="chat-list-item-info">
                <div className="chat-list-item-top">
                  <span className="chat-list-item-name">{getDisplayName(conv.otherUser)}</span>
                  {(() => {
                    const o = localConvOverridesRef.current[conv.id];
                    const previewAt = o?.at ?? conv.last_message_at;
                    // Si la última llamada es posterior al último mensaje, manda ella.
                    const lastCall = latestCallByConv[conv.id];
                    const callLatest = lastCall && (!previewAt || new Date(lastCall.created_at) > new Date(previewAt));
                    const at = callLatest ? lastCall.created_at : previewAt;
                    return (
                      <>
                        {at && (
                          <span className="chat-list-item-time">
                            {getTimeAgo(t, locale, at)}
                          </span>
                        )}
                      </>
                    );
                  })()}
                </div>
                <div className="chat-list-item-bottom">
                  <span className="chat-list-item-preview">
                    {(() => {
                      const o = localConvOverridesRef.current[conv.id];
                      const previewAt = o?.at ?? conv.last_message_at;
                      const lastCall = latestCallByConv[conv.id];
                      const callLatest = lastCall && (!previewAt || new Date(lastCall.created_at) > new Date(previewAt));
                      if (callLatest) {
                        const missed = lastCall.status === 'missed' || lastCall.status === 'declined';
                        return (
                          <>
                            <FaPhoneAlt className={`chat-list-item-preview-icon${missed ? ' chat-list-item-preview-icon--missed' : ''}`} />{' '}
                            {callEventLabel(lastCall, user.id, t)}
                          </>
                        );
                      }
                      const previewText = o?.text ?? conv.last_message_text;
                      if (!previewText) return '';
                      return mediaPreviewLabel(previewText) || previewText;
                    })()}
                  </span>
                  {conv.is_pinned && (
                    <FaThumbtack className="chat-list-item-pin-icon" />
                  )}
                  {conv.unreadCount > 0 && (
                    <span className="chat-list-item-badge">
                      {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Tu cuenta, fija al pie del listado (fuera del scroller de chats). */}
      <ChatAccountCard />
    </>
  );

  // ── Render message area content ──
  // NOTA: FRAGMENT — el <div className="chat-messages"> lo pone el caller
  // (mismo patrón que renderConversationListContent / la card flotante).
  const renderMessageAreaContent = () => (
    <>
      {/* Header */}
      <div className="chat-messages-header">
        <div className="chat-messages-header-left">
          <button className="chat-messages-back" onClick={goBackToList}>
            <FaArrowLeft />
          </button>
          <Avatar
            src={otherUser?.avatar_url}
            alt={otherUser?.username || '?'}
            className="chat-messages-header-avatar"
            style={{ cursor: 'pointer' }}
            onClick={goToProfile}
            status={activeConversationStatus}
          />
          <div className="chat-messages-header-info" style={{ cursor: 'pointer' }} onClick={goToProfile}>
            <span className="chat-messages-header-name">{getDisplayName(otherUser)}</span>
          </div>
        </div>
        <div className="chat-messages-header-actions">
          <div className="chat-header-actions-desktop">
            <Tooltip text={t('chat.search_messages') || 'Search'} placement="bottom">
              <button
                className={`chat-header-action-btn ${showMsgSearch ? 'chat-header-action-btn--active' : ''}`}
                onClick={() => { setShowMsgSearch(s => !s); setShowMediaGallery(false); setShowPinnedPanel(false); setShowProfileCard(false); }}
              >
                <FaSearch />
              </button>
            </Tooltip>
            <Tooltip text={t('chat.media_gallery') || 'Media'} placement="bottom">
              <button
                className={`chat-header-action-btn ${showMediaGallery ? 'chat-header-action-btn--active' : ''}`}
                onClick={() => {
                  setShowMediaGallery(s => !s);
                  setShowMsgSearch(false);
                  setShowPinnedPanel(false);
                  setShowProfileCard(false);
                }}
              >
                <FaImage />
              </button>
            </Tooltip>
            <Tooltip text={t('post.pinned') || 'Pinned'} placement="bottom">
              <button
                className={`chat-header-action-btn ${showPinnedPanel ? 'chat-header-action-btn--active' : ''}`}
                onClick={() => { setShowPinnedPanel(s => !s); setShowMsgSearch(false); setShowMediaGallery(false); setShowProfileCard(false); }}
              >
                <FaThumbtack />
              </button>
            </Tooltip>
            <Tooltip text={t('chat.view_profile') || 'Profile'} placement="bottom">
              <button
                className={`chat-header-action-btn ${showProfileCard ? 'chat-header-action-btn--active' : ''}`}
                onClick={() => { setShowProfileCard(s => !s); setShowMsgSearch(false); setShowMediaGallery(false); setShowPinnedPanel(false); }}
              >
                <FaUser />
              </button>
            </Tooltip>
            <Tooltip text={t('chat.call') || 'Call'} placement="bottom">
              <button
                className={`chat-header-action-btn${callSession ? ' chat-header-action-btn--active' : ''}`}
                onClick={handleStartCall}
                disabled={!activeConvId || !otherUser?.id}
              >
                <FaPhone />
              </button>
            </Tooltip>
            <div className="chat-header-menu-wrap" ref={headerMenuRef}>
              <Tooltip text={t('chat.header_more') || 'More'} placement="bottom">
                <button
                  className={`chat-header-action-btn ${headerMenuOpen ? 'chat-header-action-btn--active' : ''}`}
                  onClick={() => setHeaderMenuOpen(s => !s)}
                >
                  <FaEllipsisH />
                </button>
              </Tooltip>
              {headerMenuOpen && (
                <div className="chat-header-dropdown">
                  <button className="chat-context-menu-btn" onClick={() => { setHeaderMenuOpen(false); setConfirmBlock(true); }}>
                    <FaBan />
                    <span>{getCachedBlockStatus(user?.id, otherUser?.id) === true ? t('block.unblock') : t('block.block')}</span>
                  </button>
                  <button className="chat-context-menu-btn" onClick={() => { setHeaderMenuOpen(false); openBubbleColorModal(activeConvId); }}>
                    <FaPalette />
                    <span>{t('chat.bubble_colors') || 'Bubble colors'}</span>
                  </button>
                  <button className="chat-context-menu-btn" onClick={() => { setHeaderMenuOpen(false); openChatBackgroundModal(activeConvId); }}>
                    <FaImage />
                    <span>{t('chat.background') || 'Chat background'}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <button
            className="chat-header-mobile-menu-btn"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMobileMenuTop(rect.bottom + 4);
              setShowMobileMenu(s => !s);
            }}
            title="More"
          >
            <FaEllipsisH />
          </button>
        </div>
      </div>

      {/* ── Mobile header menu ── */}
      {showMobileMenu && (
        <div className="chat-mobile-header-menu" style={{ top: mobileMenuTop }}>
          <button
            className={`chat-mobile-header-menu-item ${showMsgSearch ? 'active' : ''}`}
            onClick={() => { setShowMsgSearch(s => !s); setShowMobileMenu(false); setShowMediaGallery(false); setShowPinnedPanel(false); setShowProfileCard(false); }}
          >
            <FaSearch /> {t('chat.search_messages') || 'Search'}
          </button>
          <button
            className={`chat-mobile-header-menu-item ${showMediaGallery ? 'active' : ''}`}
            onClick={() => { setShowMediaGallery(s => !s); setShowMobileMenu(false); setShowMsgSearch(false); setShowPinnedPanel(false); setShowProfileCard(false); }}
          >
            <FaImage /> {t('chat.media_gallery') || 'Media'}
          </button>
          <button
            className={`chat-mobile-header-menu-item ${showPinnedPanel ? 'active' : ''}`}
            onClick={() => { setShowPinnedPanel(s => !s); setShowMobileMenu(false); setShowMsgSearch(false); setShowMediaGallery(false); setShowProfileCard(false); }}
          >
            <FaThumbtack /> {t('post.pinned') || 'Pinned'}
          </button>
          <button
            className="chat-mobile-header-menu-item"
            onClick={() => { setShowMobileMenu(false); handleStartCall(); }}
            disabled={!activeConvId || !otherUser?.id}
          >
            <FaPhone /> {t('chat.call') || 'Call'}
          </button>
          <button
            className="chat-mobile-header-menu-item"
            onClick={() => { setShowMobileMenu(false); openBubbleColorModal(activeConvId); }}
          >
            <FaPalette /> {t('chat.bubble_colors') || 'Bubble colors'}
          </button>
          <button
            className="chat-mobile-header-menu-item"
            onClick={() => { setShowMobileMenu(false); openChatBackgroundModal(activeConvId); }}
          >
            <FaImage /> {t('chat.background') || 'Chat background'}
          </button>
          <button
            className="chat-mobile-header-menu-item"
            onClick={() => { setShowMobileMenu(false); setConfirmBlock(true); }}
          >
            <FaBan /> {getCachedBlockStatus(user?.id, otherUser?.id) === true ? t('block.unblock') : t('block.block')}
          </button>
          <button
            className={`chat-mobile-header-menu-item ${showProfileCard ? 'active' : ''}`}
            onClick={() => { setShowProfileCard(s => !s); setShowMobileMenu(false); setShowMsgSearch(false); setShowMediaGallery(false); setShowPinnedPanel(false); }}
          >
            <FaUser /> {t('chat.view_profile') || 'Profile'}
          </button>
        </div>
      )}

      {/* Messages — key=activeConvId fuerza remount completo al cambiar de chat */}
      <div className="chat-messages-body" ref={messagesContainerRef} style={{
        '--chat-bubble-own': bubbleColors[activeConvId]?.own || '#111111',
        '--chat-bubble-own-text': getContrastFromHex(bubbleColors[activeConvId]?.own),
        '--chat-bubble-other': bubbleColors[activeConvId]?.other || 'var(--color-surface-hover, #252525)',
        '--chat-bubble-other-text': getContrastFromHex(bubbleColors[activeConvId]?.other),
        // El fondo de la conversación NO va aquí: vive en la card
        // (.chat-messages), y el body queda transparente para dejarlo ver.
      }}>
        {msgsLoading ? (
          <div className="chat-messages-loading">
            {[0, 1, 2, 3, 4].map((i) => {
              const own = i % 2 === 1;
              return (
                <div key={i} className={`chat-skeleton-msg ${own ? 'chat-skeleton-msg--own' : 'chat-skeleton-msg--other'}`}>
                  {!own && <div className="chat-skeleton-avatar" />}
                  <div className={`chat-skeleton-bubble ${own ? 'chat-skeleton-bubble--own' : 'chat-skeleton-bubble--other'} chat-skeleton-bubble--w${(i % 3) + 1}`}>
                    <div className="chat-skeleton-line" />
                    <div className="chat-skeleton-line chat-skeleton-line--short" />
                  </div>
                </div>
              );
            })}
          </div>
        ) : reversedTimeline.length === 0 ? (
          <div className="chat-messages-empty">
            <FaComment className="chat-messages-empty-icon" />
            <p>{t('chat.no_messages')}</p>
          </div>
        ) : (
          reversedTimeline.map((item) => {
            // Evento de llamada: fila centrada, fuera del flujo de burbujas.
            if (item.kind === 'call') {
              return (
                <ChatCallEvent
                  key={`call-${item.call.id}`}
                  call={item.call}
                  userId={user.id}
                  t={t}
                  locale={locale}
                />
              );
            }
            const msg = item.msg;
            const isOwn = msg.sender_id === user.id;
            const isEditing = editMsgId === msg.id;
            const groupInfo = messageGroupMap[msg.id] || {};
            const groupClass = groupInfo.groupClass || 'chat-message-bubble--solo';
            const showAvatar = groupInfo.showAvatar !== false;
            const reactions = msg.reactions || {};
            // Group reactions by emoji for stacking
            const groupedReactions = {};
            Object.entries(reactions).forEach(([uid, em]) => {
              if (!groupedReactions[em]) {
                groupedReactions[em] = { count: 0, isOwn: false };
              }
              groupedReactions[em].count++;
              if (uid === user.id) groupedReactions[em].isOwn = true;
            });
            const ownReaction = reactions[user.id];
            // Tarjeta "pura" (invitación o canción, sin texto): la burbuja se
            // vuelve transparente para que la card se vea suelta, fuera de la
            // burbuja visualmente
            const isBareCard = !!((msg.shared_community_id || msg.shared_song) && !(msg.decryptedContent || '').trim());

            return (
              <React.Fragment key={msg.id}>
                <div
                  data-msg-id={msg.id}
                  className={`chat-message ${isOwn ? 'chat-message--own' : 'chat-message--other'}`}
                  onContextMenu={(e) => handleMsgContextMenu(e, msg)}
                  onDoubleClick={() => handleStartReply(msg)}
                  onTouchStart={handleMsgTouchStart}
                  onTouchEnd={(e) => handleMsgTouchEnd(e, msg)}
                  onTouchCancel={handleMsgTouchCancel}
                >
                <div className={`chat-message-row ${isOwn ? 'chat-message-row--own' : 'chat-message-row--other'}`}>
                  {!isOwn && showAvatar && (
                    <Avatar
                      src={otherUser?.avatar_url}
                      alt={otherUser?.username || '?'}
                      className="chat-message-avatar"
                      onClick={(e) => { e.stopPropagation(); handleMessageAvatarClick(otherUser); }}
                    />
                  )}
                  {!isOwn && !showAvatar && <div className="chat-message-avatar-spacer" />}
                  <div className={`chat-message-bubble ${groupClass} ${msg.is_pinned ? 'chat-message-bubble--pinned' : ''}${isBareCard ? ' chat-message-bubble--bare' : ''}`}>
                    {msg.is_pinned && (
                      <div className="chat-message-pin-badge">
                        <FaThumbtack />
                        <span>{t('post.pinned')}</span>
                      </div>
                    )}
                    {msg.reply_to && (() => {
                      const replied = messages.find(m => m.id === msg.reply_to);
                      if (!replied) return null;
                      return (
                        <div className="chat-message-reply-preview" onClick={() => handleGoToMessage(msg.reply_to)}>
                          <div className="chat-message-reply-preview-top">
                            <FaReply className="chat-message-reply-preview-icon" />
                            <Avatar
                              src={replied.sender_id === user.id
                                ? (profile?.avatar_url || user?.user_metadata?.avatar_url)
                                : otherUser?.avatar_url}
                              alt={replied.sender_id === user.id ? t('chat.replying_self') : (otherUser?.username || '?')}
                              className="chat-message-reply-preview-avatar"
                            />
                            <div className="chat-message-reply-preview-info">
                              <span className="chat-message-reply-preview-author">
                                {replied.sender_id === user.id
                                  ? t('chat.replying_self')
                                  : (replied.sender_id === otherUser?.id
                                    ? otherUser?.username
                                    : t('common.unknown'))}
                              </span>
                              <span className="chat-message-reply-preview-text">
                                {(() => {
                                  if (replied.shared_song?.title) {
                                    return <><FaMusic className="chat-list-item-preview-icon" /> {replied.shared_song.title}</>;
                                  }
                                  const txt = replied.decryptedContent || '';
                                  if (!txt) return <span>{t('chat.encrypted')}</span>;
                                  const mediaLabel = mediaPreviewLabel(txt);
                                  if (mediaLabel) return mediaLabel;
                                  return <>{txt.slice(0, 60)}{txt.length > 60 ? '...' : ''}</>;
                                })()}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                    {/* ── Shared post card (mini PostCard style) ── */}
                    {msg.shared_post_id && (
                      <ChatSharedPostCard
                        post={sharedPosts[msg.shared_post_id]}
                        postId={msg.shared_post_id}
                        onOpen={openSharedPost}
                      />
                    )}
                    {msg.shared_community_id && (
                      <ChatCommunityCard
                        community={sharedCommunities[msg.shared_community_id]}
                        inviteToken={msg.shared_invite_token}
                        isOwn={isOwn}
                      />
                    )}
                    {/* ── Canción compartida (card fuera de la burbuja) ── */}
                    {msg.shared_song && (
                      <ChatSongCard song={msg.shared_song} />
                    )}
                    {(() => {
                      const content = msg.decryptedContent || '';
                      if (!content) return null;
                      const { imageUrl, videoUrl } = detectMediaFromContent(content);
                      const mediaUrl = imageUrl || videoUrl;
                      const textOnly = mediaUrl ? content.replace(mediaUrl, '').trim() : content;
                      if (!textOnly && !mediaUrl) {
                        return (
                          <p className="chat-message-text">
                            <RichText
                              text={content || ''}
                              linkClass="chat-card-link"
                              mentionClass="chat-card-mention"
                              hashtagClass="chat-card-hashtag"
                              onExternalLink={handleExternalLink}
                            />
                            {!content && <span className="chat-message-encrypted">{t('chat.encrypted')}</span>}
                          </p>
                        );
                      }
                      return (
                        <>
                          {imageUrl && IMG_RE.test(imageUrl) && (
                            <ChatImage
                              src={imageUrl}
                              alt="Media"
                              onClick={(e) => {
                                e.stopPropagation();
                                // Collect all image URLs from all messages for gallery navigation
                                const allImages = messages
                                  .map(m => {
                                    const c = m.decryptedContent || '';
                                    const { imageUrl: u } = detectMediaFromContent(c);
                                    return u && IMG_RE.test(u) ? u : null;
                                  })
                                  .filter(Boolean);
                                const idx = allImages.indexOf(imageUrl);
                                openChatGallery(e, allImages.length > 0 ? allImages : [imageUrl], idx >= 0 ? idx : 0);
                              }}
                            />
                          )}
                          {/* Video por URL (viaja dentro del contenido cifrado, igual que las imágenes) */}
                          {videoUrl && (
                            <div className="chat-message-media-video">
                              {getEmbedUrl(videoUrl) ? (
                                <iframe
                                  src={getEmbedUrl(videoUrl)}
                                  className="chat-message-video-embed"
                                  title="Video"
                                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                  allowFullScreen
                                />
                              ) : (
                                <PostVideoPlayer src={videoUrl} />
                              )}
                            </div>
                          )}
                          {textOnly && (
                          <p className="chat-message-text">
                            <RichText
                              text={textOnly}
                              linkClass="chat-card-link"
                              mentionClass="chat-card-mention"
                              hashtagClass="chat-card-hashtag"
                              onExternalLink={handleExternalLink}
                            />
                          </p>
                        )}
                        {/* ── Link preview for non-media URLs ── */}
                        {(() => {
                          const urls = textOnly ? textOnly.match(/(https?:\/\/[^\s<]+)/gi) || [] : [];
                          const nonMediaUrls = urls.filter(u => !IMG_RE.test(u) && !isAttachableVideoUrl(u) && u !== imageUrl && u !== videoUrl);
                          if (nonMediaUrls.length === 0) return null;
                          return nonMediaUrls.slice(0, 1).map((url, i) => (
                            <LinkPreview key={i} url={url} onExternalLink={handleExternalLink} />
                          ));
                        })()}
                      </>
                    );
                    })()}
                  </div>
                  {isOwn && (
                    <span className="chat-message-time">
                      {msg.edited_at && (
                        <span className="chat-message-edited">{t('chat.edited')} · </span>
                      )}
                      {getTimeAgo(t, locale, msg.created_at)}
                    </span>
                  )}
                  {isOwn && showAvatar && (
                    <Avatar
                      src={profile?.avatar_url || user?.user_metadata?.avatar_url || user?.avatar_url}
                      alt={profile?.username || user?.username || '?'}
                      className="chat-message-avatar chat-message-avatar--own"
                      onClick={(e) => { e.stopPropagation(); handleMessageAvatarClick(); }}
                    />
                  )}
                  {isOwn && !showAvatar && <div className="chat-message-avatar-spacer" />}
                  {!isOwn && (
                    <span className="chat-message-time">
                      {msg.edited_at && (
                        <span className="chat-message-edited">{t('chat.edited')} · </span>
                      )}
                      {getTimeAgo(t, locale, msg.created_at)}
                    </span>
                  )}
                </div>

                {/* Reactions — floating outside bubble, stacked by emoji */}
                {!isEditing && Object.keys(reactions).length > 0 && (
                  <div className="chat-message-reactions">
                    {Object.entries(groupedReactions).map(([emoji, { count, isOwn }]) => (
                      <span
                        key={emoji}
                        className={`chat-message-reaction ${isOwn ? 'chat-message-reaction--own' : ''}`}
                        onClick={() => {
                          if (isOwn) {
                            handleReact(emoji, msg.id);
                          }
                        }}
                      >
                        {emoji}
                        {count > 1 && <span className="chat-message-reaction-count">{count}</span>}
                      </span>
                    ))}
                  </div>
                )}

                </div>
                {groupInfo.showDayDivider && (
                  <div className="chat-day-divider" aria-hidden="true">
                    <span>{getDayDividerLabel(msg.created_at)}</span>
                  </div>
                )}
              </React.Fragment>
            );
          })
        )}
        {loadingMore && (
          <div className="chat-load-more-spinner">
            <div className="chat-load-more-spinner-ring" />
          </div>
        )}
      </div>

      {/* Floating scroll-to-bottom button */}
      {(newMsgCount > 0 || isScrolledUp) && (
        <button className="chat-new-msg-btn" onClick={scrollToBottom}>
          <FaArrowDown className="chat-new-msg-btn-icon" />
          {newMsgCount > 0
            ? `${newMsgCount} ${newMsgCount === 1 ? (t('chat.new_message') || 'new message') : (t('chat.new_messages') || 'new messages')}`
            : (t('chat.scroll_to_bottom') || 'Volver al inicio')}
        </button>
      )}

      {/* Reply bar */}
      {replyingTo && (
        <div className="chat-reply-bar">
          <div className="chat-reply-bar-content">
            <FaReply className="chat-reply-bar-icon" />
            <div className="chat-reply-bar-text">
              <span className="chat-reply-bar-author">
                {replyingTo.sender_id === user.id
                  ? t('chat.replying_self')
                  : otherUser?.username || t('common.unknown')}
              </span>
              <span className="chat-reply-bar-preview">
                {replyingTo.shared_song?.title
                  ? `🎵 ${replyingTo.shared_song.title}`
                  : (replyingTo.decryptedContent?.slice(0, 80) || t('chat.encrypted'))}
                {!replyingTo.shared_song?.title && replyingTo.decryptedContent?.length > 80 ? '...' : ''}
              </span>
            </div>
          </div>
          <button className="chat-reply-bar-close" onClick={cancelReply} title={t('common.cancel')}>
            <FaTimes />
          </button>
        </div>
      )}

      {/* Input + actions */}
      <div className="chat-messages-input">
        {isBlockedConv ? (
          <div className="chat-input-blocked">
            <FaLock className="chat-input-blocked-icon" />
            <span className="chat-input-blocked-text">
              {isBlockedConv === 'blocked_by_me'
                ? (t('chat.input_blocked_by_me') || 'You blocked this user. You cannot send messages.')
                : (t('chat.input_blocked_by_them') || 'This user has blocked you. You cannot send messages.')}
            </span>
          </div>
        ) : (
          <>
          {/* ── Typing indicator (absolute, does not push) ── */}
        {otherUserTyping && (
          <div className="chat-typing-indicator">
            <div className="chat-typing-dots">
              <span className="chat-typing-dot"></span>
              <span className="chat-typing-dot"></span>
              <span className="chat-typing-dot"></span>
            </div>
            <span className="chat-typing-label">{getDisplayName(otherUser)} {t('chat.typing') || 'typing...'}</span>
          </div>
        )}
        {/* Media preview — muestra la imagen o un spinner mientras se sube */}
        {(mediaPreviewUrl || uploadingChatMedia) && (
          <div className="chat-media-preview">
            {uploadingChatMedia ? (
              <div className="chat-media-preview-uploading">
                <FaSpinner className="fc-spin" />
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted, #6b7280)' }}>
                  {t('upload.uploading') || 'Subiendo...'}
                </span>
              </div>
            ) : IMG_RE.test(mediaPreviewUrl) ? (
              <SafeImage src={mediaPreviewUrl} alt="Preview" className="chat-media-preview-img" />
            ) : isAttachableVideoUrl(mediaPreviewUrl) ? (
              <div className="chat-media-preview-video">
                {getEmbedUrl(mediaPreviewUrl) ? (
                  <iframe
                    src={getEmbedUrl(mediaPreviewUrl)}
                    className="chat-message-video-embed"
                    title="Video"
                    allowFullScreen
                  />
                ) : (
                  <PostVideoPlayer src={mediaPreviewUrl} />
                )}
              </div>
            ) : (
              <span className="chat-media-preview-text">{mediaPreviewUrl}</span>
            )}
            <button className="chat-media-preview-remove" onClick={() => setMediaPreviewUrl('')} title="Remove">
              <FaTimes />
            </button>
          </div>
        )}
        {/* GIF picker */}
        {showGifPicker && (
          <GifPicker
            onSelect={handleGifSelect}
            onClose={() => setShowGifPicker(false)}
          />
        )}
        {/* Song picker — mismo contenedor embebido que el de GIF */}
        {showSongPicker && (
          <SongPicker
            onSelect={handleSongSelect}
            onClose={() => setShowSongPicker(false)}
          />
        )}
        {/* Input emoji picker */}
        {showInputEmojiPicker && (
          <div className="chat-input-emoji-picker">
            <div className="emoji-picker-tabs">
              {categoriesWithRecent.map((cat, idx) => (
                <button
                  key={idx}
                  className={`emoji-picker-tab ${inputEmojiTab === idx ? 'emoji-picker-tab--active' : ''}`}
                  onClick={() => setInputEmojiTab(idx)}
                  title={cat.name}
                >
                  {cat.name}
                </button>
              ))}
            </div>
            <div className="emoji-picker-grid">
              {categoriesWithRecent[inputEmojiTab]?.emojis.map(emoji => (
                <button
                  key={emoji}
                  className="emoji-picker-btn"
                  onClick={() => handleInputEmojiSelect(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* Media (imagen) picker — mismo contenedor embebido que GIF, canciones
            y emojis (ver MediaPicker / gifPicker.css). */}
        {showMediaInput && (
          <MediaPicker
            url={mediaUrl}
            onUrlChange={setMediaUrl}
            onFile={uploadChatImageFile}
            uploading={uploadingChatMedia}
            onSend={handleMediaSend}
            onClose={() => { setShowMediaInput(false); setMediaUrl(''); }}
          />
        )}
        <div className="chat-input-inner">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handleChatPaste}
            title={t('chat.paste_image_hint') || 'Paste an image with Ctrl+V'}
            placeholder={t('chat.input_placeholder')}
            rows={1}
            maxLength={2000}
          />
          <div className="chat-input-actions">
            <div className="chat-input-actions-desktop">
              <button
                className={`chat-input-action-btn ${showInputEmojiPicker ? 'chat-input-action-btn--active' : ''}`}
                onClick={() => { setShowInputEmojiPicker(s => !s); setShowGifPicker(false); setShowSongPicker(false); setShowMediaInput(false); }}
                title="Emoji"
              >
                <FaSmile />
              </button>
              <button
                className={`chat-input-action-btn ${showGifPicker ? 'chat-input-action-btn--active' : ''}`}
                onClick={() => { setShowGifPicker(s => !s); setShowInputEmojiPicker(false); setShowSongPicker(false); setShowMediaInput(false); }}
                title="GIF"
              >
                <span className="chat-input-action-btn-gif">GIF</span>
              </button>
              <button
                className={`chat-input-action-btn ${showMediaInput ? 'chat-input-action-btn--active' : ''}`}
                onClick={() => { setShowMediaInput(s => !s); setShowGifPicker(false); setShowInputEmojiPicker(false); setShowSongPicker(false); }}
                title="Media"
              >
                <FaImage />
              </button>
              <button
                className={`chat-input-action-btn ${showSongPicker ? 'chat-input-action-btn--active' : ''}`}
                onClick={() => { setShowSongPicker(s => !s); setShowGifPicker(false); setShowInputEmojiPicker(false); setShowMediaInput(false); }}
                title={t('chat.share_song')}
              >
                <FaMusic />
              </button>
            </div>

          </div>
        </div>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="chat-page">
      {/* ── Voice call overlay: ahora lo renderiza CallContext (global, cualquier ruta) ── */}
      <div className={`chat-list${!showList ? ' chat-list--hide-mobile' : ''}`}>
        {renderConversationListContent()}
      </div>
      <div
        className={`chat-messages${showList ? ' chat-messages--hide-mobile' : ''}${chatAccent ? ' chat-messages--accent' : ''}`}
        style={activeChatBackground ? {
          // Fondo personalizado de ESTA conversación (tabla privada
          // chat_background_settings), en la CARD y no en el body: así cubre
          // todo el chat (mensajes, franja del composer y pill del input) y las
          // zonas que no pintan fondo dejan verlo en vez de taparlo.
          // El velo oscuro va en el mismo background para que burbujas y texto
          // sigan legibles sobre cualquier imagen, sin capas extra.
          backgroundImage: `linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.55)), url("${activeChatBackground.replace(/"/g, '%22')}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          ...(chatAccent ? {
            // Acento del fondo del chat: el color dominante de la imagen tiñe la
            // cabecera y la caja de entrada. Se mezcla con la superficie del
            // tema (no se oscurece hacia negro, que apagaba el tono y dejaba un
            // gris) y luego se limita el brillo lo justo para que el texto
            // blanco siga legible, también con acentos claros (amarillo, cian…).
            '--chat-accent': chatAccent,
            '--chat-accent-header': ensureDarkSurface(mixHex(chatAccent, '#1a1a1a', 0.5), 0.14) || 'transparent',
            '--chat-accent-input': ensureDarkSurface(mixHex(chatAccent, '#1a1a1a', 0.62), 0.16) || 'transparent',
            '--chat-accent-border': hexToRgba(chatAccent, 0.7) || 'transparent',
          } : null),
        } : undefined}
      >
        {activeConvId ? renderMessageAreaContent() : (
          <div className="chat-messages-welcome">
            <FaComment className="chat-messages-welcome-icon" />
            <p>{t('chat.select_chat')}</p>
          </div>
        )}
      </div>
      {contextMenu.open && (
        <div
          ref={contextMenuRef}
          className="chat-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.convId && (() => {
            const conv = conversations.find(c => c.id === contextMenu.convId);
            const targetUser = conv?.otherUser;
            const currentNick = targetUser ? nicknames[targetUser.id] || '' : '';
            return (<>
              <button className="chat-context-menu-btn" onClick={handlePinConversation}>
                <FaThumbtack />
                <span>{conv?.is_pinned ? (t('chat.unpin') || 'Unpin') : (t('chat.pin') || 'Pin')}</span>
              </button>
              <button className="chat-context-menu-btn" onClick={handleSetNickname}>
                <FaEdit />
                <span>{currentNick ? t('chat.edit_nickname') || 'Edit nickname' : t('chat.set_nickname') || 'Set nickname'}</span>
              </button>
            </>);
          })()}
          <button className="chat-context-menu-btn chat-context-menu-btn--danger" onClick={handleDeleteConversation}>
            <FaTrash />
            <span>{t('post.delete')}</span>
          </button>
        </div>
      )}
      {/* ── Floating emoji picker (positioned like context menu) ── */}
      {emojiPickerMsgId && (
        <div
          ref={emojiPickerRef}
          className="chat-message-emoji-picker"
          style={{ left: emojiPickerPos.x, top: emojiPickerPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="emoji-picker-tabs">
            {categoriesWithRecent.map((cat, idx) => (
              <button
                key={idx}
                className={`emoji-picker-tab ${emojiTab === idx ? 'emoji-picker-tab--active' : ''}`}
                onClick={() => setEmojiTab(idx)}
                title={cat.name}
              >
                {cat.name}
              </button>
            ))}
          </div>
          <div className="emoji-picker-grid">
            {(() => {
              const targetMsg = messages.find(m => m.id === emojiPickerMsgId);
              const currentOwnReaction = targetMsg?.reactions?.[user?.id];
              return categoriesWithRecent[emojiTab]?.emojis.map(emoji => (
                <button
                  key={emoji}
                  className={`emoji-picker-btn ${currentOwnReaction === emoji ? 'emoji-picker-btn--active' : ''}`}
                  onClick={() => handleReact(emoji)}
                >
                  {emoji}
                </button>
              ));
            })()}
          </div>
        </div>
      )}

      {/* ── Message Search floating panel ── */}
      {showMsgSearch && (
        <div className="chat-float-panel chat-float-panel--search" onClick={(e) => e.stopPropagation()}>
          <div className="chat-float-panel-header">
            <span className="chat-float-panel-title">{t('chat.search_messages') || 'Search'}</span>
            <button className="chat-float-panel-close" onClick={() => setShowMsgSearch(false)}>
              <FaTimes />
            </button>
          </div>
          <div className="chat-msg-search-content">
            <div className="chat-msg-search-bar">
              <FaSearch className="chat-msg-search-bar-icon" />
              <input
                className="chat-msg-search-bar-input"
                type="text"
                value={msgSearchQuery}
                onChange={(e) => setMsgSearchQuery(e.target.value)}
                placeholder={t('chat.search_messages_placeholder') || 'Search messages...'}
                autoFocus
              />
              {msgSearchQuery && (
                <button className="chat-msg-search-bar-clear" onClick={() => setMsgSearchQuery('')}>
                  <FaTimes />
                </button>
              )}
            </div>
            <div className="chat-msg-search-results">
              {(() => {
                const q = msgSearchQuery.toLowerCase();
                const filtered = msgSearchQuery
                  ? messages.filter(m => {
                      const contentMatch = (m.decryptedContent || '').toLowerCase().includes(q);
                      // Also match by sender's username or displayname (only for current conversation)
                      const isSender = m.sender_id === user?.id;
                      const senderMatch = !isSender && otherUser
                        ? ((otherUser.username || '').toLowerCase().includes(q) ||
                           (otherUser.displayname || '').toLowerCase().includes(q))
                        : false;
                      return contentMatch || senderMatch;
                    })
                  : [];
                if (filtered.length === 0) {
                  return <div className="chat-msg-search-empty">{msgSearchQuery ? t('explore.no_results') : t('chat.search_messages_placeholder') || 'Search messages...'}</div>;
                }
                return filtered.slice(0, 20).map(msg => {
                  const isOwn = msg.sender_id === user?.id;
                  const senderName = isOwn ? t('chat.replying_self') : (otherUser?.username || t('common.unknown'));
                  const senderAvatar = isOwn
                    ? (profile?.avatar_url || user?.user_metadata?.avatar_url)
                    : otherUser?.avatar_url;
                  return (
                    <button
                      key={msg.id}
                      className="chat-msg-search-result"
                      onClick={() => { handleGoToMessage(msg.id); setShowMsgSearch(false); }}
                    >
                      <Avatar src={senderAvatar} alt={senderName} className="chat-msg-search-result-avatar" />
                      <div className="chat-msg-search-result-info">
                        <span className="chat-msg-search-result-sender">{senderName}</span>
                        <span className="chat-msg-search-result-text">
                          {(() => {
                            const txt = msg.decryptedContent || '';
                            if (!txt) return <span>{t('chat.encrypted')}</span>;
                            const mediaLabel = mediaPreviewLabel(txt);
                            if (mediaLabel) return mediaLabel;
                            return <>{txt.slice(0, 60)}{txt.length > 60 ? '...' : ''}</>;
                          })()}
                        </span>
                      </div>
                      <span className="chat-msg-search-result-time">
                        {getTimeAgo(t, locale, msg.created_at)}
                      </span>
                    </button>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── Media Gallery floating panel ── */}
      {showMediaGallery && (
        <div className="chat-float-panel">
          <div className="chat-float-panel-header">
            <span className="chat-float-panel-title">{t('chat.media_gallery') || 'Media'}</span>
            <button className="chat-float-panel-close" onClick={() => setShowMediaGallery(false)}>
              <FaTimes />
            </button>
          </div>
          <div className="chat-media-gallery-grid">
            {(() => {
              // Prioridad: galería traída aparte de la BD (no espera a la carga
              // de la conversación). Se completa con las URLs de los mensajes ya
              // cargados (páginas antiguas) sin duplicar.
              const eagerReady = eagerMedia.convId === activeConvId;
              const eager = eagerReady ? eagerMedia.urls : [];
              const loaded = allChatMediaUrlsRef.current;
              const allImages = eager.length
                ? [...eager, ...loaded.filter((u) => !eager.includes(u))]
                : loaded;
              if (allImages.length === 0) {
                // Mientras el fetch eager sigue en curso, no mostrar "sin
                // mensajes": era lo que parecía que el panel nunca cargaba.
                if (!eagerReady) {
                  return (
                    <p className="chat-float-panel-empty">
                      <FaSpinner className="fc-spin" />
                    </p>
                  );
                }
                return <p className="chat-float-panel-empty">{t('chat.no_messages')}</p>;
              }
              return allImages.map((url, i) => (
                <div key={url} className="chat-media-gallery-item">
                  <SafeImage
                    src={url}
                    alt=""
                    className="chat-media-gallery-img"
                    onClick={(e) => {
                      e.stopPropagation();
                      openChatGallery(e, allImages, i);
                    }}
                  />
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {/* ── Pinned Messages floating panel ── */}
      {showPinnedPanel && (
        <div className="chat-float-panel">
          <div className="chat-float-panel-header">
            <span className="chat-float-panel-title">{t('post.pinned')}</span>
            <button className="chat-float-panel-close" onClick={() => setShowPinnedPanel(false)}>
              <FaTimes />
            </button>
          </div>
          <div className="chat-pinned-list">
            {(() => {
              // Mismos datos eager que el panel de media: los fijados salen de
              // la BD al instante, sin esperar a que cargue la conversación.
              const fromEager = eagerPinned.convId === activeConvId;
              const pinned = fromEager ? eagerPinned.items : messages.filter(m => m.is_pinned);
              if (pinned.length === 0) {
                if (!fromEager) {
                  return (
                    <p className="chat-float-panel-empty">
                      <FaSpinner className="fc-spin" />
                    </p>
                  );
                }
                return <p className="chat-float-panel-empty">{t('chat.no_messages')}</p>;
              }
              // El eager ya viene ordenado del más nuevo al más viejo (consulta
              // DESC); el derivado de `messages` viene ascendente.
              const ordered = fromEager ? pinned : [...pinned].reverse();
              return ordered.map(msg => {
                const sender = msg.sender_id === user?.id
                  ? { name: t('chat.replying_self'), avatar: profile?.avatar_url }
                  : { name: otherUser?.username || '?', avatar: otherUser?.avatar_url };
                return (
                  <button key={msg.id} className="chat-pinned-item" onClick={() => { handleGoToMessage(msg.id); setShowPinnedPanel(false); }}>
                    <FaThumbtack className="chat-pinned-item-icon" />
                    <Avatar src={sender.avatar} alt={sender.name} className="chat-pinned-item-avatar" />
                    <div className="chat-pinned-item-info">
                      <span className="chat-pinned-item-sender">{sender.name}</span>
                      <span className="chat-pinned-item-text">
                        {(() => {
                          if (msg.shared_song?.title) {
                            return <><FaMusic className="chat-list-item-preview-icon" /> {msg.shared_song.title}</>;
                          }
                          const txt = msg.decryptedContent || '';
                          if (!txt) return t('chat.encrypted');
                          const mediaLabel = mediaPreviewLabel(txt);
                          if (mediaLabel) return mediaLabel;
                          return txt;
                        })()}
                      </span>
                    </div>
                  </button>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* ── Profile Card floating panel ── */}
      {showProfileCard && otherUser && (
        <div className="chat-float-panel" style={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: '0' }}>
          <div className={`explore-card${otherUser.accent_color ? ' explore-card--accent' : ''}`}
            style={{
              '--accent-color': otherUser.accent_color || 'transparent',
              '--accent-color-2': otherUser.accent_color_secondary || otherUser.accent_color || 'transparent',
            }}
            onClick={() => { navigate(`/profile/${otherUser.username}`); setShowProfileCard(false); }}
          >
            <div className="explore-card-banner">
              {otherUser.banner_url && (
                <SafeImage
                  className="explore-card-banner-img"
                  src={otherUser.banner_url}
                  alt=""
                  style={getImageStyle(otherUser.banner_position)}
                />
              )}
              <div className="explore-card-overlay" />
            </div>
            <div className="explore-card-body">
              <Avatar
                className="explore-card-avatar"
                src={otherUser.avatar_url}
                alt={otherUser.username || '?'}
                style={getImageStyle(otherUser.avatar_position)}
              />
              <div className="explore-card-info">
                <div className="explore-card-name-row">
                  <span className="explore-card-name">{getDisplayName(otherUser)}</span>
                              <span style={{ fontSize: '0.68rem', fontWeight: 400, opacity: 0.5 }}> · @{otherUser.username || ''}</span>
                  {otherUser.is_private === true && (
                    <span className="explore-card-private-icon" title={t('profile.private_profile')}>
                      <FaLock />
                    </span>
                  )}
                  {Array.isArray(otherUser.roles) && otherUser.roles.some(r => r !== 'user') && (
                    <Badge roles={otherUser.roles} />
                  )}
                  <button
                    className="explore-card-nickname-btn"
                    title={nicknames[otherUser.id] ? (t('chat.edit_nickname') || 'Edit nickname') : (t('chat.set_nickname') || 'Set nickname')}
                    onClick={(e) => { e.stopPropagation(); openNicknameModal(otherUser.id, otherUser); }}
                  >
                    <FaEdit />
                  </button>
                </div>
                <span className="explore-card-followers">
                  {otherUser.followerCount || 0} {otherUser.followerCount === 1 ? t('explore.followers_singular') : t('explore.followers_plural')}
                </span>
                {(otherUser.bio || otherUser.pronouns) && (
                  <p className="explore-card-bio">
                    {otherUser.bio || ''}
                    {otherUser.bio && otherUser.pronouns && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.5 }}> · {otherUser.pronouns}</span>}
                    {!otherUser.bio && otherUser.pronouns && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.5 }}>{otherUser.pronouns}</span>}
                  </p>
                )}
                {Array.isArray(otherUser.interests) && otherUser.interests.length > 0 && (
                  <div className="explore-card-interests">
                    {otherUser.interests.slice(0, 3).map((interest, i) => (
                      <span key={interest} className="explore-card-interest">{interest}</span>
                    ))}
                    {otherUser.interests.length > 3 && (
                      <span className="explore-card-interests-more">show {otherUser.interests.length - 3} more</span>
                    )}
                  </div>
                )}
              </div>
              <div className="explore-card-action">
                <FollowButton targetUserId={otherUser.id} />
              </div>
            </div>
          </div>
        </div>
      )}

      {msgMenu.open && msgMenu.msg && (
        <div
          ref={msgMenuRef}
          className="chat-context-menu"
          style={{ left: msgMenu.x, top: msgMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {msgMenu.msg.sender_id === user.id ? (
            <>
              <button className="chat-context-menu-btn" onClick={() => handleStartReply(msgMenu.msg)}>
                <FaReply />
                <span>{t('chat.reply')}</span>
              </button>
              <button className="chat-context-menu-btn" onClick={handleCopyMessage}>
                <FaCopy />
                <span>{t('chat.copy')}</span>
              </button>
              <button className="chat-context-menu-btn" onClick={handleStartEdit}>
                <FaEdit />
                <span>{t('post.edit')}</span>
              </button>
              <button className="chat-context-menu-btn" onClick={() => { setMsgMenu({ ...msgMenu, open: false }); toggleEmojiPicker(msgMenu.msg.id); }}>
                <FaSmile />
                <span>{t('chat.react')}</span>
              </button>
              <button className="chat-context-menu-btn" onClick={handlePinMessage}>
                <FaThumbtack />
                <span>{msgMenu.msg.is_pinned ? t('post.unpin') : t('post.pin')}</span>
              </button>
              <button className="chat-context-menu-btn chat-context-menu-btn--danger" onClick={handleDeleteMessage}>
                <FaTrash />
                <span>{t('chat.delete_message')}</span>
              </button>
            </>
          ) : (
            <>
              <button className="chat-context-menu-btn" onClick={() => handleStartReply(msgMenu.msg)}>
                <FaReply />
                <span>{t('chat.reply')}</span>
              </button>
              <button className="chat-context-menu-btn" onClick={handleCopyMessage}>
                <FaCopy />
                <span>{t('chat.copy')}</span>
              </button>
              <button className="chat-context-menu-btn" onClick={() => { setMsgMenu({ ...msgMenu, open: false }); toggleEmojiPicker(msgMenu.msg.id); }}>
                <FaSmile />
                <span>{t('chat.react')}</span>
              </button>
              <button className="chat-context-menu-btn" onClick={handlePinMessage}>
                <FaThumbtack />
                <span>{msgMenu.msg.is_pinned ? t('post.unpin') : t('post.pin')}</span>
              </button>
              <button className="chat-context-menu-btn" onClick={handleDeleteMessageForMe}>
                <FaTrash />
                <span>{t('chat.delete_for_me')}</span>
              </button>
            </>
          )}
        </div>
      )}
      <ModalShell
        isOpen={showEditModal && Boolean(editMsgId)}
        onClose={handleCancelEdit}
        onEscape={handleCancelEdit}
        disableBackdropClose={false}
        className="chat-edit-modal"
      >
        <div className="fc-modal-header">
          <div>
            <h3 className="fc-modal-title">{t('chat.edit_title')}</h3>
          </div>
          <div className="fc-modal-header-actions">
            <button type="button" className="fc-modal-save" onClick={handleSaveEdit}>
              {t('common.save')}
            </button>
            <button type="button" className="fc-modal-close" onClick={handleCancelEdit} title={t('common.cancel')}>
              <FaTimes />
            </button>
          </div>
        </div>
        <div className="chat-edit-modal-body">
          <div className="chat-edit-modal-layout">
            <div className="chat-edit-modal-editor">
              <label className="fc-modal-label">
                <span>{t('chat.edit_title')}</span>
                <textarea
                  ref={editRef}
                  className="chat-edit-modal-input"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  rows={4}
                  maxLength={2000}
                  placeholder={t('chat.edit_placeholder')}
                />
              </label>
            </div>
            <div className="chat-edit-modal-preview">
              <div className="chat-edit-modal-preview-header">
                <span className="chat-edit-modal-preview-label">{t('chat.edit_preview')}</span>
              </div>
              <div className="chat-edit-modal-preview-bubble">
                <div className="chat-edit-modal-preview-content">
                  <p className="chat-edit-modal-preview-text">
                    {editText || editContentRef.current || t('chat.encrypted')}
                  </p>
                </div>
                {editMediaUrlRef.current && IMG_RE.test(editMediaUrlRef.current) && (
                  <div className="chat-edit-modal-preview-media">
                    <img
                      src={editMediaUrlRef.current}
                      alt="Media"
                      className="chat-edit-modal-preview-img"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  </div>
                )}

              </div>
            </div>
          </div>
        </div>
      </ModalShell>
      {renderFollowersModal()}

      {/* ── Chat image gallery lightbox ── */}
      {chatGalleryUrls && createPortal(
        <div className="post-card-lightbox" onClick={(e) => { e.stopPropagation(); closeChatGallery(); }}>
          {chatGalleryUrls.length > 1 && (
            <button
              className="post-card-gallery-nav post-card-gallery-nav--prev"
              onClick={(e) => { e.stopPropagation(); goChatGalleryPrev(); }}
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
                src={chatGalleryUrls[chatGalleryIndex]}
                alt={t('post.full_media')}
                className="post-card-gallery-image"
                key={chatGalleryIndex}
                fallbackText={t('post.image_failed')}
              />
            </div>
            <div className="post-card-lightbox-actions">
              {chatGalleryUrls.length > 1 && (
                <span className="post-card-gallery-counter">
                  {chatGalleryIndex + 1} / {chatGalleryUrls.length}
                </span>
              )}
              <Tooltip text={t('post.open_new_tab')} placement="bottom">
                <a
                  href={chatGalleryUrls[chatGalleryIndex]}
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
                  href={chatGalleryUrls[chatGalleryIndex]}
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
                  onClick={closeChatGallery}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </Tooltip>
            </div>

            {/* ── Thumbnail strip ── */}
            {chatGalleryUrls.length > 1 && (
              <div className="post-card-gallery-thumbnails">
                {chatGalleryUrls.map((url, i) => (
                  <button
                    key={url}
                    className={`post-card-gallery-thumb ${i === chatGalleryIndex ? 'post-card-gallery-thumb--active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setChatGalleryIndex(i); }}
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

          {chatGalleryUrls.length > 1 && (
            <button
              className="post-card-gallery-nav post-card-gallery-nav--next"
              onClick={(e) => { e.stopPropagation(); goChatGalleryNext(); }}
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

      {confirmExternalLink && createPortal(
        <ConfirmModal
          message={t('chat.external_link_warning') || 'This link will take you to an external website. Do you want to continue?'}
          onConfirm={executeExternalLink}
          onCancel={handleCancelExternalLink}
        />,
        document.body
      )}

      {confirmBlock && createPortal(
        <ConfirmModal
          message={getCachedBlockStatus(user?.id, otherUser?.id) === true
            ? (t('block.confirm_unblock', { user: otherUser?.username || 'user' }) || 'Unblock this user?')
            : t('block.confirm_block', { user: otherUser?.username || 'user' })}
          onConfirm={() => handleBlockFromChat(otherUser)}
          onCancel={() => setConfirmBlock(false)}
        />,
        document.body
      )}

      {nicknameModal.open && nicknameModal.userData && (
        <NicknameModal
          userData={nicknameModal.userData}
          currentName={nicknameModal.currentName}
          onClose={() => setNicknameModal({ open: false, targetUserId: null, currentName: '', userData: null })}
          onSaved={(name) => {
            const tid = nicknameModal.targetUserId;
            if (!tid) return;
            setNicknames(prev => {
              const next = { ...prev };
              if (name) {
                next[tid] = name;
              } else {
                delete next[tid];
              }
              return next;
            });
          }}
        />
      )}

      {bubbleColorModal.open && bubbleColorModal.convId && (() => {
        const conv = conversations.find(c => c.id === bubbleColorModal.convId);
        return (
          <BubbleColorModal
            conversationId={bubbleColorModal.convId}
            currentColors={bubbleColors[bubbleColorModal.convId] || {}}
            otherName={conv?.otherUser?.displayname || conv?.otherUser?.username || ''}
            onClose={() => setBubbleColorModal({ open: false, convId: null })}
            onSaved={(colors) => {
              setBubbleColors(prev => ({ ...prev, [bubbleColorModal.convId]: colors }));
            }}
          />
        );
      })()}

      {/* Fondo del chat: modal ligado a la conversación abierta (privado) */}
      {chatBackgroundModal.open && chatBackgroundModal.convId && (
        <ChatBackgroundModal
          conversationId={chatBackgroundModal.convId}
          currentUrl={chatBackgrounds[chatBackgroundModal.convId] || ''}
          onClose={() => setChatBackgroundModal({ open: false, convId: null })}
          onSaved={(url) => {
            setChatBackgrounds((prev) => {
              const next = { ...prev };
              if (url) next[chatBackgroundModal.convId] = url;
              else delete next[chatBackgroundModal.convId];
              return next;
            });
          }}
        />
      )}
    </div>
  );
}
