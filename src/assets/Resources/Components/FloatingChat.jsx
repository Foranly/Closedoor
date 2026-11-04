import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { FaCommentDots, FaTimes, FaChevronLeft, FaPaperPlane, FaExpand, FaSpinner, FaComments, FaReply, FaPen } from 'react-icons/fa';
import CreatePostModal from './CreatePostModal';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { NotificationContext } from '../../../context/NotificationContext';
import { getSessionItem, setSessionItem } from '../../services/secureStorage';
import {
  getConversations,
  getMessages,
  decryptMessage,
  subscribeToMessages,
  sendMessage,
  markAsRead,
  getBubbleColors,
  getCachedBubbleColors,
  cacheBubbleColors,
} from '../../services/chatService';
import { getContrastFromHex } from '../../services/colorExtractor';
import { detectMediaFromContent, getTimeAgo } from '../../services/helpers';
import { supabase } from '../../services/supabaseclient';
import { getPost } from '../../services/postService';
import Avatar from './Avatar';
import ChatSongCard from './ChatSongCard';
import ChatCommunityCard from './ChatCommunityCard';
import ChatSharedPostCard from './ChatSharedPostCard';
import './css/floatingChat.css';

const HIDDEN_ROUTES = ['/chat', '/login', '/register', '/auth/callback'];

function convCacheKey(userId) {
  return `chatConvsCache_${userId}`;
}

function readCachedConvs(userId) {
  if (!userId) return [];
  try {
    const cached = getSessionItem(convCacheKey(userId));
    return Array.isArray(cached) ? cached : [];
  } catch {
    return [];
  }
}

function peerName(conv) {
  return conv?.otherUser?.displayname || conv?.otherUser?.username || '…';
}

/**
 * FloatingChat — lanzador de chats recientes + ventana de chat flotante.
 *
 * - Abajo a la derecha (encima de la barra móvil): burbuja con el contador de
 *   no leídos y, apilados, los avatares de las conversaciones más recientes
 *   (estilo Instagram/Facebook). Al pulsar uno se abre ese chat al instante.
 * - La ventana NO saca al usuario de la página: lista de conversaciones y
 *   conversación completa (leer/enviar) con realtime, cifrado por usuario y
 *   markAsRead, igual que Chat.jsx pero en miniatura.
 * - Se oculta en /Chat (ahí ya está el chat completo) y en rutas de auth.
 * - Los datos de la lista salen del caché de sesión que mantiene
 *   NotificationContext; el fetch real sólo ocurre al abrir o al llegar un
 *   mensaje nuevo con la ventana abierta.
 */
