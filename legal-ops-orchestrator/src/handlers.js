// =========================================================================
// ORCHESTRATION HANDLERS — ported from orchestrator-service's api.js,
// plus NEW handleWriteLead (Phase 3 — Supabase-backed, replaces
// database-service's _api_handleWriteLead as the actual write target for
// email-gateway, which was calling a nonexistent action against the old
// database-service entirely before this fix).
// =========================================================================

import { jsonResponse } from './shared-http.js';

/**
 * Does the actual work: gather matter + officer context from Supabase,
 * create the Slack channel (still via the existing slack-service proxy --
 * that part was never broken, it only needs a channel name + Slack user
 * IDs, nothing Sheets-specific), write the resulting channel_id/message_ts
 * back into `matters`, and post the initial status card.
 *
 * Returns {success, message?, channelId?} rather than throwing, so both
 * callers below can decide their own failure handling: the manual action
 * surfaces the real error to the caller, automatic provisioning treats
 * the same failure as best-effort and logs it instead.
 */
/** Shared by provisionSlackForMatter, refreshSlackPresence, and
 *  syncOfficersToSlack -- one place that turns a resolved/unresolved
 *  officer split into the "<@U123>, <@U456>" display string used in both
 *  the pinned card and the channel topic. */
function formatOfficerParts(officerSlackIds, unresolvedOfficers) {
  const parts = officerSlackIds.map((id) => `<@${id}>`);
  unresolvedOfficers.forEach((o) => {
    parts.push(`⚠️ ${o.name || o.initial} (no linked Slack account)`);
  });
  return parts.length > 0 ? parts.join(', ') : '_unassigned_';
}

function buildMatterTopic(matter, officerPartsStr) {
  return `${matter.status} | PIC: ${officerPartsStr}`;
}

function buildMatterPurpose(matter) {
  return `${matter.ref_no} — ${matter.client_name || 'no client name'} — ${matter.project_types?.name || 'no project type'}`;
}

async function provisionSlackForMatter(supabase, slack, slackApi, matterId) {
  const matter = await supabase.getMatterForSlackProvisioning(matterId);
  if (!matter) return { success: false, message: `Matter id ${matterId} not found.` };

  const { resolved: officerSlackIds, unresolved: unresolvedOfficers } = await supabase.getMatterOfficersForSlack(matterId);

  const channelName = `${matter.ref_no}-${matter.client_name || ''}`;
  const createResult = await slack.createChannel(
    channelName,
    true,
    officerSlackIds,
    unresolvedOfficers.map((o) => (o.name ? `${o.name} (${o.initial})` : o.initial)),
    matter.ref_no
  );
  if (!createResult.success) {
    return { success: false, message: `Slack channel provisioning failed: ${createResult.message}` };
  }

  await supabase.updateMatter(matterId, {
    slack_channel_id: createResult.channelId,
    slack_message_ts: createResult.messageTs || null
  });

  // Topic/purpose were previously left empty -- purpose is the static
  // "what is this channel" description, topic is the dynamic
  // status+PIC line that gets refreshed on every subsequent officer or
  // status change (see refreshSlackPresence below). Best-effort: a
  // failure here shouldn't undo the channel creation that already
  // succeeded above.
  const officerPartsStr = formatOfficerParts(officerSlackIds, unresolvedOfficers);
  await slackApi.setPurpose(createResult.channelId, buildMatterPurpose(matter));
  await slackApi.setTopic(createResult.channelId, buildMatterTopic(matter, officerPartsStr));

  if (createResult.messageTs) {
    await slack.updateMatterCard(
      createResult.channelId,
      createResult.messageTs,
      matter.ref_no,
      matter.client_name,
      matter.project_types?.name,
      matter.progress_pct,
      officerPartsStr,
      matter.status
    );
  }

  return { success: true, channelId: createResult.channelId };
}

/**
 * Re-pushes current Supabase state (status, progress, officers) to
 * Slack's pinned card AND the channel topic -- call this after ANY
 * change that affects what those should say (officer edits, status/
 * progress edits). Previously nothing called updateMatterCard after
 * initial creation at all, which is why the pinned tracker never
 * reflected officer changes. No-ops quietly if the matter has no
 * channel/pinned message yet (e.g. Slack provisioning never succeeded
 * for it) -- nothing to refresh in that case.
 */
