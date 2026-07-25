// =========================================================================
// SHARED HTTP HELPERS — ported from orchestrator-service's _shared_http.gs
//
// Original Apps Script behavior preserved 1:1:
//   - Shared_jsonResponse always wraps output as JSON with the standard
//     `{ success, ... }` envelope.
//   - Shared_verifyInternalToken fails CLOSED if no token is configured
//     (an unconfigured token means "not set up yet", not "auth disabled").
//   - Shared_constantTimeEquals avoids leaking token length/content via
//     response-timing side channels — no crypto dependency needed, so it
//     ports verbatim.
//
// NOTE: the original file's comment about Slack's X-Slack-Signature not
// being verifiable "because Apps Script can't read headers" no longer
// applies here — Workers CAN read headers. That's a possible future
// hardening (real HMAC signature verification instead of just team_id
// matching) but is NOT part of this port — Phase 2 only relocates the
// orchestrator's existing behavior, it doesn't add new security surface.
// Flagging it in SYSTEM_HANDOFF.md is worth doing separately.
// =========================================================================

export function jsonResponse(outputObject) {
  return new Response(JSON.stringify(outputObject), {
    headers: { 'Content-Type': 'application/json' }
  });
}

export function verifyInternalToken(payload, expectedToken) {
  // Fail CLOSED if no token has been configured — same as the original.
  if (!expectedToken) return false;
  if (!payload || typeof payload.authToken !== 'string') return false;
  return constantTimeEquals(payload.authToken, expectedToken);
}

export function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Kept for completeness / parity with the original file, even though
// nothing in orchestrator-service's api.js actually calls this today
// (it verifies inbound Slack payloads, which now happens in
// legal-ops-slack-fastpath, not here).
export function verifySlackTeamId(rawData, expectedTeamId) {
  if (!expectedTeamId) return false;
  if (!rawData) return false;
  const incomingTeamId = (rawData.team && rawData.team.id) || rawData.team_id || null;
  return incomingTeamId === expectedTeamId;
}
