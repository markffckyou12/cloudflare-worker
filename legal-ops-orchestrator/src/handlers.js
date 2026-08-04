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

// REF_NO_ENGINE — V1 ported verbatim from database-service/identityservice.js
// (single-digit prefix, 8 raw digits total). V2 added Phase 6 to support
// prefix_digit up to 999, per explicit request accepting the format
// change -- see PHASE6_HANDOFF.md for the decision record.
//
// V1 is decode-ONLY from here on: it must never be used to mint a new
// REF_NO again, but it must also never be deleted or have its shuffle
// map changed, because the 11 real REF_NOs already issued under it
// (TP/02101216, TP/02102136, TP/02105256, and 8 others -- see
// PHASE4_HANDOFF.md §1 for which of the 33 migrated matters were the
// genuinely valid ones) still need to decode correctly forever.
//
// V2 is what mintRefNo uses for every new REF_NO from now on --
// including for the existing Subsale/Litigation/Tax project types
// (prefix_digit 1/2/3), even though those would technically still fit
// in V1's single digit. Uniform format going forward (rather than
// conditionally picking V1 vs V2 by prefix size) means there's never
// ambiguity about which scheme decodes a given new REF_NO. Practical
// effect: every REF_NO minted from Phase 6 onward is 10 raw digits
// instead of 8, i.e. visibly longer than the ones already issued.
const REF_NO_ENGINE_V1 = { TOTAL_DIGITS: 8, PREFIX_LEN: 1, SHUFFLE_MAP: [5, 1, 7, 0, 3, 6, 2, 4] };
const REF_NO_ENGINE_V2 = { TOTAL_DIGITS: 10, PREFIX_LEN: 3, SHUFFLE_MAP: [6, 2, 8, 0, 4, 9, 1, 5, 3, 7] };

function computeChecksum(prefixDigits, yearDigits, seqDigits) {
  const digits = `${prefixDigits}${yearDigits}${seqDigits}`.split('').map(Number);
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

/** Tries V1 (8 digits) then V2 (10 digits) based on length, so old and new REF_NOs both decode correctly. */
export function decodeRefNo(refNo) {
  const cleaned = String(refNo).replace(/^TP\//i, '').trim();

  let engine;
  if (cleaned.length === REF_NO_ENGINE_V1.TOTAL_DIGITS) engine = REF_NO_ENGINE_V1;
  else if (cleaned.length === REF_NO_ENGINE_V2.TOTAL_DIGITS) engine = REF_NO_ENGINE_V2;
  else return { valid: false, reason: 'wrong_length' };

  const rawDigits = unshuffleDigits(cleaned, engine.SHUFFLE_MAP);
  const prefixDigits = rawDigits.slice(0, engine.PREFIX_LEN);
  const yearDigits = rawDigits.slice(engine.PREFIX_LEN, engine.PREFIX_LEN + 2);
  const seqDigits = rawDigits.slice(engine.PREFIX_LEN + 2, engine.PREFIX_LEN + 5);
  const checksum = rawDigits.slice(engine.PREFIX_LEN + 5, engine.PREFIX_LEN + 7);
  const expected = computeChecksum(prefixDigits, yearDigits, seqDigits);
  if (checksum !== expected) return { valid: false, reason: 'checksum_mismatch' };
  return { valid: true, prefixDigit: Number(prefixDigits), year: Number(`20${yearDigits}`), sequence: Number(seqDigits) };
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

// --- Project config & matter creation (Phase 5) ---

export async function handleListProjectTypes(payload, supabase) {
  const projectTypes = await supabase.listProjectTypes();
  return jsonResponse({ success: true, projectTypes });
}

/**
 * prefix_digit is a single digit 1-9 (REF_NO_ENGINE.TOTAL_DIGITS's first
 * slot -- see computeChecksum/mintRefNo above), and both name and
 * prefix_digit are UNIQUE at the DB level. A 23505 conflict is reported
 * with a clear message rather than a raw PostgREST error.
 */
export async function handleAddProjectType(payload, supabase, staff) {
  if (!payload.name || payload.prefixDigit === undefined) {
    return jsonResponse({ success: false, message: 'Missing required fields: name, prefixDigit.' });
  }
  const prefixDigit = Number(payload.prefixDigit);
  if (!Number.isInteger(prefixDigit) || prefixDigit < 1 || prefixDigit > 999) {
    return jsonResponse({ success: false, message: 'prefixDigit must be an integer from 1-999.' });
  }

  const result = await supabase.insertProjectType({ name: payload.name, prefix_digit: prefixDigit });
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'add_project_type', tableName: 'project_types',
    recordId: result.data.id, detail: { name: payload.name, prefixDigit }
  });

  return jsonResponse({ success: true, projectType: result.data });
}

export async function handleUpdateProjectType(payload, supabase, staff) {
  if (!payload.projectTypeId) return jsonResponse({ success: false, message: 'Missing required field: projectTypeId.' });

  const fields = {};
  if (payload.name !== undefined) fields.name = payload.name;
  if (payload.prefixDigit !== undefined) {
    const prefixDigit = Number(payload.prefixDigit);
    if (!Number.isInteger(prefixDigit) || prefixDigit < 1 || prefixDigit > 999) {
      return jsonResponse({ success: false, message: 'prefixDigit must be an integer from 1-999.' });
    }
    fields.prefix_digit = prefixDigit;
  }
  if (Object.keys(fields).length === 0) return jsonResponse({ success: false, message: 'No editable fields provided.' });

  const result = await supabase.updateProjectType(payload.projectTypeId, fields);
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'update_project_type', tableName: 'project_types',
    recordId: payload.projectTypeId, detail: fields
  });

  return jsonResponse({ success: true, projectType: result.data });
}