async function refreshSlackPresence(supabase, slack, slackApi, matterId) {
  try {
    const matter = await supabase.getMatterForSlackProvisioning(matterId);
    if (!matter || !matter.slack_channel_id) return;

    const { resolved: officerSlackIds, unresolved: unresolvedOfficers } = await supabase.getMatterOfficersForSlack(matterId);
    const officerPartsStr = formatOfficerParts(officerSlackIds, unresolvedOfficers);

    await slackApi.setTopic(matter.slack_channel_id, buildMatterTopic(matter, officerPartsStr));

    if (matter.slack_message_ts) {
      await slack.updateMatterCard(
        matter.slack_channel_id,
        matter.slack_message_ts,
        matter.ref_no,
        matter.client_name,
        matter.project_types?.name,
        matter.progress_pct,
        officerPartsStr,
        matter.status
      );
    }
  } catch (err) {
    await supabase.insertSystemHealthLog({
      job_name: 'RefreshSlackPresence', status: 'FAILURE',
      log_details: `Matter id ${matterId}: Slack presence refresh threw -- ${err.message}`
    });
  }
}

/**
 * Manual/service-triggered provisioning by refNo. Rewritten Phase 10 --
 * previously called db.getMatterContext() against the legacy Sheets-
 * backed database-service, which had no knowledge of any matter created
 * since the Supabase migration and would fail for all of them. Now reads
 * everything from Supabase directly. No audit_log entry here (matches
 * handleWriteLead's convention -- this is a service-to-service action,
 * not a staff-attributed one, so there's no staff.id to attribute it to).
 */
