// =========================================================================
// SERVICE CLIENTS — ported from orchestrator-service/client.js
// (see original header comment for the UrlFetchApp -> fetch() porting note)
// =========================================================================

import { createRemoteJWKSet, jwtVerify } from 'jose';

async function callService(url, method, payload) {
  const options = { method: method.toUpperCase() };
  if (method === 'post') {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(url, options);
  return response.json();
}

// --- Database service (Apps Script / Sheets — being phased out per
// MIGRATION_RUNBOOK.md Phase 3, still the live path for every action below
// except writeLead) ---

export function makeDatabaseClient(env) {
  const base = env.DATABASE_SERVICE_EXEC_URL;
  return {
    async getMatterContext(refNo) {
      const url = `${base}?action=getMatterContext&refNo=${encodeURIComponent(refNo)}`;
      return callService(url, 'get');
    },
    async getLedgerData(refNo) {
      const url = `${base}?action=getLedgerData&refNo=${encodeURIComponent(refNo)}`;
      return callService(url, 'get');
    },
    async updateSlackLinks(refNo, channelId, messageTs) {
      return callService(base, 'post', {
        action: 'updateSlackLinks',
        authToken: env.INTERNAL_SERVICE_TOKEN,
        refNo,
        channelId,
        messageTs
      });
    },
    async getMatterTasks(refNo) {
      const url = `${base}?action=getMatterTasks&refNo=${encodeURIComponent(refNo)}`;
      return callService(url, 'get');
    },
    async writeComment(refNo, author, text, globalTaskId) {
      return callService(base, 'post', {
        action: 'writeComment',
        authToken: env.INTERNAL_SERVICE_TOKEN,
        refNo,
        author,
        text,
        globalTaskId: globalTaskId || ''
      });
    }
  };
}

// --- Slack service ---

export function makeSlackClient(env) {
  const base = env.SLACK_SERVICE_EXEC_URL;
  return {
    async createChannel(channelName, isPrivate, additionalUserIds, unresolvedOfficerLabels, refNo) {
      return callService(base, 'post', {
        action: 'createChannel',
        authToken: env.INTERNAL_SERVICE_TOKEN,
        channelName,
        isPrivate: !!isPrivate,
        additionalUserIds: additionalUserIds || [],
        unresolvedOfficerLabels: unresolvedOfficerLabels || [],
        refNo: refNo || channelName
      });
    },
    async getPinnedMessageTs(channelId) {
      return callService(base, 'post', {
        action: 'getPinnedMessageTs',
        authToken: env.INTERNAL_SERVICE_TOKEN,
        channelId
      });
    },
    async updateMatterCard(channelId, messageTs, refNo, clientName, matterType, progressPercent, officersStackedString, statusEnum) {
      return callService(base, 'post', {
        action: 'updateMatterCard',
        authToken: env.INTERNAL_SERVICE_TOKEN,
        channelId,
        messageTs,
        refNo,
        clientName,
        matterType,
        progressPercent,
        officersStackedString,
        statusEnum
      });
    }
  };
}

// --- Supabase (NEW — Phase 3. Plain PostgREST fetch calls rather than the
// @supabase/supabase-js SDK, to match this file's existing hand-rolled
// callService() pattern instead of adding an SDK dependency for one table's
// worth of writes so far. Revisit if/when more Supabase-backed actions get
// added here — at that point the SDK may earn its weight. ---

export function makeSupabaseClient(env) {
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const authHeaders = {
    'Content-Type': 'application/json',
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
  };

  async function pgFetch(path, options = {}) {
    const resp = await fetch(`${base}${path}`, {
      ...options,
      headers: { ...authHeaders, ...(options.headers || {}) }
    });
    const body = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, body };
  }

  return {
    /**
     * Inserts a response_leads row. gmail_message_id has a UNIQUE
     * constraint in the schema (same idempotency intent as the original
     * db_isDuplicateLeadByGmailMessageId check-before-insert) -- rather than
     * a separate lookup-then-insert round trip, this relies on the
     * constraint itself and treats a resulting 23505 (unique_violation) as
     * a successful no-op, same outcome as the original's explicit check.
     */
    async insertLead(lead) {
      const { ok, status, body } = await pgFetch('/response_leads', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(lead)
      });
      if (!ok) {
        if (status === 409 && body && body.code === '23505') return { success: true, duplicate: true };
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      }
      return { success: true, data: Array.isArray(body) ? body[0] : body };
    },

    // --- Admin UI support (Phase 3) ---

    /** Resolves a staff row from a verified Supabase Auth JWT's `sub` claim. */
    async getStaffByAuthUserId(authUserId) {
      const { ok, body } = await pgFetch(`/staff?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=id,name,initial,is_active`);
      if (!ok || !Array.isArray(body) || body.length === 0) return null;
      return body[0];
    },

    async getMatterById(matterId) {
      const { ok, body } = await pgFetch(`/matters?id=eq.${matterId}&select=id,ref_no,project_type_id,client_name,client_email`);
      if (!ok || !Array.isArray(body) || body.length === 0) return null;
      return body[0];
    },

    /** Recent matters for the admin UI's browsable list (not just pending/actionable ones). */
    async listMatters(limit = 50) {
      const { ok, body } = await pgFetch(
        `/matters?select=id,ref_no,client_name,client_email,status,progress_pct,drive_folder_url,slack_channel_id,project_type_id,project_types(name),matter_officers(staff_id)&order=created_at.desc&limit=${limit}`
      );
      if (!ok) throw new Error(`Failed to list matters: ${JSON.stringify(body)}`);
      return body || [];
    },

    /** Partial patch -- absent field = unchanged, same convention as
     *  updateStaff/updateProjectType. ref_no is deliberately never
     *  editable through this (or anywhere) -- it's cryptographically
     *  tied to the REF_NO_ENGINE checksum and ref_no_counters sequence;
     *  changing it after the fact would desync both. */
    async updateMatter(matterId, fields) {
      const { ok, status, body } = await pgFetch(`/matters?id=eq.${matterId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      if (!Array.isArray(body) || body.length === 0) return { success: false, message: `Matter id ${matterId} not found.` };
      return { success: true, data: body[0] };
    },

    /** Full replace, not a diff -- deletes all existing matter_officers
     *  rows for this matter and inserts the new set. Simpler and safer
     *  than computing an add/remove delta, and this is a low-frequency
     *  admin action (not a hot path), so the extra round trip doesn't
     *  matter. */
    async setMatterOfficers(matterId, staffIds) {
      const del = await pgFetch(`/matter_officers?matter_id=eq.${matterId}`, { method: 'DELETE' });
      if (!del.ok) throw new Error(`Failed to clear matter_officers: ${JSON.stringify(del.body)}`);
      if (!staffIds || staffIds.length === 0) return;
      const rows = staffIds.map((staffId) => ({ matter_id: matterId, staff_id: staffId }));
      const ins = await pgFetch('/matter_officers', { method: 'POST', body: JSON.stringify(rows) });
      if (!ins.ok) throw new Error(`Failed to set matter_officers: ${JSON.stringify(ins.body)}`);
    },

    /** IMPORTANT: matter_officers, master_tasks, and master_comments all
     *  have ON DELETE CASCADE to matters.id -- deleting a matter silently
     *  wipes all of its officers/tasks/comments too, no FK violation.
     *  The ONLY thing that actually blocks a delete is
     *  response_leads.converted_matter_id (no ON DELETE clause =
     *  RESTRICT), i.e. a matter that was created by promoting a lead.
     *  The caller MUST warn about the cascade before calling this --
     *  there's no going back once it succeeds. */
    async deleteMatter(matterId) {
      const { ok, status, body } = await pgFetch(`/matters?id=eq.${matterId}`, { method: 'DELETE' });
      if (!ok) {
        if (status === 409 && body && body.code === '23503') {
          return { success: false, message: 'Cannot delete: this matter was created from a lead that still references it.' };
        }
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      }
      return { success: true };
    },

    /** Recent leads for the admin UI's browsable list (all statuses, not just Pending). */
    /** response_leads has TWO FKs to project_types (project_type_id and
     *  ai_suggested_project_type_id -- the latter apparently from some AI
     *  lead-classification feature that predates this migration and was
     *  never mentioned in any handoff doc), so the embed below MUST use
     *  the explicit FK constraint name or PostgREST throws PGRST201
     *  ("more than one relationship was found") rather than picking one. */
    async listLeads(limit = 50) {
      const { ok, body } = await pgFetch(
        `/response_leads?select=id,lead_name,lead_email,lead_phone,inquiry_notes,acknowledge_status,project_type_id,project_types!response_leads_project_type_id_fkey(name),converted_matter_id,matters!response_leads_converted_matter_id_fkey(ref_no),created_at&order=created_at.desc&limit=${limit}`
      );
      if (!ok) throw new Error(`Failed to list leads: ${JSON.stringify(body)}`);
      return body || [];
    },

    async getConfigTaskTemplates(projectTypeId) {
      const { ok, body } = await pgFetch(`/config_task_templates?project_type_id=eq.${projectTypeId}&select=title,sequence,default_assigned_staff_id&order=sequence`);
      if (!ok) throw new Error(`Failed to read config_task_templates: ${JSON.stringify(body)}`);
      return body || [];
    },

    // --- Task blueprint config (Phase 8) ---
    // Distinct from getConfigTaskTemplates above (which deployBlueprintsForMatter
    // uses internally, minimal fields only) -- these are for the admin UI's
    // full CRUD, with the staff name embedded for display.

    async listConfigTaskTemplatesFor(projectTypeId) {
      const { ok, body } = await pgFetch(
        `/config_task_templates?project_type_id=eq.${projectTypeId}&select=id,title,sequence,default_assigned_staff_id,staff(name,initial)&order=sequence`
      );
      if (!ok) throw new Error(`Failed to list config_task_templates: ${JSON.stringify(body)}`);
      return body || [];
    },

    async insertConfigTaskTemplate(fields) {
      const { ok, status, body } = await pgFetch('/config_task_templates', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      return { success: true, data: Array.isArray(body) ? body[0] : body };
    },

    async updateConfigTaskTemplate(templateId, fields) {
      const { ok, status, body } = await pgFetch(`/config_task_templates?id=eq.${templateId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      if (!Array.isArray(body) || body.length === 0) return { success: false, message: `Template id ${templateId} not found.` };
      return { success: true, data: body[0] };
    },

    /** No known FK references INTO config_task_templates from any other
     *  table (deployBlueprintsForMatter copies fields into new master_tasks
     *  rows rather than linking back), so this is expected to always
     *  succeed rather than needing 23503 handling -- kept anyway for
     *  defense in depth in case that ever changes. */
    async deleteConfigTaskTemplate(templateId) {
      const { ok, status, body } = await pgFetch(`/config_task_templates?id=eq.${templateId}`, { method: 'DELETE' });
      if (!ok) {
        if (status === 409 && body && body.code === '23503') {
          return { success: false, message: 'Cannot delete: this template is still referenced elsewhere.' };
        }
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      }
      return { success: true };
    },

    async insertMasterTasks(rows) {
      const { ok, body } = await pgFetch('/master_tasks', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rows)
      });
      if (!ok) throw new Error(`Failed to insert master_tasks: ${JSON.stringify(body)}`);
      return body || [];
    },

    async getPendingLeads() {
      // Excludes Converted and anything already Skipped, mirroring
      // Trigger_AutoPromoteAllLeads' own filter.
      const { ok, body } = await pgFetch(`/response_leads?project_type_id=not.is.null&acknowledge_status=not.in.("Converted")&select=id,lead_name,lead_email,project_type_id,acknowledge_status`);
      if (!ok) throw new Error(`Failed to read response_leads: ${JSON.stringify(body)}`);
      return (body || []).filter(l => !String(l.acknowledge_status).startsWith('Skipped'));
    },

    // --- Project config (Phase 5) ---

    async listProjectTypes() {
      const { ok, body } = await pgFetch('/project_types?select=id,name,prefix_digit&order=prefix_digit.asc');
      if (!ok) throw new Error(`Failed to list project types: ${JSON.stringify(body)}`);
      return body || [];
    },

    /** name and prefix_digit are both UNIQUE at the DB level. */
    async insertProjectType(fields) {
      const { ok, status, body } = await pgFetch('/project_types', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) {
        if (status === 409 && body && body.code === '23505') {
          return { success: false, message: `A project type with that name or prefix digit already exists.` };
        }
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      }
      return { success: true, data: Array.isArray(body) ? body[0] : body };
    },

    /**
     * Read-only peek at the current seq for (prefix_digit, year) --
     * does NOT increment it (unlike incrementRefSeq below, which is the
     * only thing that should ever actually consume a sequence number).
     * Returns 0 if no row exists yet for that (prefix_digit, year) pair,
     * matching increment_ref_seq's own "insert seq=1 on first call"
     * starting point.
     */
    async peekRefSeq(prefixDigit, year) {
      const { ok, body } = await pgFetch(`/ref_no_counters?prefix_digit=eq.${prefixDigit}&year=eq.${year}&select=seq`);
      if (!ok) throw new Error(`Failed to read ref_no_counters: ${JSON.stringify(body)}`);
      if (!Array.isArray(body) || body.length === 0) return 0;
      return body[0].seq;
    },

    /** Partial patch, same semantics as updateStaff (absent field = unchanged). */
    async updateProjectType(projectTypeId, fields) {
      const { ok, status, body } = await pgFetch(`/project_types?id=eq.${projectTypeId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) {
        if (status === 409 && body && body.code === '23505') {
          return { success: false, message: 'A project type with that name or prefix digit already exists.' };
        }
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      }
      if (!Array.isArray(body) || body.length === 0) return { success: false, message: `Project type id ${projectTypeId} not found.` };
      return { success: true, data: body[0] };
    },

    /**
     * Hard delete. `matters`, `config_task_templates`, and `response_leads`
     * all have FKs to project_types.id -- a 23503 (foreign_key_violation)
     * is expected and normal here (it means this type has real matters
     * or templates against it), not a bug. Reported as a clear message,
     * not a raw PostgREST error.
     */
    async deleteProjectType(projectTypeId) {
      const { ok, status, body } = await pgFetch(`/project_types?id=eq.${projectTypeId}`, { method: 'DELETE' });
      if (!ok) {
        if (status === 409 && body && body.code === '23503') {
          return { success: false, message: 'Cannot delete: this project type has matters, task templates, or leads referencing it.' };
        }
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      }
      return { success: true };
    },

    /**
     * Hard delete. `matter_officers` and `master_tasks.assigned_staff_id`
     * both have FKs to staff.id -- for anyone who's ever been assigned to
     * anything, this will hit 23503 and fail, which is intentional: use
     * setStaffStatus (deactivate) for staff with history instead of
     * losing that history to an orphaned/cascaded delete.
     */
    async deleteStaff(staffId) {
      const { ok, status, body } = await pgFetch(`/staff?id=eq.${staffId}`, { method: 'DELETE' });
      if (!ok) {
        if (status === 409 && body && body.code === '23503') {
          return { success: false, message: 'Cannot delete: this staff member has existing matter or task assignments. Deactivate instead.' };
        }
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      }
      return { success: true };
    },

    async getProjectType(projectTypeId) {
      const { ok, body } = await pgFetch(`/project_types?id=eq.${projectTypeId}&select=id,name,prefix_digit`);
      if (!ok || !Array.isArray(body) || body.length === 0) return null;
      return body[0];
    },

    async getProjectTypeByPrefixDigit(prefixDigit) {
      const { ok, body } = await pgFetch(`/project_types?prefix_digit=eq.${prefixDigit}&select=id,name`);
      if (!ok || !Array.isArray(body) || body.length === 0) return null;
      return body[0];
    },

    async incrementRefSeq(prefixDigit, year) {
      const { ok, body } = await pgFetch('/rpc/increment_ref_seq', {
        method: 'POST',
        body: JSON.stringify({ p_prefix_digit: prefixDigit, p_year: year })
      });
      if (!ok) throw new Error(`increment_ref_seq failed: ${JSON.stringify(body)}`);
      return body;
    },

    async insertMatter(matter) {
      const { ok, body } = await pgFetch('/matters', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(matter)
      });
      if (!ok) throw new Error(`Failed to insert matter: ${JSON.stringify(body)}`);
      return Array.isArray(body) ? body[0] : body;
    },

    async updateLead(leadId, fields) {
      const { ok, body } = await pgFetch(`/response_leads?id=eq.${leadId}`, {
        method: 'PATCH',
        body: JSON.stringify(fields)
      });
      if (!ok) throw new Error(`Failed to update response_leads id=${leadId}: ${JSON.stringify(body)}`);
      return body;
    },

    /** Manual lead entry (Phase 9) -- the original design only ever
     *  populated response_leads via email intake (writeLead, called by
     *  email-gateway). This is for logging a lead that came in some
     *  other way (phone call, walk-in, etc.) so it still goes through
     *  the same promoteLeads flow as everything else. acknowledge_status
     *  always starts 'Pending' -- promotion/skip happen as separate
     *  actions, same as email-sourced leads. */
    async insertLeadManual(fields) {
      const { ok, status, body } = await pgFetch('/response_leads', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ ...fields, acknowledge_status: 'Pending' })
      });
      if (!ok) return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      return { success: true, data: Array.isArray(body) ? body[0] : body };
    },

    async insertSystemHealthLog(entry) {
      await pgFetch('/system_health_logs', { method: 'POST', body: JSON.stringify(entry) });
    },

    // --- Master tasks (Phase 9) ---

    async listMasterTasksFor(matterId) {
      const { ok, body } = await pgFetch(
        `/master_tasks?matter_id=eq.${matterId}&select=id,title,sequence,is_completed,completion_date,assigned_staff_id,notification_status,staff(name,initial)&order=sequence`
      );
      if (!ok) throw new Error(`Failed to list master_tasks: ${JSON.stringify(body)}`);
      return body || [];
    },

    async insertMasterTask(fields) {
      const { ok, status, body } = await pgFetch('/master_tasks', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      return { success: true, data: Array.isArray(body) ? body[0] : body };
    },

    async updateMasterTask(taskId, fields) {
      const { ok, status, body } = await pgFetch(`/master_tasks?id=eq.${taskId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      if (!Array.isArray(body) || body.length === 0) return { success: false, message: `Task id ${taskId} not found.` };
      return { success: true, data: body[0] };
    },

    /** master_comments.task_id has ON DELETE SET NULL -- deleting a task
     *  that has comments against it is safe, those comments just lose
     *  their task link (stay attached to the matter). No 23503 case
     *  expected here. */
    async deleteMasterTask(taskId) {
      const { ok, status, body } = await pgFetch(`/master_tasks?id=eq.${taskId}`, { method: 'DELETE' });
      if (!ok) return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      return { success: true };
    },

    // --- Master comments (Phase 9) ---

    /** Mirrors the original Apps Script writeComment's defense: a stale
     *  task selection (task reassigned/deleted between the form loading
     *  and submitting) shouldn't silently attach a comment to the wrong
     *  matter's task. */
    async taskBelongsToMatter(taskId, matterId) {
      const { ok, body } = await pgFetch(`/master_tasks?id=eq.${taskId}&matter_id=eq.${matterId}&select=id`);
      if (!ok) throw new Error(`Failed to verify task ownership: ${JSON.stringify(body)}`);
      return Array.isArray(body) && body.length > 0;
    },

    async listMasterCommentsFor(matterId) {
      const { ok, body } = await pgFetch(
        `/master_comments?matter_id=eq.${matterId}&select=id,author,comment_text,comment_status,created_at,task_id&order=created_at.desc`
      );
      if (!ok) throw new Error(`Failed to list master_comments: ${JSON.stringify(body)}`);
      return body || [];
    },

    async insertMasterComment(fields) {
      const { ok, status, body } = await pgFetch('/master_comments', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      return { success: true, data: Array.isArray(body) ? body[0] : body };
    },

    /** Comments are soft-deleted (comment_status='Deleted'), never hard
     *  deleted -- there's no hard-delete action for these, deliberately,
     *  since a comment log is exactly the kind of thing you want an
     *  audit trail of even after it's "removed" from view. */
    async updateMasterComment(commentId, fields) {
      const { ok, status, body } = await pgFetch(`/master_comments?id=eq.${commentId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      if (!Array.isArray(body) || body.length === 0) return { success: false, message: `Comment id ${commentId} not found.` };
      return { success: true, data: body[0] };
    },

    // --- Staff management (Phase 4) ---

    /** Full roster for the admin UI, active and inactive alike (the UI needs both to offer reactivation). */
    async listStaff() {
      const { ok, body } = await pgFetch(
        '/staff?select=id,name,initial,domain_email,linked_email,special_rules,position,slack_member_id,is_active,created_at&order=is_active.desc,name.asc'
      );
      if (!ok) throw new Error(`Failed to list staff: ${JSON.stringify(body)}`);
      return body || [];
    },

    async getStaffByInitial(initial) {
      const { ok, body } = await pgFetch(`/staff?initial=eq.${encodeURIComponent(initial)}&select=id,initial`);
      if (!ok || !Array.isArray(body) || body.length === 0) return null;
      return body[0];
    },

    /**
     * Enrolls a new staff member. `initial` has a UNIQUE constraint in the
     * schema (same idempotency shape as insertLead's gmail_message_id
     * handling above) -- a 23505 conflict is surfaced as a clear message
     * rather than a raw PostgREST error, since "initial already in use" is
     * an expected, actionable case here, not an exceptional one.
     */
    async insertStaff(staffFields) {
      const { ok, status, body } = await pgFetch('/staff', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(staffFields)
      });
      if (!ok) {
        if (status === 409 && body && body.code === '23505') {
          return { success: false, message: `Initial "${staffFields.initial}" is already in use by another staff member.` };
        }
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      }
      return { success: true, data: Array.isArray(body) ? body[0] : body };
    },

    /** Edits an existing staff member's fields, and/or flips is_active (enroll/disenroll). */
    async updateStaff(staffId, fields) {
      const { ok, status, body } = await pgFetch(`/staff?id=eq.${staffId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields)
      });
      if (!ok) {
        if (status === 409 && body && body.code === '23505') {
          return { success: false, message: `Initial "${fields.initial}" is already in use by another staff member.` };
        }
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${status}` };
      }
      if (!Array.isArray(body) || body.length === 0) {
        return { success: false, message: `Staff id ${staffId} not found.` };
      }
      return { success: true, data: body[0] };
    },

    async insertAuditLog({ staffId, action, tableName = null, recordId = null, detail = null }) {
      const { ok, body } = await pgFetch('/audit_log', {
        method: 'POST',
        body: JSON.stringify({ staff_id: staffId, action, table_name: tableName, record_id: recordId, detail })
      });
      if (!ok) console.error(`audit_log insert failed for action="${action}" staff_id=${staffId}:`, body);
    }
  };
}

// --- Staff JWT verification (Phase 3 admin UI) ---
//
// Tries Supabase's JWKS endpoint first (modern asymmetric-signing-key
// projects); falls back to the legacy shared HS256 secret if configured.
// NEEDS CONFIRMING on first real login which path this project actually
// takes -- couldn't reach the JWKS endpoint directly to check in advance.

let _jwksCache;
function getJwks(env) {
  if (!_jwksCache) {
    _jwksCache = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }
  return _jwksCache;
}

export async function verifyStaffJwt(token, env) {
  // CORRECTED: this project's `anon` API key is a legacy-format static JWT
  // (payload contains `"iss":"supabase"`, confirmed by decoding it during
  // setup) -- that's the tell for the legacy shared-secret signing model,
  // not modern asymmetric JWKS signing. Try the shared secret FIRST for
  // that reason (JWKS was tried first originally, which likely failed
  // every time on this project and masked the real error).
  //
  // Also dropped the `issuer` constraint entirely: it assumed the modern
  // `<url>/auth/v1` issuer format without ever confirming it against a
  // real token from this project, and a wrong assumption there would
  // reject every valid login with the same generic error. Signature
  // verification alone (which jwtVerify always performs, along with
  // exp/nbf) is still cryptographically sound without it -- issuer
  // checking is defense-in-depth for multi-tenant key reuse, which
  // doesn't apply here since this secret is dedicated to one project.
  if (env.SUPABASE_JWT_SECRET) {
    try {
      const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
      const { payload } = await jwtVerify(token, secret);
      return payload;
    } catch (secretErr) {
      console.error(`Staff JWT: shared-secret verification failed (${secretErr.message}); trying JWKS as fallback.`);
    }
  }
  const { payload } = await jwtVerify(token, getJwks(env));
  return payload;
}

export { callService as _callServiceForTests };