/**
 * Hard delete. Expected to fail with a clear message if this type has
 * any matters, config_task_templates, or response_leads referencing it
 * (see clients.js's deleteProjectType) -- that's the FK doing its job,
 * not a bug to work around.
 */
export async function handleDeleteProjectType(payload, supabase, staff) {
  if (!payload.projectTypeId) return jsonResponse({ success: false, message: 'Missing required field: projectTypeId.' });

  const result = await supabase.deleteProjectType(payload.projectTypeId);
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'delete_project_type', tableName: 'project_types', recordId: payload.projectTypeId
  });

  return jsonResponse({ success: true });
}

/**
 * Shows what the NEXT REF_NO minted for this project type would look
 * like -- WITHOUT touching ref_no_counters. Reads the current seq (0 if
 * no row yet) and computes seq+1 purely for display; does NOT call
 * incrementRefSeq, so calling this repeatedly costs nothing and never
 * burns a real sequence slot. The actual value at creation time could
 * differ if another matter of the same type gets created in between --
 * this is a preview, not a reservation. Existing-matters collision was
 * already reconciled by seeding ref_no_counters from the real, decode-
 * verified REF_NOs already in use (see PHASE4_HANDOFF.md §2) -- this
 * handler doesn't need to re-check that, it just reads the counter it
 * seeded from.
 */
export async function handlePreviewRefNo(payload, supabase) {
  if (!payload.projectTypeId) return jsonResponse({ success: false, message: 'Missing required field: projectTypeId.' });

  const projectType = await supabase.getProjectType(payload.projectTypeId);
  if (!projectType) return jsonResponse({ success: false, message: 'Project type not found.' });

  const year = new Date().getFullYear();
  const yearDigits = String(year).slice(-2);
  const currentSeq = await supabase.peekRefSeq(projectType.prefix_digit, year);
  const nextSeq = currentSeq + 1;

  const prefixDigits = String(projectType.prefix_digit).padStart(REF_NO_ENGINE_V2.PREFIX_LEN, '0');
  const seqDigits = String(nextSeq).padStart(3, '0');
  const checksum = computeChecksum(prefixDigits, yearDigits, seqDigits);
  const rawDigits = `${prefixDigits}${yearDigits}${seqDigits}${checksum}`;
  const refNo = `TP/${shuffleDigits(rawDigits, REF_NO_ENGINE_V2.SHUFFLE_MAP)}`;

  return jsonResponse({ success: true, refNo, preview: true, projectType: projectType.name, year, sequence: nextSeq });
}