export async function handleProvisionSlackWorkflow(payload, supabase, slack, slackApi, env) {
  if (!payload.refNo) {
    return jsonResponse({ success: false, message: 'Missing required field: refNo.' });
  }
  if (!env.SLACK_SERVICE_EXEC_URL) {
    return jsonResponse({ success: false, message: 'SLACK_SERVICE_EXEC_URL not configured.' });
  }

  const matterId = await supabase.getMatterIdByRefNo(payload.refNo);
  if (!matterId) {
    return jsonResponse({ success: false, message: `No matter found with ref_no ${payload.refNo}.` });
  }

  const result = await provisionSlackForMatter(supabase, slack, slackApi, matterId);
  return jsonResponse({ success: result.success, message: result.message, refNo: payload.refNo, channelId: result.channelId });
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
/**
 * Every new matter gets the designated admin staff member as a default
 * officer, set BEFORE Slack provisioning runs so they're included in the
 * initial channel invite the same way any other officer would be --
 * making "admin ends up in every new channel" an explicit, DB-visible
 * decision our own system makes, rather than a side effect of whatever
 * slack-service (the old Apps Script, opaque from this codebase) does
 * internally. Best-effort: no ADMIN staff row, or the assignment call
 * failing, shouldn't block matter creation.
 */
async function assignDefaultAdminOfficer(supabase, matterId) {
  try {
    const admin = await supabase.getStaffByInitial('ADMIN');
    if (admin) await supabase.setMatterOfficers(matterId, [admin.id]);
  } catch (err) {
    await supabase.insertSystemHealthLog({
      job_name: 'AssignDefaultAdminOfficer', status: 'FAILURE',
      log_details: `Matter id ${matterId}: failed to assign default admin officer -- ${err.message}`
    });
  }
}

export async function handleCreateMatter(payload, supabase, staff, slack, slackApi) {
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

  await assignDefaultAdminOfficer(supabase, newMatter.id);
  await provisionSlackBestEffort(supabase, slack, slackApi, newMatter.id, refNo, 'CreateMatter');

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

/**
 * Combines a matter field patch with an officer-list replace in one
 * action, since they're edited together on the same form. `officerStaffIds`
 * is optional -- omit it entirely to leave officer assignments untouched
 * while patching other fields; pass `[]` explicitly to clear all officers.
 */
/**
 * Best-effort: diffs the old vs new officer Slack IDs and invites/removes
 * channel members to match. Never blocks or fails the officer save itself
 * (which already succeeded in Supabase by the time this runs) -- Slack
 * being unreachable, SLACK_BOT_TOKEN not yet configured, or a member
 * already being in/out of the channel are all logged, not raised.
 */
/**
 * Best-effort: makes channel membership match the desired officer list.
 *
 * Diffs against Slack's OWN actual current channel membership (fetched
 * fresh via conversations.members), not our own matter_officers table's
 * state. This is deliberate -- trusting our own DB as "who's already
 * there" is fragile (stale reads, a previous bug, someone changing
 * membership by hand in Slack) and was exactly what caused already-
 * present members like the default admin officer to get a redundant
 * invite attempt. Diffing against Slack's ground truth means we only
 * ever invite someone who Slack itself confirms isn't already in the
 * channel, full stop.
 */
async function syncOfficersToSlack(supabase, slackApi, matterId, newStaffIds) {
  try {
    const matter = await supabase.getMatterForSlackProvisioning(matterId);
    if (!matter || !matter.slack_channel_id) return; // no channel yet -- nothing to sync

    const membersResult = await slackApi.getChannelMembers(matter.slack_channel_id);
    if (!membersResult.ok) {
      await supabase.insertSystemHealthLog({
        job_name: 'SyncOfficersToSlack', status: 'FAILURE',
        log_details: `Matter id ${matterId}: could not read current channel members -- ${membersResult.error}`
      });
      return;
    }
    const currentMemberIds = new Set(membersResult.members);

    const desiredSlackIds = new Set(await supabase.getStaffSlackMemberIds(newStaffIds || []));
    const toInvite = [...desiredSlackIds].filter((id) => !currentMemberIds.has(id));
    // Only remove people the officer list itself manages -- never kick a
    // channel member (e.g. the bot, or anyone else) who isn't a resolved
    // officer id in either list; we only know how to reason about people
    // matter_officers actually tracks.
    const { resolved: previousOfficerSlackIds } = await supabase.getMatterOfficersForSlack(matterId);
    const toRemove = previousOfficerSlackIds.filter((id) => currentMemberIds.has(id) && !desiredSlackIds.has(id));

    if (toInvite.length > 0) {
      const inviteResult = await slackApi.inviteMembers(matter.slack_channel_id, toInvite);
      if (!inviteResult.ok && inviteResult.error !== 'already_in_channel') {
        await supabase.insertSystemHealthLog({
          job_name: 'SyncOfficersToSlack', status: 'FAILURE',
          log_details: `Matter id ${matterId}: invite failed -- ${inviteResult.error}`
        });
      }
    }
    for (const slackId of toRemove) {
      const removeResult = await slackApi.removeMember(matter.slack_channel_id, slackId);
      if (!removeResult.ok && removeResult.error !== 'not_in_channel') {
        await supabase.insertSystemHealthLog({
          job_name: 'SyncOfficersToSlack', status: 'FAILURE',
          log_details: `Matter id ${matterId}: remove failed for ${slackId} -- ${removeResult.error}`
        });
      }
    }
  } catch (err) {
    await supabase.insertSystemHealthLog({
      job_name: 'SyncOfficersToSlack', status: 'FAILURE',
      log_details: `Matter id ${matterId}: Slack officer sync threw -- ${err.message}`
    });
  }
}

export async function handleUpdateMatter(payload, supabase, staff, slack, slackApi) {
  if (!payload.matterId) return jsonResponse({ success: false, message: 'Missing required field: matterId.' });

  const fields = {};
  if (payload.clientName !== undefined) fields.client_name = payload.clientName;
  if (payload.clientEmail !== undefined) fields.client_email = payload.clientEmail;
  if (payload.status !== undefined) fields.status = payload.status;
  if (payload.progressPct !== undefined) fields.progress_pct = payload.progressPct;
  if (payload.driveFolderUrl !== undefined) fields.drive_folder_url = payload.driveFolderUrl;
  if (payload.slackChannelId !== undefined) fields.slack_channel_id = payload.slackChannelId;

  if (Object.keys(fields).length > 0) {
    const result = await supabase.updateMatter(payload.matterId, fields);
    if (!result.success) return jsonResponse({ success: false, message: result.message });
  }

  if (payload.officerStaffIds !== undefined) {
    try {
      await supabase.setMatterOfficers(payload.matterId, payload.officerStaffIds);
    } catch (err) {
      return jsonResponse({ success: false, message: `Matter fields saved, but officer assignment failed: ${err.message}` });
    }

    await syncOfficersToSlack(supabase, slackApi, payload.matterId, payload.officerStaffIds);
  }

  // Refresh the pinned card + channel topic whenever anything that could
  // change what they say has changed -- status/progress edits and
  // officer edits both qualify. Previously nothing re-ran this after
  // initial channel creation, which is why the pinned tracker never
  // reflected officer changes.
  if (Object.keys(fields).length > 0 || payload.officerStaffIds !== undefined) {
    await refreshSlackPresence(supabase, slack, slackApi, payload.matterId);
  }

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'update_matter', tableName: 'matters',
    recordId: payload.matterId, detail: { ...fields, officerStaffIds: payload.officerStaffIds }
  });

  return jsonResponse({ success: true });
}

