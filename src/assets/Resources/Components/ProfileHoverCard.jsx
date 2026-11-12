import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { dbPublic } from '../../services/supabaseclient';
import { getFollowCounts } from '../../services/followService';
import { getCachedNicknames } from '../../services/chatService';
import ExploreCard from './ExploreCard';
import './css/profileHoverCard.css';

const PROFILE_FIELDS =
  'id, username, displayname, avatar_url, banner_url, banner_position, avatar_position, bio, pronouns, roles, is_private, interests, accent_color, accent_color_secondary, show_accent_explore';

const SHOW_DELAY = 220;
const HIDE_DELAY = 160;
const CARD_WIDTH = 340;
const CARD_GAP = 10;
const MEMO_TTL = 5 * 60 * 1000;

// Caché del módulo: pasar el ratón por varios avatares del mismo usuario no
// vuelve a consultar. Las peticiones en curso se comparten (hover rápido).
const memo = new Map();
const pending = new Map();

async function loadCard(userId) {
  const hit = memo.get(userId);
  if (hit && Date.now() - hit.ts < MEMO_TTL) return hit;

  if (pending.has(userId)) return pending.get(userId);

  const job = (async () => {
    const [profileRes, counts] = await Promise.all([
      dbPublic.from('profiles').select(PROFILE_FIELDS).eq('id', userId).maybeSingle(),
      getFollowCounts(userId).catch(() => ({ followers: 0, following: 0 })),
    ]);
    if (!profileRes?.data) return null;
    const entry = { profile: profileRes.data, counts, ts: Date.now() };
    memo.set(userId, entry);
    return entry;
  })();

  pending.set(userId, job);
  try {
    return await job;
  } finally {
    pending.delete(userId);
  }
}

/**
 * ProfileHoverCard — muestra la ExploreCard del usuario al pasar el ratón
 * (o al enfocar con teclado) por el avatar que envuelve.
 *
 * - El contenedor no altera el layout: solo envuelve el avatar.
 * - La card va en un portal y es interactiva (seguir, abrir el perfil).
 * - Se oculta al salir, al hacer scroll o con Escape.
 */
export default function ProfileHoverCard({ userId, children, className = '', placement = 'auto' }) {
  const { user } = useAuth();
  const { showAccent } = useI18n();
  const [card, setCard] = useState(null);
  const triggerRef = useRef(null);
  const showTimer = useRef(null);
  const hideTimer = useRef(null);
  const aliveRef = useRef(true);
  const hoverRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    };
  }, []);

  const nicknames = (user?.id && getCachedNicknames(user.id)) || {};
  const getDisplayName = (profile) =>
    nicknames[profile?.id] || profile?.displayname || profile?.username;

  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);

  const hide = useCallback(() => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    setCard(null);
  }, []);

  const scheduleHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(hide, HIDE_DELAY);
  }, [hide]);

  const reveal = useCallback(async () => {
    const el = triggerRef.current;
    if (!el) return;
    const entry = await loadCard(userId);
    if (!entry || !aliveRef.current || !hoverRef.current || !triggerRef.current) return;

    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(CARD_WIDTH, window.innerWidth - 24);
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - width / 2, 12),
      window.innerWidth - width - 12
    );
    const spaceBelow = window.innerHeight - rect.bottom - CARD_GAP - 12;
    const spaceAbove = rect.top - CARD_GAP - 12;
    const placeAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(placeAbove ? spaceAbove : spaceBelow, 180);
    let style = placeAbove
      ? { left, width, maxHeight, bottom: window.innerHeight - rect.top + CARD_GAP }
      : { left, width, maxHeight, top: rect.bottom + CARD_GAP };

    // `placement="left"`: la card sale hacia la izquierda, alineada con la fila
    // (rails/paneles pegados al borde derecho: debajo taparía la lista).
    if (placement === 'left') {
      const roomLeft = rect.left - 12;
      if (roomLeft >= 220) {
        const leftPos = Math.max(rect.left - width - CARD_GAP, 12);
        const topPos = Math.max(12, Math.min(rect.top, window.innerHeight - 240));
        style = { left: leftPos, width, maxHeight: window.innerHeight - topPos - 12, top: topPos };
      } else {
        // Sin sitio a la izquierda: se comporta como siempre.
        style = placeAbove
          ? { left, width, maxHeight, bottom: window.innerHeight - rect.top + CARD_GAP }
          : { left, width, maxHeight, top: rect.bottom + CARD_GAP };
      }
    }

    setCard({ ...entry, style });
  }, [userId, placement]);

  const handleEnter = useCallback(() => {
    cancelHide();
    hoverRef.current = true;
    if (!userId || card) return;
    if (!window.matchMedia('(hover: hover)').matches) return;
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(reveal, SHOW_DELAY);
  }, [cancelHide, card, reveal, userId]);

  // Con teclado no se espera: el foco es intencionado.
  const handleFocus = useCallback(() => {
    cancelHide();
    hoverRef.current = true;
    if (!userId || card) return;
    clearTimeout(showTimer.current);
    reveal();
  }, [cancelHide, card, reveal, userId]);

  useEffect(() => {
    if (!card) return;
    const onScroll = () => setCard(null);
    const onKey = (e) => e.key === 'Escape' && setCard(null);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('keydown', onKey);
    };
  }, [card]);

  return (
    <span
      ref={triggerRef}
      className={`profile-hover-trigger${className ? ` ${className}` : ''}`}
      onMouseEnter={handleEnter}
      onMouseLeave={() => { hoverRef.current = false; scheduleHide(); }}
      onFocus={handleFocus}
      onBlur={() => { hoverRef.current = false; scheduleHide(); }}
    >
      {children}

      {card && createPortal(
        <div
          className="profile-hover-card"
          style={card.style}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <ExploreCard
            profile={card.profile}
            counts={card.counts}
            isOwnProfile={user?.id === card.profile.id}
            showAccent={showAccent && (card.profile.show_accent_explore ?? true)}
            getDisplayName={getDisplayName}
          />
        </div>,
        document.body
      )}
    </span>
  );
}
