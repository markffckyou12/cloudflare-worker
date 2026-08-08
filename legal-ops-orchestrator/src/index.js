// =========================================================================
// legal-ops-orchestrator — Cloudflare Worker
// (see original header comment in the repo for Phase 2 background)
//
// UPDATED (Phase 3): added 'writeLead' action, backed by Supabase instead
// of database-service — see clients.js's makeSupabaseClient and
// handlers.js's handleWriteLead. Everything else is unchanged.
// =========================================================================

import { jsonResponse, verifyInternalToken } from './shared-http.js';
import { makeDatabaseClient, makeGithubClient, makeSlackClient, makeSlackApiClient, makeSupabaseClient, verifyStaffJwt } from './clients.js';
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
  handleUpdateMatter,
  handleDeleteMatter,
  handleListLeads,
  handleAddLead,
  handleSkipLead,
  handleListMasterTasks,
  handleAddMasterTask,
  handleUpdateMasterTask,
  handleDeleteMasterTask,
  handleListMasterComments,
  handleAddMasterComment,
  handleDeleteMasterComment,
  handleListStaff,
  handleAddStaff,
  handleUpdateStaff,
  handleSetStaffStatus,
  handleDeleteStaff,
  handleWhoAmI,
  handleListProjectTypes,
  handleAddProjectType,
  handleUpdateProjectType,
  handleDeleteProjectType,
  handlePreviewRefNo,
  handleCreateMatter,
  handleListConfigTaskTemplates,
  handleAddConfigTaskTemplate,
  handleUpdateConfigTaskTemplate,
  handleDeleteConfigTaskTemplate,
  handleListPosts,
  handleGetPost,
  handleSavePost,
  handleDeletePost,
  handleReviewPost
} from './handlers.js';

// Admin UI actions authenticate a human staff member via a Supabase Auth
// JWT (Authorization header), NOT the shared INTERNAL_SERVICE_TOKEN --
// that's a service-to-service secret and must never reach a browser.
// Everything else on this router keeps using authToken as before.
const ADMIN_ACTIONS = new Set([
  'deployBlueprints', 'promoteLeads', 'decodeRef', 'sendAck', 'sendProgress', 'listMatters', 'listLeads',
  // Phase 4: staff management
  'listStaff', 'addStaff', 'updateStaff', 'setStaffStatus', 'deleteStaff', 'whoAmI',
  // Phase 5/6: project config + direct matter creation
  'listProjectTypes', 'addProjectType', 'updateProjectType', 'deleteProjectType', 'previewRefNo', 'createMatter',
  // Phase 8: matter edit/delete + task blueprint config
  'updateMatter', 'deleteMatter', 'listConfigTaskTemplates', 'addConfigTaskTemplate', 'updateConfigTaskTemplate', 'deleteConfigTaskTemplate',
  // Phase 9: tasks, comments, manual/skip leads
  'addLead', 'skipLead',
  'listMasterTasks', 'addMasterTask', 'updateMasterTask', 'deleteMasterTask',
  'listMasterComments', 'addMasterComment', 'deleteMasterComment',
  // Phase 10: content editing (commits directly to the Astro site's GitHub repo)
  'listPosts', 'getPost', 'savePost', 'deletePost',
  // Phase 11: AI-assisted review
  'reviewPost'
]);

async function requireStaff(request, env, supabase) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { error: jsonResponse({ success: false, message: 'Missing bearer token.' }) };

  let claims;
  try {
    claims = await verifyStaffJwt(token, env);
  } catch (err) {
    console.error(`Staff JWT verification failed: ${err && err.message ? err.message : err}`);
    return { error: jsonResponse({ success: false, message: 'Invalid or expired token.' }) };
  }

  const staff = await supabase.getStaffByAuthUserId(claims.sub);
  if (!staff) return { error: jsonResponse({ success: false, message: 'No staff record linked to this account.' }) };
  if (!staff.is_active) return { error: jsonResponse({ success: false, message: 'Staff account is inactive.' }) };

  return { staff };
}