/**
 * Hard delete. Expected to fail for any matter with real activity
 * against it (tasks, comments, officers, a linked lead) -- see
 * clients.js's deleteMatter. In practice this mainly exists to clean up
 * test matters created while trying out previewRefNo/createMatter.
 */
export async function handleDeleteMatter(payload, supabase, staff) {
  if (!payload.matterId) return jsonResponse({ success: false, message: 'Missing required field: matterId.' });

  const result = await supabase.deleteMatter(payload.matterId);
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'delete_matter', tableName: 'matters', recordId: payload.matterId
  });

  return jsonResponse({ success: true });
}

// --- Task blueprint config (Phase 8) ---

export async function handleListConfigTaskTemplates(payload, supabase) {
  if (!payload.projectTypeId) return jsonResponse({ success: false, message: 'Missing required field: projectTypeId.' });
  const templates = await supabase.listConfigTaskTemplatesFor(payload.projectTypeId);
  return jsonResponse({ success: true, templates });
}

export async function handleAddConfigTaskTemplate(payload, supabase, staff) {
  if (!payload.projectTypeId || !payload.title || payload.sequence === undefined) {
    return jsonResponse({ success: false, message: 'Missing required fields: projectTypeId, title, sequence.' });
  }
  const sequence = Number(payload.sequence);
  if (!Number.isInteger(sequence) || sequence < 1) {
    return jsonResponse({ success: false, message: 'sequence must be a positive integer -- it controls task order within the blueprint.' });
  }

  const result = await supabase.insertConfigTaskTemplate({
    project_type_id: payload.projectTypeId,
    title: payload.title,
    sequence,
    default_assigned_staff_id: payload.defaultAssignedStaffId || null
  });
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'add_task_template', tableName: 'config_task_templates',
    recordId: result.data.id, detail: { projectTypeId: payload.projectTypeId, title: payload.title, sequence }
  });

  return jsonResponse({ success: true, template: result.data });
}

export async function handleUpdateConfigTaskTemplate(payload, supabase, staff) {
  if (!payload.templateId) return jsonResponse({ success: false, message: 'Missing required field: templateId.' });

  const fields = {};
  if (payload.title !== undefined) fields.title = payload.title;
  if (payload.sequence !== undefined) {
    const sequence = Number(payload.sequence);
    if (!Number.isInteger(sequence) || sequence < 1) {
      return jsonResponse({ success: false, message: 'sequence must be a positive integer.' });
    }
    fields.sequence = sequence;
  }
  if (payload.defaultAssignedStaffId !== undefined) fields.default_assigned_staff_id = payload.defaultAssignedStaffId;
  if (Object.keys(fields).length === 0) return jsonResponse({ success: false, message: 'No editable fields provided.' });

  const result = await supabase.updateConfigTaskTemplate(payload.templateId, fields);
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'update_task_template', tableName: 'config_task_templates',
    recordId: payload.templateId, detail: fields
  });

  return jsonResponse({ success: true, template: result.data });
}

export async function handleDeleteConfigTaskTemplate(payload, supabase, staff) {
  if (!payload.templateId) return jsonResponse({ success: false, message: 'Missing required field: templateId.' });

  const result = await supabase.deleteConfigTaskTemplate(payload.templateId);
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'delete_task_template', tableName: 'config_task_templates', recordId: payload.templateId
  });

  return jsonResponse({ success: true });
}

export async function handleListLeads(payload, supabase) {
  const leads = await supabase.listLeads();
  return jsonResponse({ success: true, leads });
}

/** Manual lead entry for leads that didn't come through email intake
 *  (writeLead) -- phone calls, walk-ins, etc. Goes through the same
 *  'Pending' -> promoteLeads/skipLead lifecycle as email-sourced leads. */
export async function handleAddLead(payload, supabase, staff) {
  if (!payload.leadName || !payload.leadEmail) {
    return jsonResponse({ success: false, message: 'Missing required fields: leadName, leadEmail.' });
  }

  const result = await supabase.insertLeadManual({
    lead_name: payload.leadName,
    lead_email: payload.leadEmail,
    lead_phone: payload.leadPhone || null,
    inquiry_notes: payload.inquiryNotes || null,
    project_type_id: payload.projectTypeId || null
  });
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'add_lead_manual', tableName: 'response_leads',
    recordId: result.data.id, detail: { leadName: payload.leadName, leadEmail: payload.leadEmail }
  });

  return jsonResponse({ success: true, lead: result.data });
}

