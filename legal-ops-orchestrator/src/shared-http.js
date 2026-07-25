// Shared HTTP helpers for the Worker — small helpers used across handlers/index
// Exports:
// - jsonResponse(obj, status = 200): Response with application/json body
// - verifyInternalToken(payload, expectedToken): fail-closed check for internal auth token

export function jsonResponse(obj, status = 200) {
  const body = JSON.stringify(obj || {});
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

/**
 * Verify an internal service token passed in the request payload.
 *
 * This is intentionally permissive in how callers provide the token so
 * it matches common shapes used by other services/callers:
 * - payload.authToken
 * - payload.auth_token
 * - payload.token
 * - payload.auth
 *
 * Behavior: fail-closed. If expectedToken is falsy, return false.
 */
export function verifyInternalToken(payload = {}, expectedToken) {
  if (!expectedToken) return false; // fail-closed when token not configured

  const candidates = [];
  if (payload && typeof payload === 'object') {
    candidates.push(payload.authToken, payload.auth_token, payload.token, payload.auth);
  }

  // Allow a header-shaped value too if caller nested it under `headers`.
  if (payload && payload.headers && typeof payload.headers === 'object') {
    const h = payload.headers;
    // Authorization header may contain "Bearer <token>" or just the token
    if (h.authorization) candidates.push(h.authorization, h.Authorization);
    if (h.Authorization) candidates.push(h.Authorization);
  }

  for (const c of candidates) {
    if (!c) continue;
    const normalized = String(c).trim();
    if (normalized === expectedToken) return true;
    // support "Bearer <token>" forms
    if (normalized.toLowerCase().startsWith('bearer ')) {
      if (normalized.slice(7).trim() === expectedToken) return true;
    }
  }

  return false;
}
