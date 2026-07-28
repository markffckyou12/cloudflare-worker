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

// =========================================================================
// ADMIN UI HANDLERS (Phase 3). Ports leadmanager.js's PromoteLeadToMatter
// and identityservice.js's REF_NO_ENGINE -- see inline notes for what was
// verified where. `staff` is the row resolved from the caller's Supabase
// JWT by index.js's requireStaff() before any of these run.
// =========================================================================

// REF_NO_ENGINE — ported verbatim from database-service/identityservice.js.
// Verified: round-tripped synthetic inputs through encode+decode, AND
// decoded three real REF_NOs seen in this project's own conversation
// history (TP/02101216, TP/02102136, TP/02105256) -- all valid, sensible
// years/sequences. Do not change REF_DIGIT_SHUFFLE_MAP independently of
// config.js's copy -- they must stay identical or decoding breaks.
const REF_NO_ENGINE = { TOTAL_DIGITS: 8, REF_DIGIT_SHUFFLE_MAP: [5, 1, 7, 0, 3, 6, 2, 4] };

function computeChecksum(prefixDigit, yearDigits, seqDigits) {
  const digits = `${prefixDigit}${yearDigits}${seqDigits}`.split('').map(Number);
  const sum = digits.reduce((acc, d) => acc + d, 0);
  return String(sum % 97).padStart(2, '0').slice(-2);
}
function shuffleDigits(rawDigits, map) {
  const output = new Array(map.length);
  for (let outPos = 0; outPos < map.length; outPos++) output[map[outPos]] = rawDigits[outPos];
  return output.join('');
}
function unshuffleDigits(shuffledDigits, map) {
  const output = new Array(map.length);
  for (let outPos = 0; outPos < map.length; outPos++) output[outPos] = shuffledDigits[map[outPos]];
  return output.join('');
}
export function decodeRefNo(refNo) {
  const cleaned = String(refNo).replace(/^TP\//i, '').trim();
  if (cleaned.length !== REF_NO_ENGINE.TOTAL_DIGITS) return { valid: false, reason: 'wrong_length' };
  const rawDigits = unshuffleDigits(cleaned, REF_NO_ENGINE.REF_DIGIT_SHUFFLE_MAP);
  const prefixDigit = rawDigits.slice(0, 1);
  const yearDigits = rawDigits.slice(1, 3);
  const seqDigits = rawDigits.slice(3, 6);
  const checksum = rawDigits.slice(6, 8);
  const expected = computeChecksum(prefixDigit, yearDigits, seqDigits);
  if (checksum !== expected) return { valid: false, reason: 'checksum_mismatch' };
  return { valid: true, prefixDigit, year: Number(`20${yearDigits}`), sequence: Number(seqDigits) };
}

async function deployBlueprintsForMatter(supabase, matterId, projectTypeId) {
  const templates = await supabase.getConfigTaskTemplates(projectTypeId);
  if (!templates || templates.length === 0) return { deployed: 0 };

  const rows = templates.map(t => ({
    matter_id: matterId,
    title: t.title,
    sequence: t.sequence,
    assigned_staff_id: t.default_assigned_staff_id
  }));
  const inserted = await supabase.insertMasterTasks(rows);
  return { deployed: inserted.length };
}

export async function handleDeployBlueprints(payload, supabase, staff) {
  if (!payload.matterId) return jsonResponse({ success: false, message: 'Missing required field: matterId.' });

  const matter = await supabase.getMatterById(payload.matterId);
  if (!matter) return jsonResponse({ success: false, message: 'Matter not found.' });

  let result;
  try {
    result = await deployBlueprintsForMatter(supabase, matter.id, matter.project_type_id);
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  }
  if (result.deployed === 0) {
    return jsonResponse({ success: false, message: `No config_task_templates configured for project_type_id ${matter.project_type_id}.` });
  }

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'deploy_blueprints', tableName: 'master_tasks',
    recordId: matter.id, detail: { deployedCount: result.deployed }
  });

  return jsonResponse({ success: true, deployedCount: result.deployed });
}

