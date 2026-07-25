// =========================================================================
// legal-ops-orchestrator — Cloudflare Worker
//
// Phase 2 of MIGRATION_RUNBOOK.md: replaces orchestrator-service (Apps
// Script) as the thing legal-ops-slack-fastpath (Phase 1's Worker) and
// database-service call for orchestration actions. Routing logic below is
// a direct translation of orchestrator-service/api.js's doGet/doPost
// action switches — same action names, same required fields, same
// response shapes — just `request.method` + parsed `action` from query
// params (GET) or JSON body (POST) instead of Apps Script's `e.parameter`
// / `e.postData.contents`.
//
// Deliberately a SEPARATE Worker from legal-ops-slack-fastpath (see
// runbook's "Architecture decision" in Phase 2) — a bug in Slack-ingress
// handling shouldn't be able to take down the orchestration layer that
// database-service's scheduled jobs / onEdit triggers also depend on.
// =========================================================================

import { jsonResponse, verifyInternalToken } from './shared-http.js';
import { makeDatabaseClient, makeSlackClient } from './clients.js';
import {
  handleProvisionSlackWorkflow,
  handleRefreshMatterCard,
  handleSlackSubmission
} from './handlers.js';

export default {
  async fetch(request, env, ctx) {
    const db = makeDatabaseClient(env);
    const slack = makeSlackClient(env);

    try {
      if (request.method === 'GET') {
        return await routeGet(request, db, env);
      }
      if (request.method === 'POST') {
        return await routePost(request, db, slack, env);
      }
      return jsonResponse({ success: false, message: `Unsupported method: ${request.method}` });
    } catch (err) {
      // Same fail-safe shape as orchestrator-service's doGet/doPost
      // catch-alls — never let an unhandled exception surface a raw
      // stack trace to a caller.
      console.error(`[Orchestrator Error]: ${err && err.stack ? err.stack : err}`);
      return jsonResponse({ success: false, message: 'Internal routing exception.' });
    }
  }
};

async function routeGet(request, db, env) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  // Proxies Slack's "View Ledger" button data — unauthenticated GET,
  // matching database-service's own equivalent reads (reads are open,
  // writes require the internal token — consistent across every service).
  if (action === 'getLedgerData') {
    const refNo = url.searchParams.get('refNo');
    if (!refNo) return jsonResponse({ success: false, message: 'Missing required parameter: refNo' });
    if (!env.DATABASE_SERVICE_EXEC_URL) {
      return jsonResponse({ success: false, message: 'DATABASE_SERVICE_EXEC_URL not configured.' });
    }
    const result = await db.getLedgerData(refNo);
    return jsonResponse(result);
  }

  // Backs the comment modal's task dropdown — same proxy shape as above.
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

async function routePost(request, db, slack, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return jsonResponse({ success: false, message: 'Internal routing exception or malformed JSON payload.' });
  }

  const action = payload.action;

  // Every POST action here has real side effects — all require internal
  // auth, no "safe to leave open" action on this router. Same fail-closed
  // behavior as Shared_verifyInternalToken.
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

  // Action name matches what legal-ops-slack-fastpath already sends
  // ("handleSubmission", not "handleSlackSubmission") — kept as-is, same
  // reasoning the original orchestrator-service/api.js documented: no
  // reason to force another caller-side edit for a naming preference.
  if (action === 'handleSubmission') {
    return handleSlackSubmission(payload, db);
  }

  return jsonResponse({ success: false, message: `Unknown or missing POST action: "${action}"` });
}
