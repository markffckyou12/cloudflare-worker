// =========================================================================
// SERVICE CLIENTS — ported from orchestrator-service/client.js
// (see original header comment for the UrlFetchApp -> fetch() porting note)
// =========================================================================

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
      const resp = await fetch(`${base}/response_leads`, {
        method: 'POST',
        headers: { ...authHeaders, Prefer: 'return=representation' },
        body: JSON.stringify(lead)
      });
      const body = await resp.json().catch(() => null);

      if (!resp.ok) {
        if (resp.status === 409 && body && body.code === '23505') {
          return { success: true, duplicate: true };
        }
        return { success: false, message: (body && (body.message || body.hint)) || `PostgREST error ${resp.status}` };
      }
      return { success: true, data: Array.isArray(body) ? body[0] : body };
    }
  };
}

export { callService as _callServiceForTests };