/** Marks a single lead 'Skipped' without promoting it -- distinct from
 *  promoteLeads' own automatic duplicate-skip logic (see promoteOneLead's
 *  caller), this is a manual "we're not pursuing this one" action. */
export async function handleSkipLead(payload, supabase, staff) {
  if (!payload.leadId) return jsonResponse({ success: false, message: 'Missing required field: leadId.' });

  await supabase.updateLead(payload.leadId, { acknowledge_status: 'Skipped' });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'skip_lead_manual', tableName: 'response_leads', recordId: payload.leadId
  });

  return jsonResponse({ success: true });
}

// --- Master tasks (Phase 9) ---

export async function handleListMasterTasks(payload, supabase) {
  if (!payload.matterId) return jsonResponse({ success: false, message: 'Missing required field: matterId.' });
  const tasks = await supabase.listMasterTasksFor(payload.matterId);
  return jsonResponse({ success: true, tasks });
}

export async function handleAddMasterTask(payload, supabase, staff) {
  if (!payload.matterId || !payload.title || payload.sequence === undefined) {
    return jsonResponse({ success: false, message: 'Missing required fields: matterId, title, sequence.' });
  }
  const sequence = Number(payload.sequence);
  if (!Number.isInteger(sequence) || sequence < 1) {
    return jsonResponse({ success: false, message: 'sequence must be a positive integer.' });
  }

  const result = await supabase.insertMasterTask({
    matter_id: payload.matterId,
    title: payload.title,
    sequence,
    is_completed: false,
    assigned_staff_id: payload.assignedStaffId || null
  });
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'add_master_task', tableName: 'master_tasks',
    recordId: result.data.id, detail: { matterId: payload.matterId, title: payload.title }
  });

  return jsonResponse({ success: true, task: result.data });
}

/**
 * Toggling isCompleted also sets/clears completion_date automatically
 * (today's date when marking complete, null when un-completing) --
 * matches what the deployed-blueprint tasks would get from the original
 * Apps Script flow, so admin-toggled tasks behave the same as
 * system-completed ones rather than needing a separate manual date entry.
 */
export async function handleUpdateMasterTask(payload, supabase, staff) {
  if (!payload.taskId) return jsonResponse({ success: false, message: 'Missing required field: taskId.' });

  const fields = {};
  if (payload.title !== undefined) fields.title = payload.title;
  if (payload.sequence !== undefined) {
    const sequence = Number(payload.sequence);
    if (!Number.isInteger(sequence) || sequence < 1) {
      return jsonResponse({ success: false, message: 'sequence must be a positive integer.' });
    }
    fields.sequence = sequence;
  }
  if (payload.assignedStaffId !== undefined) fields.assigned_staff_id = payload.assignedStaffId;
  if (payload.isCompleted !== undefined) {
    fields.is_completed = !!payload.isCompleted;
    fields.completion_date = payload.isCompleted ? new Date().toISOString() : null;
  }
  if (Object.keys(fields).length === 0) return jsonResponse({ success: false, message: 'No editable fields provided.' });

  const result = await supabase.updateMasterTask(payload.taskId, fields);
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'update_master_task', tableName: 'master_tasks',
    recordId: payload.taskId, detail: fields
  });

  return jsonResponse({ success: true, task: result.data });
}

export async function handleDeleteMasterTask(payload, supabase, staff) {
  if (!payload.taskId) return jsonResponse({ success: false, message: 'Missing required field: taskId.' });

  const result = await supabase.deleteMasterTask(payload.taskId);
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'delete_master_task', tableName: 'master_tasks', recordId: payload.taskId
  });

  return jsonResponse({ success: true });
}

// --- Master comments (Phase 9) ---

export async function handleListMasterComments(payload, supabase) {
  if (!payload.matterId) return jsonResponse({ success: false, message: 'Missing required field: matterId.' });
  const comments = await supabase.listMasterCommentsFor(payload.matterId);
  return jsonResponse({ success: true, comments });
}

export async function handleAddMasterComment(payload, supabase, staff) {
  if (!payload.matterId || !payload.commentText) {
    return jsonResponse({ success: false, message: 'Missing required fields: matterId, commentText.' });
  }

  if (payload.taskId) {
    const belongs = await supabase.taskBelongsToMatter(payload.taskId, payload.matterId);
    if (!belongs) {
      return jsonResponse({ success: false, message: `Task ${payload.taskId} does not belong to this matter — refusing to write a mismatched comment. Refresh and try again.` });
    }
  }

  const result = await supabase.insertMasterComment({
    matter_id: payload.matterId,
    task_id: payload.taskId || null,
    author: staff.name,
    comment_text: payload.commentText,
    comment_status: 'Active'
  });
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'add_master_comment', tableName: 'master_comments', recordId: result.data.id
  });

  return jsonResponse({ success: true, comment: result.data });
}

