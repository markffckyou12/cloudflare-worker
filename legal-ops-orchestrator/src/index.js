// =========================================================================
// legal-ops-orchestrator — Cloudflare Worker
// (see original header comment in the repo for Phase 2 background)
//
// UPDATED (Phase 3): added 'writeLead' action, backed by Supabase instead
// of database-service — see clients.js's makeSupabaseClient and
// handlers.js's handleWriteLead. Everything else is unchanged.
// =========================================================================

import { jsonResponse, verifyInternalToken } from './shared-http.js';
import { makeDatabaseClient, makeSlackClient, makeSupabaseClient, verifyStaffJwt } from './clients.js';
import {
  handleProvisionSlackWorkflow,
  handleRefreshMatterCard,
  handleSlackSubmission,
  handleWriteLead,
  handleDeployBlueprints,
  handlePromoteLeads,
  handleDecodeRef,
  handleSendAck,
  handleSendProgress,
  handleListMatters,
  handleListLeads
} from './handlers.js';

// Admin UI actions authenticate a human staff member via a Supabase Auth
// JWT (Authorization header), NOT the shared INTERNAL_SERVICE_TOKEN --
// that's a service-to-service secret and must never reach a browser.
// Everything else on this router keeps using authToken as before.
const ADMIN_ACTIONS = new Set(['deployBlueprints', 'promoteLeads', 'decodeRef', 'sendAck', 'sendProgress', 'listMatters', 'listLeads']);

async function requireStaff(request, env, supabase) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { error: jsonResponse({ success: false, message: 'Missing bearer token.' }) };

  let claims;
  try {
    claims = await verifyStaffJwt(token, env);
  } catch (err) {
    return { error: jsonResponse({ success: false, message: 'Invalid or expired token.' }) };
  }

  const staff = await supabase.getStaffByAuthUserId(claims.sub);
  if (!staff) return { error: jsonResponse({ success: false, message: 'No staff record linked to this account.' }) };
  if (!staff.is_active) return { error: jsonResponse({ success: false, message: 'Staff account is inactive.' }) };

  return { staff };
}

async function routeAdminAction(action, payload, supabase, staff) {
  if (action === 'deployBlueprints') return handleDeployBlueprints(payload, supabase, staff);
  if (action === 'promoteLeads') return handlePromoteLeads(payload, supabase, staff);
  if (action === 'decodeRef') return handleDecodeRef(payload, supabase);
  if (action === 'sendAck') return handleSendAck(payload, supabase, staff);
  if (action === 'sendProgress') return handleSendProgress(payload, supabase, staff);
  if (action === 'listMatters') return handleListMatters(payload, supabase);
  if (action === 'listLeads') return handleListLeads(payload, supabase);
  return jsonResponse({ success: false, message: `Unknown admin action: "${action}"` });
}

export default {
  async fetch(request, env, ctx) {
    const db = makeDatabaseClient(env);
    const slack = makeSlackClient(env);
    const supabase = makeSupabaseClient(env);

    try {
      if (request.method === 'GET') {
        return await routeGet(request, db, env);
      }
      if (request.method === 'POST') {
        return await routePost(request, db, slack, supabase, env);
      }
      return jsonResponse({ success: false, message: `Unsupported method: ${request.method}` });
    } catch (err) {
      console.error(`[Orchestrator Error]: ${err && err.stack ? err.stack : err}`);
      return jsonResponse({ success: false, message: 'Internal routing exception.' });
    }
  }
};

async function routeGet(request, db, env) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'getLedgerData') {
    const refNo = url.searchParams.get('refNo');
    if (!refNo) return jsonResponse({ success: false, message: 'Missing required parameter: refNo' });
    if (!env.DATABASE_SERVICE_EXEC_URL) {
      return jsonResponse({ success: false, message: 'DATABASE_SERVICE_EXEC_URL not configured.' });
    }
    const result = await db.getLedgerData(refNo);
    return jsonResponse(result);
  }

  if (action === 'getMatterTasks') {
    const refNo = url.searchParams.get('refNo');
    if (!refNo) return jsonResponse({ success: false, message: 'Missing required parameter: refNo' });
    if (!env.DATABASE_SERVICE_EXEC_URL) {
      return jsonResponse({ success: false, message: 'DATABASE_SERVICE_EXEC_URL not configured.' });
    }
    const result = await db.getMatterTasks(refNo);
    return jsonResponse(result);
  }

  return jsonResponse({ success: false, message: `Unknown or missing GET action: "${action}"` });
}

async function routePost(request, db, slack, supabase, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return jsonResponse({ success: false, message: 'Internal routing exception or malformed JSON payload.' });
  }

  const action = payload.action;

  // Admin UI actions: staff-JWT auth (see requireStaff above), NOT the
  // shared service token.
  if (ADMIN_ACTIONS.has(action)) {
    const authResult = await requireStaff(request, env, supabase);
    if (authResult.error) return authResult.error;
    return routeAdminAction(action, payload, supabase, authResult.staff);
  }

  // Every other POST action here is service-to-service and requires
  // INTERNAL_SERVICE_TOKEN. 'writeLead' included: it's an external-facing
  // write path (email-gateway), same trust boundary as every other write
  // action here.
  if (!verifyInternalToken(payload, env.INTERNAL_SERVICE_TOKEN)) {
    return jsonResponse({ success: false, message: 'Unauthorized: missing or invalid authToken.' });
  }

  if (action === 'provisionSlackWorkflow') {
    return handleProvisionSlackWorkflow(payload, db, slack, env);
  }

  if (action === 'refreshMatterCard') {
    return handleRefreshMatterCard(payload, db, slack, env);
  }

  if (action === 'getPinnedMessageTs') {
    if (!payload.channelId) {
      return jsonResponse({ success: false, message: 'Missing required field: channelId.' });
    }
    const pinResult = await slack.getPinnedMessageTs(payload.channelId);
    return jsonResponse(pinResult);
  }

  if (action === 'handleSubmission') {
    return handleSlackSubmission(payload, db);
  }

  // NEW (Phase 3)
  if (action === 'writeLead') {
    return handleWriteLead(payload, supabase, env);
  }

  return jsonResponse({ success: false, message: `Unknown or missing POST action: "${action}"` });
}
