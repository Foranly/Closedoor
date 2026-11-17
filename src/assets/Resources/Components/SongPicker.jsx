import { useCallback, useEffect, useRef, useState } from 'react';
import { FaMusic, FaPaperPlane, FaSearch, FaSpinner, FaTimes } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { searchMusic } from '../../services/musicService';
import SongArtwork from './SongArtwork';
import EmojiText from './EmojiText';
// Shell compartida con el picker de GIF: así el contenedor de búsqueda de
// canciones tiene exactamente la misma estética que el resto de contenedores
// embebidos del chat (borde, radios, superficie, header y buscador).
import './css/gifPicker.css';
import './css/songPicker.css';

/**
 * SongPicker — buscador de canciones embebido en el composer del chat.
 *
 * Reutiliza searchMusic (iTunes directo → Deezer/iTunes por proxy) y devuelve
 * la canción normalizada al seleccionar un resultado: el mensaje se envía al
 * vuelo (igual que el picker de GIF), con la tarjeta fuera de la burbuja.
 */
export default function SongPicker({ onSelect, onClose }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const abortRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    return () => { abortRef.current = true; };
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError('');
    setSearched(true);
    abortRef.current = false;
    try {
      const { results: found } = await searchMusic(q, { limit: 8 });
      if (abortRef.current) return;
      setResults(found);
    } catch (err) {
      if (abortRef.current) return;
      console.warn('[chat] song search error:', err?.message || err);
      setResults([]);
      setError(t('profile.song_error') || "Couldn't search music");
    } finally {
      if (!abortRef.current) setSearching(false);
    }
  }, [query, searching, t]);

  return (
    <div className="gif-picker chat-song-picker">
      <div className="gif-picker-header">
        <div className="gif-picker-search-wrap">
          <FaSearch className="gif-picker-search-icon" size={12} />
          <input
            ref={inputRef}
            className="gif-picker-search-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch();
              }
            }}
            placeholder={t('profile.song_search_placeholder')}
          />
        </div>
        <button
          type="button"
          className="chat-song-picker-search-btn"
          onClick={runSearch}
          disabled={searching || !query.trim()}
        >
          {searching ? <FaSpinner className="fc-spin" /> : t('profile.song_search_btn')}
        </button>
        <button
          type="button"
          className="gif-picker-close"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <FaTimes size={13} />
        </button>
      </div>

      <div className="gif-picker-results">
        {searching && (
          <div className="gif-picker-status">
            <div className="gif-picker-spinner" />
            <span>{t('profile.song_searching')}</span>
          </div>
        )}

        {!searching && error && (
          <div className="gif-picker-status gif-picker-status--error">
            <span>{error}</span>
          </div>
        )}

        {!searching && !error && searched && results.length === 0 && (
          <div className="gif-picker-status">
            <span>{t('profile.song_no_results')}</span>
          </div>
        )}

        {!searching && !error && !searched && (
          <div className="gif-picker-status chat-song-picker-hint">
            <FaMusic />
            <span>{t('chat.song_picker_hint')}</span>
          </div>
        )}

        {!searching && !error && results.length > 0 && (
          <div className="chat-song-picker-list">
            {results.map((song) => (
              <button
                key={`${song.provider}-${song.trackId}`}
                type="button"
                className="chat-song-picker-item"
                onClick={() => onSelect(song)}
                title={t('chat.share_song')}
              >
                <SongArtwork
                  song={song}
                  className="chat-song-picker-art"
                  emptyClassName="chat-song-picker-art--empty"
                  loading="lazy"
                />
                <span className="chat-song-picker-info">
                  <span className="chat-song-picker-title"><EmojiText text={song.title} /></span>
                  <span className="chat-song-picker-artist"><EmojiText text={song.artist} /></span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
