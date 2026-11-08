import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LiveKitRoom, RoomAudioRenderer, useLocalParticipant } from '@livekit/components-react';
import { FaPhone, FaPhoneSlash, FaMicrophone, FaMicrophoneSlash, FaSpinner, FaWindowMinimize, FaExpand } from 'react-icons/fa';
import Avatar from './Avatar';
import { getLiveKitToken } from '../../services/callService';
// Estilos propios: el overlay se monta en CallProvider (App), así que no puede
// depender de chat.css, que solo se carga en el chunk lazy de /chat.
import './css/callOverlay.css';

/**
 * CallOverlay — UI de llamada de voz (LiveKit Cloud).
 *
 * Estados:
 *  - ringing + role=caller : "Llamando..." + botón colgar
 *  - ringing + role=callee : "te está llamando" + aceptar/rechazar
 *  - connecting            : pidiendo token a /api/livekit-token
 *  - active                : LiveKitRoom con audio, mute, timer y colgar
 *
 * Minimizado:
 *  - Botón "minimizar" (esquina superior derecha) disponible en llamada
 *    activa o mientras el caller espera el ring.
 *  - Al minimizar, el overlay pasa a ser una ventana flotante pequeña y
 *    arrastrable (drag por pointer events, sin librería). El LiveKitRoom
 *    se mantiene MONTADO (solo se oculta visualmente) para que el audio
 *    no se corte mientras navegas por la app.
 *
 * Props:
 *  - call    : fila de la tabla `calls`
 *  - role    : 'caller' | 'callee'
 *  - peer    : perfil del otro usuario (avatar/nombre)
 *  - status  : 'ringing' | 'active' | 'ended' | 'missed' | 'declined'
 *  - onAccept, onDecline, onClose
 */