/** Soft delete only -- sets comment_status='Deleted' rather than a real
 *  DELETE. There's deliberately no hard-delete action for comments. */
export async function handleDeleteMasterComment(payload, supabase, staff) {
  if (!payload.commentId) return jsonResponse({ success: false, message: 'Missing required field: commentId.' });

  const result = await supabase.updateMasterComment(payload.commentId, { comment_status: 'Deleted' });
  if (!result.success) return jsonResponse({ success: false, message: result.message });

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'delete_master_comment', tableName: 'master_comments', recordId: payload.commentId
  });

  return jsonResponse({ success: true });
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

/** Trivial by design -- requireStaff() has already done all the real work
 *  (verified the JWT, confirmed it's linked to an active staff row)
 *  before this ever runs. Exists so the frontend can explicitly check
 *  "am I an authorized staff member" right after sign-in and force a
 *  sign-out with a clear message if not, instead of leaving a
 *  self-registered-but-unauthorized account sitting on a dashboard where
 *  every action just fails one by one. */
export async function handleWhoAmI(payload, supabase, staff) {
  return jsonResponse({ success: true, staff });
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

/**
 * Best-effort wrapper for automatic provisioning (as opposed to
 * handleProvisionSlackWorkflow's manual path, which surfaces the real
 * error to the caller). A Slack outage or missing config shouldn't block
 * matter creation itself -- log it to system_health_logs and move on,
 * same resilience philosophy as deployBlueprintsForMatter's 0-tasks case
 * just above.
 */
async function provisionSlackBestEffort(supabase, slack, slackApi, matterId, refNo, jobName) {
  try {
    const result = await provisionSlackForMatter(supabase, slack, slackApi, matterId);
    if (!result.success) {
      await supabase.insertSystemHealthLog({
        job_name: jobName, status: 'FAILURE',
        log_details: `Matter ${refNo}: Slack provisioning failed -- ${result.message}`
      });
    }
  } catch (err) {
    await supabase.insertSystemHealthLog({
      job_name: jobName, status: 'FAILURE',
      log_details: `Matter ${refNo}: Slack provisioning threw -- ${err.message}`
    });
  }
}

async function promoteOneLead(supabase, lead, slack, slackApi) {
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

  await assignDefaultAdminOfficer(supabase, newMatter.id);
  await provisionSlackBestEffort(supabase, slack, slackApi, newMatter.id, refNo, 'PromoteLeadToMatter');

  await supabase.updateLead(lead.id, { acknowledge_status: 'Converted', converted_matter_id: newMatter.id });
  return refNo;
}

export async function handlePromoteLeads(payload, supabase, staff, slack, slackApi) {
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
      const refNo = await promoteOneLead(supabase, lead, slack, slackApi);
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

// =========================================================================
// CONTENT / BLOG POSTS (Phase 10). The Astro repo's src/content/blog/*.md
// files are the single source of truth -- deliberately NOT mirrored into a
// Supabase table (decision: keep git as the only place "what the site's
// content is" lives, for one source of truth and free version history, at
// the cost of a GitHub API round trip per file).
// =========================================================================

const BLOG_DIR = 'src/content/blog';

function slugify(title) {
  return String(title).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Hand-rolled and deliberately minimal -- this only ever reads
 *  frontmatter that buildFrontmatter (below) wrote, so it doesn't need to
 *  be a general YAML parser. Not safe to point at arbitrary external
 *  Markdown. */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const [, frontBlock, body] = match;
  const data = {};
  frontBlock.split(/\r?\n/).forEach((line) => {
    const lineMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!lineMatch) return;
    const [, key, rawValue] = lineMatch;
    let value = rawValue.trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { /* leave as raw string */ }
    }
    data[key] = value;
  });
  return { data, body: body.replace(/^\r?\n/, '') };
}

/** JSON.stringify on title/excerpt doubles as YAML double-quoted-scalar
 *  escaping (YAML's flow scalars are a superset of JSON strings) -- both a
 *  JS and a YAML-safe encoder with no extra dependency. */
function buildFrontmatter({ title, date, excerpt, draft }) {
  const lines = ['---', `title: ${JSON.stringify(title)}`, `date: ${date}`, `excerpt: ${JSON.stringify(excerpt)}`];
  if (draft) lines.push('draft: true');
  lines.push('---', '');
  return lines.join('\n');
}

