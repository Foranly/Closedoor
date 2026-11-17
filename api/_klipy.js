const KLIPY_API_BASE = 'https://api.klipy.com/api/v1';
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 100;
const REQUEST_TIMEOUT_MS = 8000;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getQuery(req) {
  const fromUrl = Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams);
  return { ...fromUrl, ...(req.query && typeof req.query === 'object' ? req.query : {}) };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function handleKlipyRequest(req, res, { apiKey } = {}) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { success: false, error: 'Method not allowed' });
    return;
  }

  if (!apiKey) {
    sendJson(res, 500, { success: false, error: 'GIF service not configured' });
    return;
  }

  const query = getQuery(req);
  const type = String(first(query.type) || 'trending');
  if (type !== 'trending' && type !== 'search') {
    sendJson(res, 400, { success: false, error: 'Invalid type' });
    return;
  }

  const requestedLimit = Number.parseInt(first(query.per_page), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const upstream = new URL(`${KLIPY_API_BASE}/${encodeURIComponent(apiKey)}/gifs/${type}`);
  upstream.searchParams.set('per_page', String(limit));

  if (type === 'search') {
    const q = String(first(query.q) || '').trim();
    if (!q) {
      sendJson(res, 400, { success: false, error: 'Missing q parameter' });
      return;
    }
    if (q.length > MAX_QUERY_LENGTH) {
      sendJson(res, 400, { success: false, error: 'Query too long' });
      return;
    }
    upstream.searchParams.set('q', q);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(upstream, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (response.status === 204) {
      res.statusCode = 204;
      res.end();
      return;
    }

    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        sendJson(res, 502, { success: false, error: 'Invalid upstream response' });
        return;
      }
    }

    if (!response.ok) {
      const status = response.status === 429 ? 429 : 502;
      sendJson(res, status, {
        success: false,
        error: data?.message || `Klipy error ${response.status}`,
      });
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    res.end(JSON.stringify(data));
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    sendJson(res, timedOut ? 504 : 502, {
      success: false,
      error: timedOut ? 'Klipy timeout' : 'Klipy request failed',
    });
  } finally {
    clearTimeout(timeout);
  }
}
