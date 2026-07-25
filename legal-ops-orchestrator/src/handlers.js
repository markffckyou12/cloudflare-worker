// =========================================================================
// ORCHESTRATION HANDLERS — ported from orchestrator-service's api.js
//
// Business logic is UNCHANGED from the Apps Script original. The only
// difference is that DatabaseClient_* / SlackClient_* calls are now async
// (fetch-based) instead of synchronous (UrlFetchApp-based), so every call
// site gets an `await`. Nothing about the decision-making changed.
// =========================================================================

import { jsonResponse } from './shared-http.js';

/**
 * Provisions the Slack workflow for a matter: reads its context from
 * database-service, creates (or resolves) a Slack channel via
 * slack-service, and writes the resulting channel ID back to
 * database-service. Triggered by database-service's
 * Database_ExecuteDelayedSlack after a matter's STATUS flips to "Active".
 */
export async function handleProvisionSlackWorkflow(payload, db, slack, env) {
  if (!payload.refNo) {
    return jsonResponse({ success: false, message: 'Missing required field: refNo.' });
  }
  if (!env.DATABASE_SERVICE_EXEC_URL || !env.SLACK_SERVICE_EXEC_URL) {
    return jsonResponse({ success: false, message: 'DATABASE_SERVICE_EXEC_URL / SLACK_SERVICE_EXEC_URL not configured.' });
  }

  const contextResult = await db.getMatterContext(payload.refNo);
  if (!contextResult.success) {
    return jsonResponse({ success: false, message: `Could not fetch matter context: ${contextResult.message}` });
  }
  const context = contextResult.data;

  const channelName = `${payload.refNo}-${context.clientName || ''}`;
  // Same bug-fix preserved from the Apps Script original: channelName is
  // the human-readable "refNo-clientName" Slack slug, NOT a safe value to
  // bake into button values/private_metadata downstream. payload.refNo
  // (the true, clean REF_NO) is threaded through separately below.
  const createResult = await slack.createChannel(
    channelName,
    true,
    context.officerSlackIdsArray || [],
    (context.unresolvedOfficers || []).map(o => (o.name ? `${o.name} (${o.initial})` : o.initial)),
    payload.refNo
  );
  if (!createResult.success) {
    return jsonResponse({ success: false, message: `Slack channel provisioning failed: ${createResult.message}` });
  }

  const linkResult = await db.updateSlackLinks(payload.refNo, createResult.channelId, createResult.messageTs || null);

  if (createResult.messageTs) {
    const officerParts = (context.officerSlackIdsArray || []).map(id => `<@${id}>`);
    (context.unresolvedOfficers || []).forEach(o => {
      officerParts.push(`⚠️ ${o.name || o.initial} (no linked Slack account)`);
    });
    await slack.updateMatterCard(
      createResult.channelId,
      createResult.messageTs,
      payload.refNo,
      context.clientName,
      context.projectType,
      context.percentage,
      officerParts.length > 0 ? officerParts.join(', ') : '_unassigned_',
      'Active'
    );
  }

  return jsonResponse({
    success: true,
    refNo: payload.refNo,
    channelId: createResult.channelId,
    linkedBack: !!linkResult.success,
    linkedBackPartial: !!linkResult.partial,
    unresolvedOfficers: context.unresolvedOfficers || []
  });
}

/**
 * Edits a matter's already-posted Slack card in place. Unlike
 * provisionSlackWorkflow, this expects the caller (database-service, via
 * slacksync.js) to have already computed everything — no re-fetch needed.
 */
export async function handleRefreshMatterCard(payload, db, slack, env) {
  if (!payload.refNo || !payload.channelId || !payload.messageTs) {
    return jsonResponse({ success: false, message: 'Missing required fields: refNo, channelId, messageTs.' });
  }
  if (!env.SLACK_SERVICE_EXEC_URL) {
    return jsonResponse({ success: false, message: 'SLACK_SERVICE_EXEC_URL not configured.' });
  }

  const result = await slack.updateMatterCard(
    payload.channelId,
    payload.messageTs,
    payload.refNo,
    payload.clientName,
    payload.matterType,
    payload.progressPercent,
    payload.officersStackedString,
    payload.statusEnum
  );

  return jsonResponse({ success: !!result.success, message: result.message });
}

/**
 * Handles a Slack comment-modal submission: extracts the refNo from
 * private_metadata and the comment text from the modal's state, then
 * writes it to database-service's MasterComments table.
 *
 * NOTE: this is now called directly by legal-ops-slack-fastpath (Phase 1),
 * which already parsed the raw Slack view_submission itself and sends it
 * here as `payload.payload` — same shape this function always expected
 * from the old two-hop Worker -> slack-service -> orchestrator-service
 * path, so no changes were needed on this end for Phase 1 to work.
 */
export async function handleSlackSubmission(payload, db) {
  const rawData = payload.payload;
  if (!rawData || !rawData.view) {
    return jsonResponse({ success: false, message: 'Missing Slack view_submission payload.' });
  }

  const metadata = String(rawData.view.private_metadata || '').split('|');
  const refNo = metadata[0];
  if (!refNo) {
    return jsonResponse({ success: false, message: 'private_metadata missing refNo.' });
  }

  let commentText;
  try {
    commentText = rawData.view.state.values.comment_block.comment_text.value;
  } catch (err) {
    return jsonResponse({ success: false, message: 'Could not extract comment text from the submission payload.' });
  }

  if (!commentText) {
    return jsonResponse({ success: false, message: 'Comment text was empty.' });
  }

  // task_block is optional — absence (general comment / no tasks yet)
  // falls through to '', same as the Apps Script original.
  let globalTaskId = '';
  try {
    const taskState = rawData.view.state.values.task_block;
    if (taskState && taskState.task_select && taskState.task_select.selected_option) {
      globalTaskId = taskState.task_select.selected_option.value;
    }
  } catch (err) {
    // task_block absent — general comment, not an error.
  }

  const author = (rawData.user && (rawData.user.username || rawData.user.id)) || 'Slack';
  const writeResult = await db.writeComment(refNo, author, commentText, globalTaskId);

  return jsonResponse({ success: !!writeResult.success, message: writeResult.message });
}