export default function CallOverlay({ call, role, peer, status, onAccept, onDecline, onClose, t }) {
  const [conn, setConn] = useState(null); // { token, url }
  // tokenError: null = sin error | string = mensaje real devuelto por /api/livekit-token
  const [tokenError, setTokenError] = useState(null);

  // ── Minimizado: ventana flotante arrastrable ──
  const [minimized, setMinimized] = useState(false);
  const [dragPos, setDragPos] = useState(null); // { x, y } tras arrastrar (null = posición por defecto CSS)
  const [seconds, setSeconds] = useState(0);
  const overlayRef = useRef(null);

  // ── Al pasar a 'active', pedir el token de LiveKit ──
  useEffect(() => {
    if (status !== 'active' || conn || !call?.room_name) return;
    let cancelled = false;
    setTokenError(null);
    getLiveKitToken(call.room_name)
      .then((data) => { if (!cancelled) setConn(data); })
      .catch((err) => {
        const msg = err?.message || String(err || 'Could not start the call');
        if (!cancelled) setTokenError(msg);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, call?.room_name]);

  // ── Timer de la llamada activa (compartido entre vista completa y mini) ──
  useEffect(() => {
    if (status !== 'active' || !conn) {
      setSeconds(0);
      return;
    }
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [status, conn]);

  // ── Arrastrar la ventana minimizada (pointer events, sin librería) ──
  const startDrag = useCallback((e) => {
    const el = overlayRef.current;
    if (!el) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = rect.left;
    const originY = rect.top;
    const w = rect.width;
    const h = rect.height;
    const onMove = (ev) => {
      setDragPos({
        x: Math.max(8, Math.min(originX + (ev.clientX - startX), window.innerWidth - w - 8)),
        y: Math.max(8, Math.min(originY + (ev.clientY - startY), window.innerHeight - h - 8)),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  const displayName = peer?.displayname || peer?.username || '…';
  const isRinging = status === 'ringing';
  // Solo se puede minimizar en llamada activa, o mientras el caller espera el ring
  const canMinimize = status === 'active' || (isRinging && role === 'caller');

  return createPortal(
    <div
      ref={overlayRef}
      className={`chat-call-overlay${minimized ? ' chat-call-overlay--minimized' : ''}`}
      style={minimized && dragPos ? { top: dragPos.y, left: dragPos.x } : undefined}
    >
      {conn ? (
        <LiveKitRoom
          serverUrl={conn.url}
          token={conn.token}
          connect={true}
          audio={true}
          options={{ adaptiveStream: true, dynacast: true }}
          onDisconnected={onClose}
          style={{ height: '100%', width: '100%' }}
        >
          <RoomAudioRenderer />
          {/* Se mantiene montado aunque esté minimizado para que el audio no se corte */}
          <div className={minimized ? 'chat-call-active-hidden' : ''}>
            <CallActiveControls peer={peer} onClose={onClose} t={t} seconds={seconds} />
          </div>
        </LiveKitRoom>
      ) : (
        !minimized && (
          <div className="chat-call-card">
            <div className={`chat-call-avatar-wrap${isRinging ? ' chat-call-avatar-wrap--ringing' : ''}`}>
              <Avatar src={peer?.avatar_url} alt={displayName} className="chat-call-avatar" />
            </div>
            <span className="chat-call-name">{displayName}</span>
            <span className="chat-call-status">
              {status === 'active' && !conn && !tokenError && (
                <>
                  <FaSpinner className="chat-call-spin" /> {t('chat.call_connecting') || 'Connecting…'}
                </>
              )}
              {tokenError && (
                <span className="chat-call-error">
                  {t('chat.call_error') || 'Could not start the call'}
                  <small className="chat-call-error-detail">{tokenError}</small>
                </span>
              )}
              {isRinging && role === 'caller' && (t('chat.call_calling') || 'Calling…')}
              {isRinging && role === 'callee' && (t('chat.call_incoming') || 'Incoming call…')}
              {status === 'ended' && (t('chat.call_ended') || 'Call ended')}
              {status === 'missed' && (t('chat.call_missed') || 'Missed call')}
              {status === 'declined' && (t('chat.call_declined') || 'Call declined')}
            </span>

            {isRinging && role === 'caller' && (
              <button className="chat-call-btn chat-call-btn--end chat-call-btn--big" onClick={onClose} title={t('chat.call_hangup') || 'Hang up'}>
                <FaPhoneSlash />
              </button>
            )}

            {isRinging && role === 'callee' && (
              <div className="chat-call-actions">
                <button
                  className="chat-call-btn chat-call-btn--decline chat-call-btn--big"
                  onClick={onDecline}
                  title={t('chat.call_decline') || 'Decline'}
                >
                  <FaPhoneSlash />
                </button>
                <button
                  className="chat-call-btn chat-call-btn--accept chat-call-btn--big"
                  onClick={onAccept}
                  title={t('chat.call_accept') || 'Accept'}
                >
                  <FaPhone />
                </button>
              </div>
            )}

            {status === 'active' && !conn && !tokenError && (
              <button className="chat-call-btn chat-call-btn--end chat-call-btn--big" onClick={onClose} title={t('chat.call_hangup') || 'Hang up'}>
                <FaPhoneSlash />
              </button>
            )}
          </div>
        )
      )}

      {minimized && (
        <CallMiniWindow
          peer={peer}
          status={status}
          role={role}
          conn={!!conn}
          seconds={seconds}
          onExpand={() => setMinimized(false)}
          onClose={onClose}
          onDragStart={startDrag}
          t={t}
        />
      )}

      {!minimized && canMinimize && (
        <button
          className="chat-call-minimize-btn"
          onClick={() => setMinimized(true)}
          title={t('chat.call_minimize') || 'Minimize'}
        >
          <FaWindowMinimize />
        </button>
      )}
    </div>,
    document.body
  );
}

// ── Controles de la sala activa — usa useLocalParticipant dentro del LiveKitRoom ──
function CallActiveControls({ peer, onClose, t, seconds }) {
  const { localParticipant } = useLocalParticipant();
  const [muted, setMuted] = useState(false);

  const displayName = peer?.displayname || peer?.username || '…';

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    localParticipant?.setMicrophoneEnabled(!next).catch(() => {});
  };

  return (
    <div className="chat-call-card chat-call-card--active">
      <div className="chat-call-avatar-wrap">
        <Avatar src={peer?.avatar_url} alt={displayName} className="chat-call-avatar" />
      </div>
      <span className="chat-call-name">{displayName}</span>
      <span className="chat-call-timer">{formatCallTime(seconds)}</span>
      <div className="chat-call-actions">
        <button
          className={`chat-call-btn chat-call-btn--mute${muted ? ' chat-call-btn--active' : ''}`}
          onClick={toggleMute}
          title={muted ? (t('chat.call_unmute') || 'Unmute') : (t('chat.call_mute') || 'Mute')}
        >
          {muted ? <FaMicrophoneSlash /> : <FaMicrophone />}
        </button>
        <button className="chat-call-btn chat-call-btn--end chat-call-btn--big" onClick={onClose} title={t('chat.call_hangup') || 'Hang up'}>
          <FaPhoneSlash />
        </button>
      </div>
    </div>
  );
}

// ── Ventana flotante minimizada (arrastrable) ──
function CallMiniWindow({ peer, status, role, conn, seconds, onExpand, onClose, onDragStart, t }) {
  const displayName = peer?.displayname || peer?.username || '…';
  const statusText = conn
    ? formatCallTime(seconds)
    : (status === 'ringing' && role === 'caller')
      ? (t('chat.call_calling') || 'Calling…')
      : (t('chat.call_connecting') || 'Connecting…');

  return (
    <div className="chat-call-mini" onPointerDown={onDragStart}>
      <Avatar src={peer?.avatar_url} alt={displayName} className="chat-call-mini-avatar" />
      <div className="chat-call-mini-info">
        <span className="chat-call-mini-name">{displayName}</span>
        <span className="chat-call-mini-status">
          {conn && <span className="chat-call-mini-live" />}
          {statusText}
        </span>
      </div>
      <button
        className="chat-call-mini-btn chat-call-mini-btn--expand"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onExpand}
        title={t('chat.call_expand') || 'Expand'}
      >
        <FaExpand />
      </button>
      <button
        className="chat-call-mini-btn chat-call-mini-btn--end"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
        title={t('chat.call_hangup') || 'Hang up'}
      >
        <FaPhoneSlash />
      </button>
    </div>
  );
}

// ── Formatea segundos como MM:SS ──
function formatCallTime(total) {
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}
