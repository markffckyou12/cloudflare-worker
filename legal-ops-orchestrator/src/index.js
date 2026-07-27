// =========================================================================
// legal-ops-orchestrator — Cloudflare Worker
// (see original header comment in the repo for Phase 2 background)
//
// UPDATED (Phase 3): added 'writeLead' action, backed by Supabase instead
// of database-service — see clients.js's makeSupabaseClient and
// handlers.js's handleWriteLead. Everything else is unchanged.
// =========================================================================

import { jsonResponse, verifyInternalToken } from './shared-http.js';
import { makeDatabaseClient, makeSlackClient, makeSupabaseClient } from './clients.js';
import {
  handleProvisionSlackWorkflow,
  handleRefreshMatterCard,
  handleSlackSubmission,
  handleWriteLead
} from './handlers.js';

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

  // Every POST action here has real side effects — all require internal
  // auth. 'writeLead' included: it's a new external-facing write path
  // (email-gateway), same trust boundary as every other write action here.
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