/**
 * Directly creates a matter (no lead required) -- the direct-creation
 * counterpart to promoteOneLead. Mints a REAL REF_NO via mintRefNo
 * (consumes a sequence slot, unlike handlePreviewRefNo above).
 *
 * Deliberately does NOT hard-fail when config_task_templates is empty
 * for this project type, unlike promoteOneLead -- this action exists
 * partly so an admin can create a test matter to see what a REF_NO looks
 * like for a project type they're still setting up, and blocking that on
 * "you haven't finished configuring templates yet" would defeat the
 * point. It still deploys blueprints if templates DO exist, and reports
 * deployedCount either way so the caller can tell which happened.
 */
export async function handleCreateMatter(payload, supabase, staff) {
  if (!payload.projectTypeId || !payload.clientName) {
    return jsonResponse({ success: false, message: 'Missing required fields: projectTypeId, clientName.' });
  }

  const projectType = await supabase.getProjectType(payload.projectTypeId);
  if (!projectType) return jsonResponse({ success: false, message: 'Project type not found.' });

  const refNo = await mintRefNo(supabase, projectType);

  const newMatter = await supabase.insertMatter({
    ref_no: refNo,
    client_name: payload.clientName,
    client_email: payload.clientEmail || null,
    project_type_id: payload.projectTypeId,
    status: 'Draft',
    progress_pct: 0
  });

  const deployResult = await deployBlueprintsForMatter(supabase, newMatter.id, payload.projectTypeId);

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'create_matter', tableName: 'matters',
    recordId: newMatter.id, detail: { refNo, projectTypeId: payload.projectTypeId, deployedCount: deployResult.deployed }
  });

  return jsonResponse({ success: true, matter: newMatter, deployedCount: deployResult.deployed });
}

export async function handleListMatters(payload, supabase) {
  const matters = await supabase.listMatters();
  return jsonResponse({ success: true, matters });
}

export async function handleListLeads(payload, supabase) {
  const leads = await supabase.listLeads();
  return jsonResponse({ success: true, leads });
}

// --- Staff management (Phase 4) ---

export async function handleListStaff(payload, supabase) {
  const roster = await supabase.listStaff();
  return jsonResponse({ success: true, staff: roster });
}

/**
 * Enrolls a new staff member. `initial` is required and must be unique
 * (enforced at the DB level -- see clients.js's insertStaff); everything
 * else mirrors the STAFF_SPREADSHEET columns from the pre-migration Sheet
 * (domain_email/linked_email/special_rules/position/slack_member_id) so
 * the admin UI's form can map 1:1 onto what staff used to be tracked with.
 * New staff default to active=true unless the caller says otherwise.
 */
export async function handleAddStaff(payload, supabase, staff) {
  if (!payload.name || !payload.initial) {
    return jsonResponse({ success: false, message: 'Missing required fields: name, initial.' });
  }

  const result = await supabase.insertStaff({
    name: payload.name,
    initial: payload.initial,
    domain_email: payload.domainEmail || null,
    linked_email: payload.linkedEmail || null,
    special_rules: payload.specialRules || null,
    position: payload.position || null,
    slack_member_id: payload.slackMemberId || null,
    is_active: payload.isActive !== undefined ? !!payload.isActive : true
  });
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'add_staff', tableName: 'staff',
    recordId: result.data.id, detail: { name: payload.name, initial: payload.initial }
  });

  return jsonResponse({ success: true, staff: result.data });
}

/**
 * Edits an existing staff member's fields. Every field is optional --
 * only what's present in the payload gets patched -- so this doubles as
 * the "edit one field" and "edit everything" case without a separate
 * action. Does NOT touch is_active; use setStaffStatus for that so
 * enroll/disenroll stays an explicit, separately-audited action rather
 * than a side effect of an unrelated edit.
 */