async function promoteOneLead(supabase, lead) {
  const templates = await supabase.getConfigTaskTemplates(lead.project_type_id);
  if (!templates || templates.length === 0) {
    throw new Error(`No config_task_templates configured for project_type_id ${lead.project_type_id} — add template rows before promoting leads of this type.`);
  }

  const projectType = await supabase.getProjectType(lead.project_type_id);
  if (!projectType) throw new Error(`project_type_id ${lead.project_type_id} not found.`);

  const year = new Date().getFullYear();
  const yearDigits = String(year).slice(-2);
  const seq = await supabase.incrementRefSeq(projectType.prefix_digit, year);

  const seqDigits = String(seq).padStart(3, '0');
  const checksum = computeChecksum(String(projectType.prefix_digit), yearDigits, seqDigits);
  const rawDigits = `${projectType.prefix_digit}${yearDigits}${seqDigits}${checksum}`;
  const refNo = `TP/${shuffleDigits(rawDigits, REF_NO_ENGINE.REF_DIGIT_SHUFFLE_MAP)}`;

  const newMatter = await supabase.insertMatter({
    ref_no: refNo,
    client_name: lead.lead_name,
    client_email: lead.lead_email,
    project_type_id: lead.project_type_id,
    status: 'Draft',
    progress_pct: 0
  });

  const deployResult = await deployBlueprintsForMatter(supabase, newMatter.id, lead.project_type_id);
  if (deployResult.deployed === 0) {
    await supabase.insertSystemHealthLog({
      job_name: 'PromoteLeadToMatter', status: 'FAILURE',
      log_details: `Matter ${refNo} created but 0 tasks deployed for project_type_id ${lead.project_type_id} — check config_task_templates for a race condition.`
    });
  }

  await supabase.updateLead(lead.id, { acknowledge_status: 'Converted', converted_matter_id: newMatter.id });
  return refNo;
}

export async function handlePromoteLeads(payload, supabase, staff) {
  const candidates = await supabase.getPendingLeads();
  const promotedThisRun = {};
  const results = [];

  for (const lead of candidates) {
    const dedupeKey = `${String(lead.lead_email).trim().toLowerCase()}::${lead.project_type_id}`;

    if (promotedThisRun[dedupeKey]) {
      await supabase.updateLead(lead.id, { acknowledge_status: 'Skipped', duplicate_of_lead_id: promotedThisRun[dedupeKey] });
      await supabase.insertAuditLog({
        staffId: staff.id, action: 'promote_lead_skipped_duplicate',
        tableName: 'response_leads', recordId: lead.id, detail: { duplicateOfLeadId: promotedThisRun[dedupeKey] }
      });
      results.push({ leadId: lead.id, status: 'skipped_duplicate' });
      continue;
    }

    try {
      const refNo = await promoteOneLead(supabase, lead);
      promotedThisRun[dedupeKey] = lead.id;
      await supabase.insertAuditLog({
        staffId: staff.id, action: 'promote_lead', tableName: 'response_leads',
        recordId: lead.id, detail: { newRefNo: refNo }
      });
      results.push({ leadId: lead.id, status: 'converted', refNo });
    } catch (err) {
      await supabase.updateLead(lead.id, { acknowledge_status: 'Failed' });
      await supabase.insertSystemHealthLog({
        job_name: 'PromoteLeadToMatter', status: 'FAILURE',
        log_details: `Lead id ${lead.id} (${lead.lead_email}, project_type_id ${lead.project_type_id}): ${err.message}`
      });
      results.push({ leadId: lead.id, status: 'failed', error: err.message });
    }
  }

  return jsonResponse({ success: true, results });
}

export async function handleDecodeRef(payload, supabase) {
  if (!payload.refNo) return jsonResponse({ success: false, message: 'Missing required field: refNo.' });

  const decoded = decodeRefNo(payload.refNo);
  if (!decoded.valid) return jsonResponse({ success: true, decoded });

  const projectType = await supabase.getProjectTypeByPrefixDigit(Number(decoded.prefixDigit));
  return jsonResponse({ success: true, decoded: { ...decoded, projectType: projectType ? projectType.name : null } });
}

// STUBS — both need this Worker's actual email-sending path once
// send-ack/send-progress email content is built (OCI Email Delivery domain
// noreply.legalgan.com is set up and ready whenever this gets picked up).
// For now these do the real audit-log half faithfully and nothing else.
export async function handleSendAck(payload, supabase, staff) {
  if (!payload.leadId) return jsonResponse({ success: false, message: 'Missing required field: leadId.' });
  await supabase.updateLead(payload.leadId, { acknowledge_status: 'Sent' });
  await supabase.insertAuditLog({ staffId: staff.id, action: 'send_ack', tableName: 'response_leads', recordId: payload.leadId });
  return jsonResponse({ success: true, message: 'Marked Sent (email sending not yet implemented).' });
}

export async function handleSendProgress(payload, supabase, staff) {
  if (!payload.matterId) return jsonResponse({ success: false, message: 'Missing required field: matterId.' });
  const matter = await supabase.getMatterById(payload.matterId);
  if (!matter) return jsonResponse({ success: false, message: 'Matter not found.' });
  await supabase.insertAuditLog({ staffId: staff.id, action: 'send_progress', tableName: 'matters', recordId: matter.id });
  return jsonResponse({ success: true, message: 'Audit logged (email sending not yet implemented).' });
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