async function routeAdminAction(action, payload, supabase, staff, slack, slackApi, github, ai) {
  if (action === 'deployBlueprints') return handleDeployBlueprints(payload, supabase, staff);
  if (action === 'promoteLeads') return handlePromoteLeads(payload, supabase, staff, slack, slackApi);
  if (action === 'decodeRef') return handleDecodeRef(payload, supabase);
  if (action === 'sendAck') return handleSendAck(payload, supabase, staff);
  if (action === 'sendProgress') return handleSendProgress(payload, supabase, staff);
  if (action === 'listMatters') return handleListMatters(payload, supabase);
  if (action === 'listLeads') return handleListLeads(payload, supabase);
  // NEW (Phase 4)
  if (action === 'listStaff') return handleListStaff(payload, supabase);
  if (action === 'addStaff') return handleAddStaff(payload, supabase, staff);
  if (action === 'updateStaff') return handleUpdateStaff(payload, supabase, staff);
  if (action === 'setStaffStatus') return handleSetStaffStatus(payload, supabase, staff);
  if (action === 'deleteStaff') return handleDeleteStaff(payload, supabase, staff);
  if (action === 'whoAmI') return handleWhoAmI(payload, supabase, staff);
  // Phase 5/6
  if (action === 'listProjectTypes') return handleListProjectTypes(payload, supabase);
  if (action === 'addProjectType') return handleAddProjectType(payload, supabase, staff);
  if (action === 'updateProjectType') return handleUpdateProjectType(payload, supabase, staff);
  if (action === 'deleteProjectType') return handleDeleteProjectType(payload, supabase, staff);
  if (action === 'previewRefNo') return handlePreviewRefNo(payload, supabase);
  if (action === 'createMatter') return handleCreateMatter(payload, supabase, staff, slack, slackApi);
  // Phase 8
  if (action === 'updateMatter') return handleUpdateMatter(payload, supabase, staff, slack, slackApi);
  if (action === 'deleteMatter') return handleDeleteMatter(payload, supabase, staff);
  if (action === 'listConfigTaskTemplates') return handleListConfigTaskTemplates(payload, supabase);
  if (action === 'addConfigTaskTemplate') return handleAddConfigTaskTemplate(payload, supabase, staff);
  if (action === 'updateConfigTaskTemplate') return handleUpdateConfigTaskTemplate(payload, supabase, staff);
  if (action === 'deleteConfigTaskTemplate') return handleDeleteConfigTaskTemplate(payload, supabase, staff);
  // Phase 9
  if (action === 'addLead') return handleAddLead(payload, supabase, staff);
  if (action === 'skipLead') return handleSkipLead(payload, supabase, staff);
  if (action === 'listMasterTasks') return handleListMasterTasks(payload, supabase);
  if (action === 'addMasterTask') return handleAddMasterTask(payload, supabase, staff);
  if (action === 'updateMasterTask') return handleUpdateMasterTask(payload, supabase, staff);
  if (action === 'deleteMasterTask') return handleDeleteMasterTask(payload, supabase, staff);
  if (action === 'listMasterComments') return handleListMasterComments(payload, supabase);
  if (action === 'addMasterComment') return handleAddMasterComment(payload, supabase, staff);
  if (action === 'deleteMasterComment') return handleDeleteMasterComment(payload, supabase, staff);
  // Phase 10
  if (action === 'listPosts') return handleListPosts(payload, github);
  if (action === 'getPost') return handleGetPost(payload, github);
  if (action === 'savePost') return handleSavePost(payload, github, supabase, staff);
  if (action === 'deletePost') return handleDeletePost(payload, github, supabase, staff);
  // Phase 11
  if (action === 'reviewPost') return handleReviewPost(payload, ai, github);
  return jsonResponse({ success: false, message: `Unknown admin action: "${action}"` });
}

// --- CORS ---
// Needed as of the admin UI (a real browser page on a different origin,
// e.g. *.pages.dev, calling this Worker on *.workers.dev). Every prior
// caller (curl, email-gateway, Slack) isn't a browser, so this was never
// needed before -- CORS is a browser-only enforcement, which is why curl
// testing writeLead worked fine while the browser-based admin UI silently
// failed on listMatters/listLeads.
function withCors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), origin);
    }

    const db = makeDatabaseClient(env);
    const slack = makeSlackClient(env);
    const slackApi = makeSlackApiClient(env);
    const supabase = makeSupabaseClient(env);
    const github = makeGithubClient(env);

    try {
      let response;
      if (request.method === 'GET') {
        response = await routeGet(request, db, env);
      } else if (request.method === 'POST') {
        response = await routePost(request, db, slack, slackApi, supabase, env, github, env.AI);
      } else {
        response = jsonResponse({ success: false, message: `Unsupported method: ${request.method}` });
      }
      return withCors(response, origin);
    } catch (err) {
      console.error(`[Orchestrator Error]: ${err && err.stack ? err.stack : err}`);
      return withCors(jsonResponse({ success: false, message: 'Internal routing exception.' }), origin);
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

async function routePost(request, db, slack, slackApi, supabase, env, github, ai) {
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
    return routeAdminAction(action, payload, supabase, authResult.staff, slack, slackApi, github, ai);
  }

  // Every other POST action here is service-to-service and requires
  // INTERNAL_SERVICE_TOKEN. 'writeLead' included: it's an external-facing
  // write path (email-gateway), same trust boundary as every other write
  // action here.
  if (!verifyInternalToken(payload, env.INTERNAL_SERVICE_TOKEN)) {
    return jsonResponse({ success: false, message: 'Unauthorized: missing or invalid authToken.' });
  }

  if (action === 'provisionSlackWorkflow') {
    return handleProvisionSlackWorkflow(payload, supabase, slack, slackApi, env);
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