/** List view only returns frontmatter, not body -- avoids fetching+parsing
 *  every post's full content just to render a list of titles. */
export async function handleListPosts(payload, github) {
  let files;
  try {
    files = await github.listDir(BLOG_DIR);
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  }

  const posts = await Promise.all(files.map(async (file) => {
    const fileData = await github.getFile(file.path);
    const { data } = parseFrontmatter(fileData.content);
    return {
      slug: file.name.replace(/\.md$/, ''),
      title: data.title || file.name,
      date: data.date || null,
      excerpt: data.excerpt || '',
      draft: !!data.draft
    };
  }));

  posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return jsonResponse({ success: true, posts });
}

export async function handleGetPost(payload, github) {
  if (!payload.slug) return jsonResponse({ success: false, message: 'Missing required field: slug.' });
  const fileData = await github.getFile(`${BLOG_DIR}/${payload.slug}.md`);
  if (!fileData) return jsonResponse({ success: false, message: `Post "${payload.slug}" not found.` });
  const { data, body } = parseFrontmatter(fileData.content);
  return jsonResponse({ success: true, post: { slug: payload.slug, ...data, body } });
}

/**
 * Creates or updates a post in one GitHub commit. `slug` is the filename
 * and the live URL, so it's never editable once set: the caller passes it
 * back unchanged to update a post, or omits it to create one, in which
 * case it's derived from the title. A title collision gets a numeric
 * suffix rather than silently overwriting an unrelated existing post.
 */
export async function handleSavePost(payload, github, supabase, staff) {
  if (!payload.title || !payload.date || !payload.excerpt || !payload.body) {
    return jsonResponse({ success: false, message: 'Missing required fields: title, date, excerpt, body.' });
  }

  let slug = payload.slug;
  let existing = null;
  if (slug) {
    existing = await github.getFile(`${BLOG_DIR}/${slug}.md`);
    if (!existing) return jsonResponse({ success: false, message: `Post "${slug}" not found.` });
  } else {
    const base = slugify(payload.title);
    slug = base;
    let n = 2;
    // Sequential by nature -- each check depends on the previous suffix not existing.
    // eslint-disable-next-line no-await-in-loop
    while (await github.getFile(`${BLOG_DIR}/${slug}.md`)) {
      slug = `${base}-${n}`;
      n += 1;
    }
  }

  const content = buildFrontmatter(payload) + payload.body.trim() + '\n';

  try {
    await github.putFile(
      `${BLOG_DIR}/${slug}.md`,
      content,
      `${existing ? 'Update' : 'Add'} blog post: ${payload.title}`,
      existing ? existing.sha : undefined
    );
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  }

  await supabase.insertAuditLog({
    staffId: staff.id, action: existing ? 'update_post' : 'add_post',
    tableName: 'blog_posts', recordId: null, detail: { slug, title: payload.title }
  });

  return jsonResponse({ success: true, slug });
}

export async function handleDeletePost(payload, github, supabase, staff) {
  if (!payload.slug) return jsonResponse({ success: false, message: 'Missing required field: slug.' });
  const filePath = `${BLOG_DIR}/${payload.slug}.md`;
  const existing = await github.getFile(filePath);
  if (!existing) return jsonResponse({ success: false, message: `Post "${payload.slug}" not found.` });

  try {
    await github.deleteFile(filePath, existing.sha, `Delete blog post: ${payload.slug}`);
  } catch (err) {
    return jsonResponse({ success: false, message: err.message });
  }

  await supabase.insertAuditLog({
    staffId: staff.id, action: 'delete_post', tableName: 'blog_posts', recordId: null, detail: { slug: payload.slug }
  });

  return jsonResponse({ success: true });
}

// =========================================================================
// AI-ASSISTED CONTENT REVIEW (Phase 11). Deliberately split into two parts
// that never touch each other's job:
//   - Scheduling suggestion: plain date arithmetic over real post history
//     pulled from GitHub. No model involved -- a suggested publish date is
//     a fact people will act on, not a judgment call worth an LLM's
//     nondeterminism.
//   - Everything else (title/SEO/clarity/sourcing flags): genuinely
//     judgment calls, where a model is useful precisely because it's
//     giving an opinion, not a fact. Every finding is worded as a
//     suggestion for a human to accept or reject -- see the prompt's
//     explicit "flag, don't assert" instruction for sourcingFlags in
//     particular, since a law firm publishing an AI's confidently wrong
//     legal claim is a real reputational risk, not a hypothetical one.
// =========================================================================

