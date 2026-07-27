// =========================================================================
// ORCHESTRATION HANDLERS — ported from orchestrator-service's api.js,
// plus NEW handleWriteLead (Phase 3 — Supabase-backed, replaces
// database-service's _api_handleWriteLead as the actual write target for
// email-gateway, which was calling a nonexistent action against the old
// database-service entirely before this fix).
// =========================================================================

import { jsonResponse } from './shared-http.js';

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

/**
 * NEW (Phase 3). Writes a response_leads row via Supabase. Currently the
 * only caller is email-gateway (Linktree form-answer emails), fixed to call
 * this instead of database-service's nonexistent recordLeadFromEmail.
 * Field names match database-service's old writeLead contract deliberately
 * (name/email/phone/notes/deliveryMethod/gmailMessageId) so no other caller
 * needs to change if/when one gets added.
 *
 * project_type_id is deliberately never set here -- there's no reliable way
 * to know a project type from a generic contact-form submission, and it's
 * meant to stay null (per the schema's "null = do not promote" rule) until
 * a human triages it, or a future AI-assisted suggestion gets written to
 * ai_suggested_project_type_id for a human to review.
 */
export async function handleWriteLead(payload, supabase, env) {
  if (!payload.name || !payload.email) {
    return jsonResponse({ success: false, message: 'Missing required fields: name, email.' });
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ success: false, message: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured.' });
  }

  const result = await supabase.insertLead({
    lead_name: payload.name,
    lead_email: payload.email,
    lead_phone: payload.phone || null,
    inquiry_notes: payload.notes || null,
    delivery_method: payload.deliveryMethod || null,
    gmail_message_id: payload.gmailMessageId || null
  });

  if (result.duplicate) {
    return jsonResponse({ success: true, message: 'Lead already ingested (duplicate message ID); no-op.', duplicate: true });
  }
  if (!result.success) {
    return jsonResponse({ success: false, message: result.message });
  }

  return jsonResponse({ success: true, message: 'Lead written successfully.' });
}