export async function handleUpdateStaff(payload, supabase, staff) {
  if (!payload.staffId) return jsonResponse({ success: false, message: 'Missing required field: staffId.' });

  const fields = {};
  if (payload.name !== undefined) fields.name = payload.name;
  if (payload.initial !== undefined) fields.initial = payload.initial;
  if (payload.domainEmail !== undefined) fields.domain_email = payload.domainEmail;
  if (payload.linkedEmail !== undefined) fields.linked_email = payload.linkedEmail;
  if (payload.specialRules !== undefined) fields.special_rules = payload.specialRules;
  if (payload.position !== undefined) fields.position = payload.position;
  if (payload.slackMemberId !== undefined) fields.slack_member_id = payload.slackMemberId;

  if (Object.keys(fields).length === 0) {
    return jsonResponse({ success: false, message: 'No editable fields provided.' });
  }

  const result = await supabase.updateStaff(payload.staffId, fields);
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'update_staff', tableName: 'staff',
    recordId: payload.staffId, detail: fields
  });

  return jsonResponse({ success: true, staff: result.data });
}

/**
 * Enroll / disenroll toggle. Kept separate from handleUpdateStaff so
 * "someone deactivated a staff member" is always its own clearly-labeled
 * audit_log row (action: 'activate_staff' / 'deactivate_staff'), not
 * buried inside a generic 'update_staff' detail blob.
 *
 * Deliberately does NOT block deactivating a staff member who's the
 * caller's own account or who has open matter_officers/master_tasks
 * assignments -- is_active only gates staff JWT login (see requireStaff
 * in index.js) and default_assigned_staff_id lookups going forward; it
 * doesn't retroactively touch existing matter_officers rows or
 * historical master_tasks.assigned_staff_id. Reassign their open work
 * separately if that matters operationally.
 */
export async function handleSetStaffStatus(payload, supabase, staff) {
  if (!payload.staffId) return jsonResponse({ success: false, message: 'Missing required field: staffId.' });
  if (payload.isActive === undefined) return jsonResponse({ success: false, message: 'Missing required field: isActive.' });

  const result = await supabase.updateStaff(payload.staffId, { is_active: !!payload.isActive });
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: payload.isActive ? 'activate_staff' : 'deactivate_staff',
    tableName: 'staff', recordId: payload.staffId
  });

  return jsonResponse({ success: true, staff: result.data });
}

/**
 * Hard delete -- distinct from setStaffStatus (deactivate). Expected to
 * fail with a clear message for any staff member who's ever been
 * assigned to a matter or task (see clients.js's deleteStaff for why);
 * that's not a bug, deactivate is the right tool for that case.
 */
export async function handleDeleteStaff(payload, supabase, staff) {
  if (!payload.staffId) return jsonResponse({ success: false, message: 'Missing required field: staffId.' });

  const result = await supabase.deleteStaff(payload.staffId);
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'delete_staff', tableName: 'staff', recordId: payload.staffId
  });

  return jsonResponse({ success: true });
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

// Shared by promoteOneLead and handleCreateMatter (Phase 5) -- refactored
// out so there is exactly one place that mints a REF_NO, instead of two
// copies that could silently drift apart. This DOES consume a real
// sequence number via incrementRefSeq -- it's not a preview, see
// handlePreviewRefNo below for the non-destructive version.
async function mintRefNo(supabase, projectType) {
  const year = new Date().getFullYear();
  const yearDigits = String(year).slice(-2);
  const seq = await supabase.incrementRefSeq(projectType.prefix_digit, year);

  const prefixDigits = String(projectType.prefix_digit).padStart(REF_NO_ENGINE_V2.PREFIX_LEN, '0');
  const seqDigits = String(seq).padStart(3, '0');
  const checksum = computeChecksum(prefixDigits, yearDigits, seqDigits);
  const rawDigits = `${prefixDigits}${yearDigits}${seqDigits}${checksum}`;
  return `TP/${shuffleDigits(rawDigits, REF_NO_ENGINE_V2.SHUFFLE_MAP)}`;
}

async function promoteOneLead(supabase, lead) {
  const templates = await supabase.getConfigTaskTemplates(lead.project_type_id);
  if (!templates || templates.length === 0) {
    throw new Error(`No config_task_templates configured for project_type_id ${lead.project_type_id} — add template rows before promoting leads of this type.`);
  }

  const projectType = await supabase.getProjectType(lead.project_type_id);
  if (!projectType) throw new Error(`project_type_id ${lead.project_type_id} not found.`);

  const refNo = await mintRefNo(supabase, projectType);

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
