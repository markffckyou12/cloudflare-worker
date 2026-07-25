// =========================================================================
// SERVICE CLIENTS — ported from orchestrator-service's client.js
//
// Mechanical port per the runbook: UrlFetchApp.fetch(url, {method, payload:
// JSON.stringify(x)}) becomes fetch(url, {method, body: JSON.stringify(x),
// headers: {'Content-Type': 'application/json'}}). Simple bearer-token
// auth, not request signing, so there's no restricted-header issue (unlike
// the OCI signing work referenced in SYSTEM_HANDOFF.md) — a direct port.
//
// Function names and argument order are kept IDENTICAL to the Apps Script
// originals so api.js's call sites don't need to change semantically.
//
// GETs remain unauthenticated (matching database-service's own doGet
// convention — reads are open, writes require the internal token) — same
// as the original.
// =========================================================================

async function callService(url, method, payload) {
  const options = { method: method.toUpperCase() };
  if (method === 'post') {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(payload);
  }

  // No muteHttpExceptions equivalent needed: unlike UrlFetchApp, fetch()
  // does not throw on non-2xx responses by default — it only throws on
  // actual network failure. Callers here already treat "check
  // result.success in the parsed body" as the source of truth, which
  // fetch's behavior matches without any extra flag.
  const response = await fetch(url, options);
  return response.json();
}

// --- Database service ---

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
        // Same bug-fix preserved from the original: the true, clean
        // refNo, distinct from channelName ("refNo-clientName").
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

export { callService as _callServiceForTests };