export default function FloatingChat() {
  const { user } = useAuth();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const notif = useContext(NotificationContext);

  const [open, setOpen] = useState(false);
  // Recientes: solo se muestran en home y tras el primer clic en el lanzador.
  const [showRecents, setShowRecents] = useState(false);
  const [view, setView] = useState('list'); // 'list' | 'thread'
  const [activeId, setActiveId] = useState(null);
  const [showPost, setShowPost] = useState(false);
  const [convs, setConvs] = useState(() => readCachedConvs(user?.id));
  const [listLoaded, setListLoaded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // Comunidades de las invitaciones compartidas (se piden una vez por id).
  const [sharedCommunities, setSharedCommunities] = useState({});
  // Posts compartidos, igual: se piden una vez por id y se cachean.
  const [sharedPosts, setSharedPosts] = useState({});
  // Colores de burbuja personalizados (chat_bubble_settings), igual que el
  // chat completo: { [conversation_id]: { own, other } }. Los de la BD van
  // aquí; la caché se lee aparte para pintar al instante.
  const [bubbleColorsDb, setBubbleColorsDb] = useState({});
  const listRef = useRef(null);
  const threadRef = useRef(null);
  const activeIdRef = useRef(null);
  const pendingAppStylesRef = useRef(false);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  const userId = user?.id;
  const refreshVersion = notif.conversationRefreshVersion || 0;
  const unreadTotal = notif.unreadChatCount || 0;

  const route = String(pathname || '').toLowerCase();
  const hidden = !userId || HIDDEN_ROUTES.some((r) => route === r || route.startsWith(`${r}/`));

  const activeConv = useMemo(() => convs.find((c) => c.id === activeId) || null, [convs, activeId]);

  // Caché + BD: lo que haya en la BD manda, la caché rellena el primer pintado.
  const bubbleColors = useMemo(
    () => ({ ...(getCachedBubbleColors(userId) || {}), ...bubbleColorsDb }),
    [userId, bubbleColorsDb]
  );

  // Variables CSS con los colores de burbuja del hilo abierto (mismos nombres
  // que usa chat.css, así el panel pinta igual que el chat completo).
  const threadBubbleVars = useMemo(() => {
    const colors = bubbleColors[activeId] || {};
    const style = {};
    if (colors.own) {
      style['--chat-bubble-own'] = colors.own;
      style['--chat-bubble-own-text'] = getContrastFromHex(colors.own);
    }
    if (colors.other) {
      style['--chat-bubble-other'] = colors.other;
      style['--chat-bubble-other-text'] = getContrastFromHex(colors.other);
    }
    return style;
  }, [bubbleColors, activeId]);
  const hiddenForPost = String(pathname || '').toLowerCase();
  const hiddenOnCreate = HIDDEN_ROUTES.some(
    (r) => hiddenForPost === r || hiddenForPost.startsWith(`${r}/`)
  );

  const hiddenInPostWorld =
    route === '/' ||
    route === '/home' ||
    route.startsWith('/c/') ||
    route === '/profile'; // no en tu propio perfil (/profile), pero sí en
  // perfiles ajenos (/profile/usuario2), donde no hay otro botón de crear.
  const isCreateVisible =
    userId && !hiddenOnCreate && !hiddenInPostWorld;
  const recent = useMemo(() => convs.slice(0, 3), [convs]);
  // Solo en home (y con el panel cerrado) se ofrece el aviatorio de recientes.
  const isHomeRoute = route === '/' || route === '/home';
  const recentsVisible = !open && showRecents && isHomeRoute && recent.length > 0;

  // ── Al tener usuario (login/restauración de sesión), hidratar los recientes
  // desde el caché de sesión. Se hace en microtask para no encadenar renders
  // síncronos dentro del efecto. ──
  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      const cached = readCachedConvs(userId);
      if (cached.length) setConvs((prev) => (prev.length ? prev : cached));
    });
    return () => { cancelled = true; };
  }, [userId]);

  const loadConvs = useCallback(async () => {
    if (!userId) return;
    try {
      const list = await getConversations(userId);
      setConvs(list);
      setListLoaded(true);
      try { setSessionItem(convCacheKey(userId), list); } catch { /* quota */ }
    } catch (err) {
      console.warn('[FloatingChat] load conversations failed:', err);
      setListLoaded(true);
    }
  }, [userId]);

  // ── Con el panel abierto, refrescar la lista real al abrir o al llegar un
  // mensaje nuevo (NotificationContext sube conversationRefreshVersion) ──
  useEffect(() => {
    if (!userId || !open) return undefined;
    let cancelled = false;
    // Diferido un tick: el fetch es asíncrono y así no se encadena un render
    // síncrono dentro del propio efecto (regla set-state-in-effect).
    Promise.resolve().then(() => {
      if (!cancelled) loadConvs();
    });
    return () => { cancelled = true; };
  }, [userId, open, refreshVersion, loadConvs]);

  const loadThread = useCallback(async (convId) => {
    if (!convId || !userId) return;
    setLoadingThread(true);
    try {
      const raw = await getMessages(convId, 40);
      const visible = raw.filter((m) => !m.deleted_for?.includes(userId));
      const decrypted = await Promise.all(visible.map(async (m) => ({
        ...m,
        decryptedContent: await decryptMessage(m, userId),
      })));
      if (activeIdRef.current !== convId) return;
      setMessages(decrypted);
      markAsRead(convId, userId).catch(() => {});
      notif.refreshChatUnread?.();
      setConvs((prev) => prev.map((c) => (c.id === convId ? { ...c, unreadCount: 0 } : c)));
    } catch (err) {
      console.warn('[FloatingChat] load messages failed:', err);
    } finally {
      setLoadingThread(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const openThread = useCallback((conv) => {
    if (!conv?.id) return;
    setShowRecents(false);
    setOpen(true);
    setView('thread');
    setActiveId(conv.id);
    setMessages([]);
    setInput('');
    loadThread(conv.id);
  }, [loadThread]);

  // ── Abrir/cerrar panel (el fetch de la lista lo dispara el efecto de arriba) ──
  // En home el primer clic despliega los chats recientes y el segundo abre el
  // panel; fuera de home el lanzador abre el panel directamente.
  const toggleOpen = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    const canShowRecents = isHomeRoute && recent.length > 0;
    if (canShowRecents && !showRecents) {
      setShowRecents(true);
      return;
    }
    setShowRecents(false);
    setView('list');
    setActiveId(null);
    setOpen(true);
    notif.refreshChatUnread?.();
  }, [open, notif, isHomeRoute, recent.length, showRecents]);

  // Al salir de home se recogen los recientes (microtask: sin setState síncrono
  // dentro del efecto).
  useEffect(() => {
    if (isHomeRoute || !showRecents) return undefined;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setShowRecents(false);
    });
    return () => { cancelled = true; };
  }, [isHomeRoute, showRecents]);

  // ── UseLayoutEffect para inyectar los estilos de respaldo de las cards de
  // chat, de forma que estén disponibles antes de que la app inyecte las de
  // .chat-message-shared-*. Esto evita que al abrir primero la flotante, las
  // tarjetas de canciones, invitaciones y posts queden invisibles.
  useLayoutEffect(() => {
    if (!userId) return;

    if (document.getElementById('app-styles')) {
      pendingAppStylesRef.current = false;
      return;
    }

    const sheet = document.createElement('style');
    sheet.id = 'pending-app-styles-float-backup';
    sheet.textContent = `
      .chat-message-shared-song,
      .chat-message-shared-community,
      .chat-message-shared-post {
        margin-bottom: 0;
        width: 280px;
        flex-shrink: 0;
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(sheet);
    pendingAppStylesRef.current = true;

    return () => {
      const el = document.getElementById('pending-app-styles-float-backup');
      if (el) el.remove();
      pendingAppStylesRef.current = false;
    };
  }, [userId]);

  // ── Realtime de la conversación abierta ──
  useEffect(() => {
    if (!open || view !== 'thread' || !activeId || !userId) return;
    const channel = subscribeToMessages(
      activeId,
      async (msg, eventType) => {
        if (activeIdRef.current !== activeId) return;
        const content = await decryptMessage(msg, userId);
        if (eventType === 'UPDATE') {
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...msg, decryptedContent: content } : m)));
          return;
        }
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, { ...msg, decryptedContent: content }];
        });
        if (msg.sender_id !== userId) markAsRead(activeId, userId).catch(() => {});
      },
      (deletedId) => setMessages((prev) => prev.filter((m) => m.id !== deletedId))
    );
    return () => {
      try { channel?.unsubscribe(); } catch { /* ya cerrado */ }
    };
  }, [open, view, activeId, userId]);

  // ── Colores de burbuja del hilo abierto ──
  // Se leen de chat_bubble_settings (misma tabla que Chat.jsx). Primero la
  // caché para pintar al instante y luego la BD para refrescar.
  useEffect(() => {
    if (!userId || !open) return undefined;

    let cancelled = false;
    (async () => {
      try {
        const map = await getBubbleColors(userId);
        if (cancelled) return;
        setBubbleColorsDb(map);
      } catch {
        // Sin conexión o RLS: se queda con lo cacheado.
      }
    })();

    return () => { cancelled = true; };
  }, [userId, open]);

  // ── Cambios de color en tiempo real ──
  // Misma tabla que Chat.jsx (chat_bubble_settings): así el panel flotante
  // refleja el color al instante, sin reiniciar la app ni reabrir el panel.
  useEffect(() => {
    if (!userId) return undefined;

    const channel = supabase
      .channel(`fc-bubble-colors-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'chat_bubble_settings', filter: `user_id=eq.${userId}` },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const { conversation_id, own_color, other_color } = payload.new || {};
            if (!conversation_id) return;
            setBubbleColorsDb((prev) => ({
              ...prev,
              [conversation_id]: { own: own_color || null, other: other_color || null },
            }));
          } else if (payload.eventType === 'DELETE') {
            const conversationId = payload.old?.conversation_id;
            if (!conversationId) return;
            setBubbleColorsDb((prev) => {
              const next = { ...prev };
              delete next[conversationId];
              return next;
            });
          }
        }
      )
      .subscribe();

    return () => {
      try { supabase.removeChannel(channel); } catch { /* ya cerrado */ }
    };
  }, [userId]);

  // Mantiene la caché al día con lo que llega de la BD (incluido realtime),
  // sin perder las conversaciones que ya estaban cacheadas.
  useEffect(() => {
    if (!userId || !Object.keys(bubbleColorsDb).length) return;
    cacheBubbleColors(userId, { ...(getCachedBubbleColors(userId) || {}), ...bubbleColorsDb });
  }, [userId, bubbleColorsDb]);

  // ── Comunidades de las invitaciones del hilo abierto ──
  useEffect(() => {
    const missing = [...new Set(messages.map((m) => m.shared_community_id).filter(Boolean))]
      .filter((id) => !sharedCommunities[id]);
    if (!missing.length) return undefined;

    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.from('communities').select('*').in('id', missing);
        if (cancelled || !data?.length) return;
        setSharedCommunities((prev) => {
          const next = { ...prev };
          for (const community of data) next[community.id] = community;
          return next;
        });
      } catch (err) {
        console.warn('[FloatingChat] load shared communities failed:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [messages, sharedCommunities]);

  // ── Posts compartidos del hilo abierto ──
  useEffect(() => {
    const missing = [...new Set(messages.map((m) => m.shared_post_id).filter(Boolean))]
      .filter((id) => !sharedPosts[id]);
    if (!missing.length) return undefined;

    let cancelled = false;
    (async () => {
      const loaded = {};
      await Promise.all(missing.map(async (id) => {
        try {
          loaded[id] = await getPost(id);
        } catch {
          // Post borrado o inaccesible: la card se queda en su esqueleto.
        }
      }));
      if (cancelled || !Object.keys(loaded).length) return;
      setSharedPosts((prev) => ({ ...prev, ...loaded }));
    })();

    return () => { cancelled = true; };
  }, [messages, sharedPosts]);

  // ── Scroll al final al llegar/abrir mensajes ──
  useEffect(() => {
    if (!open || view !== 'thread') return;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open, view, loadingThread]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeId || !userId || sending || !activeConv?.otherUser?.id) return;
    const tempId = crypto.randomUUID();
    const optimistic = {
      id: tempId,
      conversation_id: activeId,
      sender_id: userId,
      decryptedContent: text,
      created_at: new Date().toISOString(),
      _optimistic: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setInput('');
    setSending(true);
    try {
      const sent = await sendMessage(activeId, userId, text, [activeConv.otherUser.id]);
      // El INSERT de realtime puede llegar antes que esta respuesta: se quita
      // el mensaje optimista y no se duplica el que ya esté en la lista.
      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempId);
        if (withoutTemp.some((m) => m.id === sent.id)) return withoutTemp;
        return [...withoutTemp, { ...sent, decryptedContent: text }];
      });
      const preview = text.length > 80 ? `${text.slice(0, 80)}...` : text;
      setConvs((prev) => prev
        .map((c) => (c.id === activeId ? { ...c, last_message_text: preview, last_message_at: sent.created_at || new Date().toISOString() } : c)));
    } catch (err) {
      console.warn('[FloatingChat] send failed:', err);
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(text);
    } finally {
      setSending(false);
    }
  }, [input, activeId, userId, sending, activeConv]);

  if (hidden) return null;

  // «Abrir en Chat» aterriza en la conversación que está abierta (?c=<id>).
  const goFullChat = () => {
    const convId = activeId;
    setOpen(false);
    navigate(convId ? `/Chat?c=${encodeURIComponent(convId)}` : '/Chat');
  };

  // Función inline que normaliza las reacciones de la BD (JSONB { [user_id]: emoji })
  // al formato [{ type, user_ids }] que pinta la burbuja del panel flotante.
  const fromDbReactions = (reactions) => {
    if (!reactions || typeof reactions !== 'object') return {};
    const grouped = {};
    for (const [uid, emoji] of Object.entries(reactions)) {
      if (!emoji) continue;
      (grouped[emoji] ??= []).push(uid);
    }
    return grouped;
  };

  // Texto corto para el preview de una respuesta citada (misma idea que
  // Chat.jsx: canción → título, imagen → "Image", resto → recorte).
  const previewOf = (msg) => {
    if (msg.shared_song?.title) return `🎵 ${msg.shared_song.title}`;
    const txt = (msg.decryptedContent || '').trim();
    if (!txt) return t('chat.encrypted') || 'Encrypted';
    const { imageUrl } = detectMediaFromContent(txt) || {};
    if (imageUrl) return 'Image';
    return txt.length > 60 ? `${txt.slice(0, 60)}...` : txt;
  };

  // Una burbuja puede traer varias cosas: respuesta citada, canción,
  // invitación a comunidad, imagen y/o texto. Antes solo se pintaba
  // decryptedContent, así que todo lo demás salía como globo vacío.
  const renderMessageBody = (msg) => {
    const content = (msg.decryptedContent || '').trim();
    const { imageUrl } = content ? (detectMediaFromContent(content) || {}) : {};
    const replyTarget = msg.reply_to ? messages.find((m) => m.id === msg.reply_to) : null;
    const community = msg.shared_community_id ? sharedCommunities[msg.shared_community_id] : null;
    const text = imageUrl ? content.replace(imageUrl, '').trim() : content;

    return (
      <>
        {replyTarget && (
          <div className="fc-msg-reply">
            <FaReply className="fc-msg-reply-icon" />
            <div className="fc-msg-reply-body">
              <span className="fc-msg-reply-author">
                {replyTarget.sender_id === userId ? (t('chat.replying_self') || 'You') : peerName(activeConv)}
              </span>
              <span className="fc-msg-reply-text">{previewOf(replyTarget)}</span>
            </div>
          </div>
        )}

        {msg.shared_community_id && (
          <ChatCommunityCard
            community={community}
            inviteToken={msg.shared_invite_token}
            isOwn={msg.sender_id === userId}
          />
        )}

        {msg.shared_post_id && (
          <ChatSharedPostCard
            post={sharedPosts[msg.shared_post_id]}
            postId={msg.shared_post_id}
          />
        )}

        {msg.shared_song && <ChatSongCard song={msg.shared_song} />}

        {imageUrl && <img className="fc-msg-img" src={imageUrl} alt="" loading="lazy" />}
        {text ? <span>{text}</span> : null}
      </>
    );
  };

  // Reacciones fuera de la burbuja, igual que en el chat completo.
  const renderReactions = (msg) => {
    const reactions = fromDbReactions(msg.reactions);
    if (Object.keys(reactions).length === 0) return null;
    return (
      <div className="fc-msg-reactions">
        {Object.entries(reactions).map(([emoji, uids]) => (
          <span key={emoji} className="fc-msg-reaction">
            {emoji}
            {uids.length > 1 && (
              <span className="fc-msg-reaction-count">{uids.length}</span>
            )}
          </span>
        ))}
      </div>
    );
  };

  return createPortal(
    <div className={`fc-dock${open ? ' fc-dock--open' : ''}`}>
      {/* ── Ventana flotante ── */}
      {open && (
        <div className="fc-panel" role="dialog" aria-label={t('chat.title') || 'Chat'}>
          <div
            className="fc-panel-header"
            style={{ '--fc-user-accent': open && activeConv?.otherUser?.accent_color || undefined }}
          >
            {view === 'thread' ? (
              <>
                <button
                  type="button"
                  className="fc-panel-icon-btn"
                  onClick={() => { setView('list'); setActiveId(null); }}
                  title={t('chat.dock_back') || 'Back'}
                >
                  <FaChevronLeft />
                </button>
                <Avatar
                  src={activeConv?.otherUser?.avatar_url}
                  alt={peerName(activeConv)}
                  className="fc-panel-peer-avatar"
                  userId={activeConv?.otherUser?.id}
                />
                <div className="fc-panel-peer">
                  <span className="fc-panel-peer-name">{peerName(activeConv)}</span>
                  {activeConv?.otherUser?.username && (
                    <span className="fc-panel-peer-handle">@{activeConv.otherUser.username}</span>
                  )}
                </div>
              </>
            ) : (
              <>
                <span className="fc-panel-icon-static"><FaComments /></span>
                <span className="fc-panel-title">{t('chat.title') || 'Chat'}</span>
              </>
            )}
            <div className="fc-panel-header-actions">
              <button
                type="button"
                className="fc-panel-icon-btn"
                onClick={goFullChat}
                title={t('chat.dock_open_full') || 'Open in Chat'}
              >
                <FaExpand />
              </button>
              <button
                type="button"
                className="fc-panel-icon-btn"
                onClick={() => setOpen(false)}
                title={t('chat.dock_close') || 'Close'}
              >
                <FaTimes />
              </button>
            </div>
          </div>

          {view === 'list' ? (
            <div className="fc-list" ref={listRef}>
              {!listLoaded && convs.length === 0 ? (
                <div className="fc-list-state"><FaSpinner className="fc-spin" /></div>
              ) : convs.length === 0 ? (
                <div className="fc-list-state">
                  <p className="fc-list-state-title">{t('chat.empty') || 'No conversations yet'}</p>
                  <p className="fc-list-state-sub">{t('chat.empty_sub') || ''}</p>
                </div>
              ) : (
                convs.map((conv) => (
                  <button
                    type="button"
                    key={conv.id}
                    className="fc-item"
                    style={{ '--fc-user-accent': conv.otherUser?.accent_color || undefined }}
                    onClick={() => openThread(conv)}
                  >
                    <Avatar
                      src={conv.otherUser?.avatar_url}
                      alt={peerName(conv)}
                      className="fc-item-avatar"
                      userId={conv.otherUser?.id}
                    />
                    <div className="fc-item-body">
                      <span className="fc-item-top">
                        <span className="fc-item-name">{peerName(conv)}</span>
                        <span className="fc-item-time">
                          {getTimeAgo(t, locale, conv.last_message_at || conv.updated_at)}
                        </span>
                      </span>
                      <span className="fc-item-preview">{conv.last_message_text || ''}</span>
                    </div>
                    {conv.unreadCount > 0 && (
                      <span className="fc-item-unread">{conv.unreadCount > 99 ? '99+' : conv.unreadCount}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          ) : (
            <>
              <div className="fc-thread" ref={threadRef} style={threadBubbleVars}>
                {loadingThread && messages.length === 0 ? (
                  <div className="fc-list-state"><FaSpinner className="fc-spin" /></div>
                ) : messages.length === 0 ? (
                  <div className="fc-list-state">
                    <p className="fc-list-state-sub">{t('chat.no_messages') || 'No messages yet'}</p>
                  </div>
                ) : (
                  messages.map((msg) => {
                    const own = msg.sender_id === userId;
                    // Sin texto y con tarjeta (canción / invitación) el globo no
                    // se pinta: la card va sola, igual que en el chat completo.
                    const isBare = !(msg.decryptedContent || '').trim()
                      && !!(msg.shared_song || msg.shared_community_id || msg.shared_post_id);
                    return (
                      <div
                        key={msg.id}
                        className={`fc-msg${own ? ' fc-msg--own' : ''}${msg._optimistic ? ' fc-msg--pending' : ''}`}
                      >
                        <div className={`fc-msg-bubble${isBare ? ' fc-msg-bubble--bare' : ''}`}>{renderMessageBody(msg)}</div>
                        {renderReactions(msg)}
                        <span className="fc-msg-time">{getTimeAgo(t, locale, msg.created_at)}</span>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="fc-compose">
                <textarea
                  className="fc-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={t('chat.input_placeholder') || 'Write a message...'}
                  rows={1}
                  maxLength={2000}
                />
                <button
                  type="button"
                  className="fc-send"
                  onClick={send}
                  disabled={!input.trim() || sending}
                  title={t('chat.dock_send') || 'Send'}
                >
                  {sending ? <FaSpinner className="fc-spin" /> : <FaPaperPlane />}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Lanzador + chats recientes ── */}
      <div className={`fc-dock-recents${recentsVisible ? '' : ' fc-dock-recents--hidden'}`} aria-hidden={!recentsVisible}>
        {recent.map((conv) => (
          <button
            type="button"
            key={conv.id}
            className="fc-dock-recent"
            style={{ '--fc-user-accent': conv.otherUser?.accent_color || undefined }}
            onClick={() => openThread(conv)}
            title={peerName(conv)}
          >
            <Avatar
              src={conv.otherUser?.avatar_url}
              alt={peerName(conv)}
              className="fc-dock-recent-avatar"
              userId={conv.otherUser?.id}
            />
            {conv.unreadCount > 0 && (
              <span className="fc-dock-recent-badge">{conv.unreadCount > 9 ? '9+' : conv.unreadCount}</span>
            )}
          </button>
        ))}
      </div>

      <div className="fc-dock-row">
        <button
          type="button"
          className={`fc-dock-create${isCreateVisible ? '' : ' fc-dock-create--hidden'}`}
          onClick={() => setShowPost(true)}
          title={t('chat.dock_create_post') || 'New post'}
          aria-hidden={!isCreateVisible}
          tabIndex={isCreateVisible ? 0 : -1}
        >
          <FaPen />
        </button>
        <button
          type="button"
          className="fc-dock-launcher"
          onClick={toggleOpen}
          title={open ? (t('chat.dock_close') || 'Close') : (t('chat.title') || 'Chat')}
          aria-expanded={open}
        >
          {open ? <FaTimes /> : <FaCommentDots />}
          {!open && unreadTotal > 0 && (
            <span className="fc-dock-badge">{unreadTotal > 99 ? '99+' : unreadTotal}</span>
          )}
        </button>
      </div>
      {showPost && <CreatePostModal isOpen={showPost} onClose={() => setShowPost(false)} userId={userId} />}
    </div>,
    document.body
  );
}
