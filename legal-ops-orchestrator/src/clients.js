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
      const { ok, body } = await pgFetch(`/matters?select=id,ref_no,client_name,status,progress_pct,project_type_id&order=created_at.desc&limit=${limit}`);
      if (!ok) throw new Error(`Failed to list matters: ${JSON.stringify(body)}`);
      return body || [];
    },

    /** Recent leads for the admin UI's browsable list (all statuses, not just Pending). */
    async listLeads(limit = 50) {
      const { ok, body } = await pgFetch(`/response_leads?select=id,lead_name,lead_email,acknowledge_status,project_type_id,created_at&order=created_at.desc&limit=${limit}`);
      if (!ok) throw new Error(`Failed to list leads: ${JSON.stringify(body)}`);
      return body || [];
    },

    async getConfigTaskTemplates(projectTypeId) {
      const { ok, body } = await pgFetch(`/config_task_templates?project_type_id=eq.${projectTypeId}&select=title,sequence,default_assigned_staff_id&order=sequence`);
      if (!ok) throw new Error(`Failed to read config_task_templates: ${JSON.stringify(body)}`);
      return body || [];
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

    async insertSystemHealthLog(entry) {
      await pgFetch('/system_health_logs', { method: 'POST', body: JSON.stringify(entry) });
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
  const issuer = `${env.SUPABASE_URL}/auth/v1`;
  try {
    const { payload } = await jwtVerify(token, getJwks(env), { issuer });
    return payload;
  } catch (jwksErr) {
    if (!env.SUPABASE_JWT_SECRET) throw jwksErr;
    const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, { issuer });
    return payload;
  }
}

export { callService as _callServiceForTests };