const REVIEW_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

/** Suggests a publish date at least MIN_GAP_DAYS after the most recently
 *  scheduled/published post, using the average gap between the last few
 *  posts as the step size once there's enough history to have one.
 *  Never returns a date already in use. */
function suggestScheduleDate(existingDates) {
  const MIN_GAP_DAYS = 3;
  const DEFAULT_GAP_DAYS = 7;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const parsed = existingDates
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.valueOf()))
    .sort((a, b) => a - b);

  if (parsed.length === 0) {
    return new Date(Date.now() + DEFAULT_GAP_DAYS * DAY_MS).toISOString().slice(0, 10);
  }

  const last = parsed[parsed.length - 1];
  let gapDays = DEFAULT_GAP_DAYS;
  if (parsed.length >= 2) {
    const recentGaps = [];
    for (let i = Math.max(1, parsed.length - 3); i < parsed.length; i++) {
      recentGaps.push((parsed[i] - parsed[i - 1]) / DAY_MS);
    }
    const avg = recentGaps.reduce((sum, g) => sum + g, 0) / recentGaps.length;
    gapDays = Math.max(MIN_GAP_DAYS, Math.round(avg));
  }

  let candidate = new Date(Math.max(last.valueOf(), Date.now()) + gapDays * DAY_MS);
  const usedDates = new Set(parsed.map((d) => d.toISOString().slice(0, 10)));
  while (usedDates.has(candidate.toISOString().slice(0, 10))) {
    candidate = new Date(candidate.valueOf() + DAY_MS);
  }
  return candidate.toISOString().slice(0, 10);
}

const REVIEW_SYSTEM_PROMPT = `You are an editorial assistant reviewing a draft blog post for a Malaysian law firm's website before a human editor publishes it. Respond with ONLY a single valid JSON object, no other text, matching exactly this shape:
{
  "titleFeedback": "1-2 sentences on the title's clarity and search-friendliness",
  "metaDescriptionSuggestion": "a single suggested meta description, under 160 characters",
  "keywordSuggestions": ["3-6 short phrases a reader might search for that relate to this post"],
  "clarityNotes": "1-3 sentences on structure, tone, or readability",
  "sourcingFlags": ["specific claims, statistics, or statements of law in the draft that should be checked against a real source before publishing -- empty array if none stand out"],
  "overallNote": "one sentence summarizing your overall impression"
}
Do not invent facts, sources, or legal citations. sourcingFlags should name what needs checking, not claim to have checked it. If the draft is short or thin, say so plainly rather than inventing detail to praise.`;

/**
 * payload: { title, excerpt, body }. Fetches existing post dates itself
 * (via github) rather than trusting the caller to supply accurate
 * scheduling context.
 */
export async function handleReviewPost(payload, ai, github) {
  if (!payload.title || !payload.body) {
    return jsonResponse({ success: false, message: 'Missing required fields: title, body.' });
  }

  let existingDates = [];
  try {
    const files = await github.listDir(BLOG_DIR);
    const parsedPosts = await Promise.all(files.map(async (file) => {
      const fileData = await github.getFile(file.path);
      const { data } = parseFrontmatter(fileData.content);
      return data.date;
    }));
    existingDates = parsedPosts.filter(Boolean);
  } catch (err) {
    // Scheduling context is a nice-to-have, not required -- fall through
    // with an empty history rather than failing the whole review over it.
    console.error(`reviewPost: failed to read post history for scheduling: ${err.message}`);
  }
  const scheduleSuggestion = suggestScheduleDate(existingDates);

  const userContent = `Title: ${payload.title}\n\nExcerpt: ${payload.excerpt || '(none provided)'}\n\nBody:\n${payload.body}`;

  let aiResult;
  try {
    aiResult = await ai.run(REVIEW_MODEL, {
      messages: [
        { role: 'system', content: REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ]
    });
  } catch (err) {
    return jsonResponse({
      success: true,
      review: { scheduleSuggestion, aiAvailable: false, aiError: err.message }
    });
  }

  const raw = (aiResult && aiResult.response) || '';
  let parsed;
  try {
    // Models sometimes wrap JSON in a code fence despite instructions --
    // strip one if present before parsing, rather than failing on it.
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return jsonResponse({
      success: true,
      review: { scheduleSuggestion, aiAvailable: true, aiParseError: true, rawResponse: raw }
    });
  }

  return jsonResponse({ success: true, review: { ...parsed, scheduleSuggestion, aiAvailable: true } });
}
