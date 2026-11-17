import React, { useState, useCallback, useRef, useEffect } from 'react';
import './css/gifPicker.css';

// ── KLIPY API ──
// La clave vive solo en el servidor: el navegador llama a este proxy.
const PROXY_URL = '/api/klipy';

const DEFAULT_LIMIT = 30;

// ── Shared recursive helper to find image URLs in any nested GIF object ──
function findGifUrl(obj, depth = 0, selectLarge = false) {
  if (depth > 3 || !obj || obj === true || obj === false || obj === null) return null;

  // Direct string URL
  if (typeof obj === 'string') {
    const lower = obj.toLowerCase();
    if ((lower.startsWith('http://') || lower.startsWith('https://')) &&
        (lower.endsWith('.gif') || lower.endsWith('.webp') || lower.endsWith('.png') || lower.endsWith('.jpg'))) {
      return obj;
    }
    return null;
  }

  if (typeof obj !== 'object') return null;

  // If obj has a url property, use it
  if (obj.url && typeof obj.url === 'string') return obj.url;

  // Priority keys for thumbnails vs selection
  const priorityKeys = selectLarge
    ? ['url', 'original', 'medium', 'preview', 'gif', 'preview_gif', 'src', 'thumb', 'thumbnail', 'small', 'tiny', 'nanogif', 'microgif']
    : ['url', 'small', 'tiny', 'thumb', 'thumbnail', 'preview', 'preview_gif', 'nanogif', 'microgif', 'medium', 'gif', 'src'];

  for (const key of priorityKeys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const val = obj[key];
      if (typeof val === 'string' && val.startsWith('http')) return val;
      if (val && typeof val === 'object') {
        const nested = findGifUrl(val, depth + 1, selectLarge);
        if (nested) return nested;
      }
    }
  }

  // Fallback: scan all keys recursively
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const result = findGifUrl(val, depth + 1, selectLarge);
      if (result) return result;
    }
  }

  return null;
}

/**
 * GifPicker — embedded GIF search & select panel using Klipy API.
 *
 * Props:
 *  - onSelect: (gifUrl: string) => void — called when user clicks a GIF
 *  - onClose: () => void — close the picker
 */
export default function GifPicker({ onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // ── Fetch helper with AbortController ──
  const fetchGifs = useCallback(async (url) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { signal: controller.signal });

      if (res.status === 204) {
        setGifs([]);
        return;
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`GIF service returned ${contentType || 'empty'} instead of JSON`);
      }

      const json = await res.json();
      if (controller.signal.aborted) return;

      if (!res.ok) {
        throw new Error(json?.error || `GIF service error: ${res.status}`);
      }

      // Klipy response format: { result: true, data: { data: [...], current_page, ... } }
      if (!json.result) {
        throw new Error(json.message || 'GIF service returned an error');
      }

      const items = json.data?.data || [];
      setGifs(items);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!controller.signal.aborted) {
        setError(err.message);
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  // ── Fetch trending GIFs on mount ──
  useEffect(() => {
    fetchGifs(`${PROXY_URL}?type=trending&per_page=${DEFAULT_LIMIT}`);
    if (inputRef.current) inputRef.current.focus();
  }, [fetchGifs]);

  // ── Search with debounce ──
  const handleSearch = useCallback((e) => {
    const value = e.target.value;
    setQuery(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!value.trim()) {
      fetchGifs(`${PROXY_URL}?type=trending&per_page=${DEFAULT_LIMIT}`);
      return;
    }

    debounceRef.current = setTimeout(() => {
      fetchGifs(
        `${PROXY_URL}?type=search&q=${encodeURIComponent(value.trim())}&per_page=${DEFAULT_LIMIT}`
      );
    }, 400);
  }, [fetchGifs]);

  const handleSelect = useCallback((gif) => {
    const url = findGifUrl(gif, 0, true);
    if (url) {
      onSelect(url);
    }
  }, [onSelect]);

  const getThumbUrl = useCallback((gif) => {
    return findGifUrl(gif, 0, false);
  }, []);

  return (
    <div className="gif-picker">
      <div className="gif-picker-header">
        <div className="gif-picker-search-wrap">
          <svg
            className="gif-picker-search-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className="gif-picker-search-input"
            type="text"
            value={query}
            onChange={handleSearch}
            placeholder="Search GIFs..."
          />
        </div>
        <button
          type="button"
          className="gif-picker-close"
          onClick={onClose}
          aria-label="Close GIF picker"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="gif-picker-results">
        {loading && (
          <div className="gif-picker-status">
            <div className="gif-picker-spinner" />
            <span>Loading...</span>
          </div>
        )}

        {error && (
          <div className="gif-picker-status gif-picker-status--error">
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && gifs.length === 0 && (
          <div className="gif-picker-status">
            <span>No GIFs found</span>
          </div>
        )}

        {!loading && gifs.length > 0 && (
          <div className="gif-picker-grid">
            {gifs.map((gif) => {
              const thumbUrl = getThumbUrl(gif);
              return (
                <button
                  key={gif.id || gif.slug}
                  type="button"
                  className="gif-picker-item"
                  onClick={() => handleSelect(gif)}
                  title={gif.title || 'GIF'}
                >
                  {thumbUrl && (
                    <img
                      src={thumbUrl}
                      alt={gif.title || 'GIF'}
                      loading="lazy"
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
