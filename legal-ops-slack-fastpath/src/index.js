// =========================================================================
// SLACK INTERACTIVITY — FULL FAST PATH (Phase 1 of MIGRATION_RUNBOOK.md)
//
// WHY THIS EXISTS: views.open (opening a modal) needs a trigger_id, which
// Slack invalidates ~3 seconds after issuing it. Apps Script Web Apps can
// have unpredictable cold-start latency BEFORE their own doPost() even
// begins executing — which can by itself exceed that 3-second budget, no
// matter how the code inside doPost() is optimized.
//
// Cloudflare Workers run on pre-warmed V8 isolates with no equivalent
// cold-start tax. As of this phase, this Worker owns the FULL Slack
// Interactivity surface: Log Comment, View Ledger, and view_submission
// (modal Submit). Nothing routes back through slack-service (Apps Script)
// in normal operation any more — see MIGRATION_RUNBOOK.md Phase 1.
//
// slack-service's own inbound.js handling for these three things still
// exists in the Apps Script project, deliberately left in place and marked
// deprecated, as a manual rollback path (point Slack's Interactivity
// Request URL back at slack-service's /exec URL). It should see ZERO live
// traffic under normal operation — see the Phase 1 testing checklist.
//
// forwardToAppsScript() below is now ONLY a catch-all for action_ids this
// Worker doesn't recognize yet (future buttons added to matter cards,
// shortcuts, etc.) and for payloads this Worker fails to parse. Nothing
// currently in production should hit it.
//
// Kept in sync with services/slack-service/views.js — if any of
// BlockKit_buildCommentLoadingModal / BlockKit_buildCommentFormModalUpdate /
// BlockKit_compileLedgerBlocks / the ledger modal builders change shape
// there, update the matching functions here to match. (Post-Phase-1, this
// Worker is the source of truth going forward — see runbook's Phase 1
// Cleanup section — but slack-service's copies stay until that cleanup
// actually happens.)
// =========================================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK');
    }

    const rawBody = await request.text();
    const contentType = request.headers.get('content-type') || '';

    let payload;
    try {
      payload = parseSlackBody(rawBody, contentType);
    } catch (err) {
      // Couldn't parse it here — forward as-is and let the existing
      // Apps Script error handling deal with it, same as it always has.
      return forwardToAppsScript(rawBody, contentType, env);
    }

    // Internal service-to-service calls (shape: { action, authToken, ... })
    // never come through Slack's Interactivity URL — this Worker only sits
    // in front of that one URL. Anything with an `action` field instead of
    // a `type` field isn't a Slack interactivity payload; pass it straight
    // through unchanged, same as any other shape this Worker doesn't own.
    if (payload.action && !payload.type) {
      return forwardToAppsScript(rawBody, contentType, env);
    }

    const teamId = (payload.team && payload.team.id) || payload.team_id;
    const teamOk = !!env.SLACK_EXPECTED_TEAM_ID && teamId === env.SLACK_EXPECTED_TEAM_ID;

    // FAST PATH: block_actions (button clicks).
    if (payload.type === 'block_actions') {
      const action = payload.actions && payload.actions[0];

      if (action && action.action_id === 'slack_action_trigger_comment_modal') {
        if (!teamOk) {
          console.log(`[Worker] Log Comment rejected: team_id mismatch (got ${teamId})`);
          return new Response('OK');
        }
        return handleLogCommentFastPath(payload, action, env, ctx);
      }

      if (action && action.action_id === 'slack_action_view_ledger') {
        if (!teamOk) {
          console.log(`[Worker] View Ledger rejected: team_id mismatch (got ${teamId})`);
          return new Response('OK');
        }
        return handleViewLedgerFastPath(payload, action, env, ctx);
      }

      // Unrecognized action_id (e.g. a future button this Worker doesn't
      // know about yet) — fall through to Apps Script rather than silently
      // dropping it.
      return forwardToAppsScript(rawBody, contentType, env);
    }

    // FAST PATH: view_submission (Submit on the comment modal). Slack's ack
    // window applies here too, separately from trigger_id. This now calls
    // orchestrator-service directly instead of forwarding to slack-service,
    // which itself used to forward again to orchestrator-service — that was
    // two Apps Script hops for one write. One Worker→orchestrator call,
    // fired via ctx.waitUntil so the ack back to Slack doesn't wait on it.
    if (payload.type === 'view_submission') {
      return handleViewSubmissionFastAck(payload, teamId, teamOk, env, ctx);
    }

    // EVERYTHING ELSE (url_verification, shortcuts, anything new): pass
    // through unchanged.
    return forwardToAppsScript(rawBody, contentType, env);
  }
};

function parseSlackBody(rawBody, contentType) {
  // Mirrors services/slack-service/inbound.js's _parseInboundPayload: real
  // Slack interactivity is application/x-www-form-urlencoded with the JSON
  // payload URL-encoded inside a single `payload` field.
  const looksFormEncoded =
    contentType.indexOf('application/x-www-form-urlencoded') !== -1 ||
    /(^|&)payload=/.test(rawBody);

  if (looksFormEncoded) {
    const match = rawBody.match(/(?:^|&)payload=([^&]*)/);
    if (match) {
      return JSON.parse(decodeURIComponent(match[1].replace(/\+/g, ' ')));
    }
  }

  return JSON.parse(rawBody);
}

// =========================================================================
// callOrchestrator — routes to legal-ops-orchestrator via a Service Binding
// (env.ORCHESTRATOR) when one is configured in wrangler.toml, since a plain
// fetch() from one Worker to another Worker's *.workers.dev subdomain is
// blocked by Cloudflare (error 1042 — loop/abuse prevention on the public
// internet path). A Service Binding routes directly between the two
// Workers on Cloudflare's internal network instead, so it never hits that
// restriction — and it's faster than a real HTTP round-trip besides.
//
// The hostname in the URL passed to a bound Fetcher is never actually used
// for routing (the binding itself determines the destination Worker) — it
// just needs to be a syntactically valid absolute URL so the target
// Worker's own `new URL(request.url)` parsing doesn't throw. Falls back to
// a plain fetch() against ORCHESTRATOR_EXEC_URL if no binding is present
// (e.g. local dev without service bindings configured, or before the
// binding is added) — see wrangler.toml.
function callOrchestrator(env, pathAndQuery, options) {
  if (env.ORCHESTRATOR) {
    return env.ORCHESTRATOR.fetch(`https://orchestrator.internal${pathAndQuery}`, options);
  }
  if (!env.ORCHESTRATOR_EXEC_URL) {
    return Promise.reject(new Error('Neither ORCHESTRATOR service binding nor ORCHESTRATOR_EXEC_URL is configured.'));
  }
  return fetch(`${env.ORCHESTRATOR_EXEC_URL}${pathAndQuery}`, options);
}

function slackApiCall(env, method, body) {
  return fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify(body)
  }).then((r) => r.json());
}

function postEphemeral(env, channelId, userId, text) {
  if (!channelId || !userId) {
    console.log(`[Worker] postEphemeral skipped: missing channelId/userId for text: ${text}`);
    return Promise.resolve();
  }
  return slackApiCall(env, 'chat.postEphemeral', { channel: channelId, user: userId, text });
}

// =========================================================================
// LOG COMMENT (unchanged from before this phase — already Worker-owned)
// =========================================================================

function buildCommentLoadingModal(triggerId, refNo, channelId, messageTs) {
  // Kept in sync with BlockKit_buildCommentLoadingModal in
  // services/slack-service/views.js — same shape, same callback_id.
  return {
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'slack_modal_callback_submit_comment',
      private_metadata: `${refNo}|${channelId}|${messageTs}`,
      title: { type: 'plain_text', text: 'Add Comment' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `_Loading tasks for ${refNo}\u2026_` } }
      ]
    }
  };
}

function buildCommentFormModalUpdate(viewId, refNo, channelId, messageTs, tasks) {
  // Kept in sync with BlockKit_buildCommentFormModalUpdate in
  // services/slack-service/views.js — same shape, same callback_id, same
  // "omit the dropdown entirely if there are zero tasks" rule (Slack
  // rejects a static_select with an empty options array).
  const taskOptions = (tasks || []).slice(0, 100).map((t) => ({
    text: { type: 'plain_text', text: `${t.isCompleted ? '✅' : '⬜'} ${t.title}`.slice(0, 75) },
    value: t.globalTaskId
  }));

  const blocks = [];
  if (taskOptions.length > 0) {
    blocks.push({
      type: 'input',
      block_id: 'task_block',
      optional: true,
      label: { type: 'plain_text', text: 'Task (leave blank to comment on the whole matter)' },
      element: {
        type: 'static_select',
        action_id: 'task_select',
        placeholder: { type: 'plain_text', text: 'General comment (whole matter)' },
        options: taskOptions
      }
    });
  }
  blocks.push({
    type: 'input',
    block_id: 'comment_block',
    label: { type: 'plain_text', text: `Comment for ${refNo}` },
    element: { type: 'plain_text_input', action_id: 'comment_text', multiline: true }
  });

  return {
    view_id: viewId,
    view: {
      type: 'modal',
      callback_id: 'slack_modal_callback_submit_comment',
      private_metadata: `${refNo}|${channelId}|${messageTs}`,
      title: { type: 'plain_text', text: 'Add Comment' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: blocks
    }
  };
}

async function handleLogCommentFastPath(payload, action, env, ctx) {
  const refNo = action.value;
  const channelId = payload.channel ? payload.channel.id : '';
  const messageTs = payload.message ? payload.message.ts : '';

  // Only this call is trigger_id-sensitive — it must happen synchronously,
  // in-request, before responding to Slack.
  const loadingPayload = buildCommentLoadingModal(payload.trigger_id, refNo, channelId, messageTs);
  const result = await slackApiCall(env, 'views.open', loadingPayload);

  if (!result.ok) {
    console.log(`[Worker] views.open (comment) failed for ${refNo}: ${result.error}`);
    if (payload.channel && payload.user) {
      const isTimingRace = result.error === 'invalid_trigger_id' || result.error === 'expired_trigger_id';
      const text = isTimingRace
        ? '⚠️ That took a moment too long to open — please click "Log Comment" again.'
        : `⚠️ Couldn't open the comment box: \`${result.error}\`. This is a Slack app config issue (e.g. a missing scope or a stale Interactivity URL), not a database problem.`;
      ctx.waitUntil(postEphemeral(env, payload.channel.id, payload.user.id, text));
    }
    return new Response('OK');
  }

  // views.open succeeded — the trigger_id is spent and Slack's ack for THIS
  // request is satisfied by the response below. Fetching the task list and
  // filling in the real form via views.update has no trigger_id deadline,
  // so it runs in the background instead of blocking this response.
  const viewId = result.view && result.view.id;
  ctx.waitUntil(fillInCommentForm(env, viewId, refNo, channelId, messageTs, payload));

  return new Response('OK');
}

async function fillInCommentForm(env, viewId, refNo, channelId, messageTs, payload) {
  // Best-effort task fetch: if this fails for any reason, the form still
  // gets filled in as a general/matter-level comment box rather than
  // leaving the user stuck on a permanent "Loading tasks…" screen.
  let tasks = [];
  if (!env.ORCHESTRATOR && !env.ORCHESTRATOR_EXEC_URL) {
    console.log('[Worker] Neither ORCHESTRATOR service binding nor ORCHESTRATOR_EXEC_URL configured — opening comment form without a task list.');
  } else {
    try {
      const resp = await callOrchestrator(env, `?action=getMatterTasks&refNo=${encodeURIComponent(refNo)}`);
      const parsed = await resp.json();
      if (parsed.success) {
        tasks = parsed.data || [];
      } else {
        console.log(`[Worker] getMatterTasks failed for ${refNo}: ${parsed.message || JSON.stringify(parsed)}`);
      }
    } catch (err) {
      console.log(`[Worker] getMatterTasks threw for ${refNo}: ${err}`);
    }
  }

  const formPayload = buildCommentFormModalUpdate(viewId, refNo, channelId, messageTs, tasks);

  try {
    const updateResult = await slackApiCall(env, 'views.update', formPayload);
    if (!updateResult.ok) {
      console.log(`[Worker] views.update (comment) failed for ${refNo}: ${updateResult.error}`);
      if (payload.channel && payload.user) {
        const text = `⚠️ The comment box opened but couldn't be filled in: \`${updateResult.error || 'unknown error'}\`. Please close it and try again.`;
        await postEphemeral(env, payload.channel.id, payload.user.id, text);
      }
    }
  } catch (err) {
    console.log(`[Worker] views.update (comment) threw for ${refNo}: ${err}`);
    if (payload.channel && payload.user) {
      try {
        await postEphemeral(env, payload.channel.id, payload.user.id, `⚠️ The comment box opened but couldn't be filled in (a network error occurred). Please close it and try again.`);
      } catch (innerErr) {
        console.log(`[Worker] even the ephemeral error notice failed for ${refNo}: ${innerErr}`);
      }
    }
  }
}

// =========================================================================
// VIEW LEDGER (new in this phase — ported from slack-service/inbound.js's
// `slack_action_view_ledger` branch + views.js's BlockKit_compileLedgerBlocks
// and friends). Follows the same loading→fetch→update pattern as Log
// Comment above, rather than slack-service's response_url-fallback hybrid —
// that fallback existed specifically to work around Apps Script cold-start
// eating the trigger_id budget, which doesn't apply to this Worker.
// =========================================================================

function _ledgerModalView(refNo, blocks) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: `Ledger: ${refNo}`.slice(0, 24) }, // Slack caps view titles at 24 chars
    close: { type: 'plain_text', text: 'Close' },
    blocks: blocks
  };
}

function buildLedgerLoadingModal(triggerId, refNo) {
  return {
    trigger_id: triggerId,
    view: _ledgerModalView(refNo, [{ type: 'section', text: { type: 'mrkdwn', text: '_Loading comments\u2026_' } }])
  };
}

function buildLedgerModalUpdate(viewId, refNo, ledgerBlocks) {
  return {
    view_id: viewId,
    view: _ledgerModalView(refNo, ledgerBlocks)
  };
}

// Slack's real section text.text cap is 3000 chars; leave headroom.
const MAX_SECTION_TEXT_LEN = 2900;
// Modals allow up to 100 blocks; keep well under that.
const MAX_LEDGER_BLOCKS = 45;

function _formatLedgerTimestamp(isoTimestamp) {
  if (!isoTimestamp) return '';
  const unixSeconds = Math.floor(new Date(isoTimestamp).getTime() / 1000);
  if (Number.isNaN(unixSeconds)) return '';
  return ` <!date^${unixSeconds}^{date_short_pretty} {time}|${isoTimestamp}>`;
}

function _ledgerCommentLine(c) {
  return `> *${c.author}:* ${c.text}${_formatLedgerTimestamp(c.timestamp)}`;
}

function _ledgerCommentSectionBlocks(comments, emptyText) {
  if (comments.length === 0) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: emptyText } }];
  }

  const blocks = [];
  let chunk = [];
  let chunkLen = 0;
  comments.forEach((c) => {
    const line = _ledgerCommentLine(c);
    if (chunk.length > 0 && chunkLen + line.length + 1 > MAX_SECTION_TEXT_LEN) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk.join('\n') } });
      chunk = [];
      chunkLen = 0;
    }
    chunk.push(line);
    chunkLen += line.length + 1;
  });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk.join('\n') } });
  return blocks;
}

function _ledgerHeaderBlock(text) {
  return { type: 'header', text: { type: 'plain_text', text: text.slice(0, 150) } };
}

/**
 * Ported verbatim (pure JS, no Apps Script globals) from
 * services/slack-service/views.js's BlockKit_compileLedgerBlocks. Groups
 * comments into 📌 General / per-task (TaskSequence order, only groups with
 * ≥1 comment) / ⚠️ orphaned (task since deleted).
 */
function compileLedgerBlocks(refNo, rawCommentsArray) {
  if (!rawCommentsArray || rawCommentsArray.length === 0) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: `_No comments logged yet for ${refNo}._` } }];
  }

  const general = [];
  const byTask = {}; // globalTaskId -> { title, sequence, comments: [] }
  const orphaned = [];

  rawCommentsArray.forEach((c) => {
    if (!c.globalTaskId) {
      general.push(c);
    } else if (!c.taskTitle) {
      orphaned.push(c);
    } else {
      if (!byTask[c.globalTaskId]) {
        byTask[c.globalTaskId] = { title: c.taskTitle, sequence: c.taskSequence || 0, comments: [] };
      }
      byTask[c.globalTaskId].comments.push(c);
    }
  });

  const blocks = [_ledgerHeaderBlock(`📌 General (${general.length})`)];
  blocks.push(..._ledgerCommentSectionBlocks(general, '_No general comments._'));

  Object.values(byTask)
    .sort((a, b) => a.sequence - b.sequence)
    .forEach((group) => {
      blocks.push({ type: 'divider' });
      blocks.push(_ledgerHeaderBlock(`${group.title} (${group.comments.length})`));
      blocks.push(..._ledgerCommentSectionBlocks(group.comments, '_None._'));
    });

  if (orphaned.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push(_ledgerHeaderBlock(`⚠️ Task deleted (${orphaned.length})`));
    blocks.push(..._ledgerCommentSectionBlocks(orphaned, '_None._'));
  }

  if (blocks.length > MAX_LEDGER_BLOCKS) {
    const kept = blocks.slice(0, MAX_LEDGER_BLOCKS);
    kept.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Truncated — ${blocks.length - MAX_LEDGER_BLOCKS} more block(s) not shown. Use the sheet directly for the full history._` }]
    });
    return kept;
  }

  return blocks;
}

async function handleViewLedgerFastPath(payload, action, env, ctx) {
  const refNo = action.value;

  // Same trigger_id-sensitive, synchronous, in-request call as Log Comment.
  const loadingPayload = buildLedgerLoadingModal(payload.trigger_id, refNo);
  const result = await slackApiCall(env, 'views.open', loadingPayload);

  if (!result.ok) {
    console.log(`[Worker] views.open (ledger) failed for ${refNo}: ${result.error}`);
    if (payload.channel && payload.user) {
      const isTimingRace = result.error === 'invalid_trigger_id' || result.error === 'expired_trigger_id';
      const text = isTimingRace
        ? '⚠️ That took a moment too long to open — please click "View Ledger" again.'
        : `⚠️ Couldn't open the ledger: \`${result.error}\`. This is a Slack app config issue (e.g. a missing scope or a stale Interactivity URL), not a database problem.`;
      ctx.waitUntil(postEphemeral(env, payload.channel.id, payload.user.id, text));
    }
    return new Response('OK');
  }

  const viewId = result.view && result.view.id;
  ctx.waitUntil(fillInLedgerForm(env, viewId, refNo, payload));

  return new Response('OK');
}

async function fillInLedgerForm(env, viewId, refNo, payload) {
  if (!env.ORCHESTRATOR && !env.ORCHESTRATOR_EXEC_URL) {
    console.log(`[Worker] Neither ORCHESTRATOR service binding nor ORCHESTRATOR_EXEC_URL configured — cannot load ledger for ${refNo}.`);
    await updateLedgerWithError(env, viewId, refNo, payload, 'Orchestrator is not configured on the Worker.');
    return;
  }

  let parsed;
  try {
    const resp = await callOrchestrator(env, `?action=getLedgerData&refNo=${encodeURIComponent(refNo)}`);
    parsed = await resp.json();
  } catch (err) {
    console.log(`[Worker] getLedgerData threw for ${refNo}: ${err}`);
    await updateLedgerWithError(env, viewId, refNo, payload, 'a network error occurred while loading the ledger.');
    return;
  }

  if (!parsed.success) {
    console.log(`[Worker] getLedgerData failed for ${refNo}: ${parsed.message || JSON.stringify(parsed)}`);
    await updateLedgerWithError(env, viewId, refNo, payload, parsed.message || 'unknown error');
    return;
  }

  const ledgerBlocks = compileLedgerBlocks(refNo, parsed.data || []);
  const updatePayload = buildLedgerModalUpdate(viewId, refNo, ledgerBlocks);

  try {
    const updateResult = await slackApiCall(env, 'views.update', updatePayload);
    if (!updateResult.ok) {
      console.log(`[Worker] views.update (ledger) failed for ${refNo}: ${updateResult.error}`);
      if (payload.channel && payload.user) {
        await postEphemeral(env, payload.channel.id, payload.user.id, `⚠️ The ledger opened but couldn't be filled in: \`${updateResult.error || 'unknown error'}\`. Please close it and try again.`);
      }
    }
  } catch (err) {
    console.log(`[Worker] views.update (ledger) threw for ${refNo}: ${err}`);
    if (payload.channel && payload.user) {
      try {
        await postEphemeral(env, payload.channel.id, payload.user.id, `⚠️ The ledger opened but couldn't be filled in (a network error occurred). Please close it and try again.`);
      } catch (innerErr) {
        console.log(`[Worker] even the ephemeral error notice failed for ${refNo}: ${innerErr}`);
      }
    }
  }
}

async function updateLedgerWithError(env, viewId, refNo, payload, message) {
  const errorBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ Couldn't load the ledger: \`${message}\`.` } }];
  try {
    await slackApiCall(env, 'views.update', buildLedgerModalUpdate(viewId, refNo, errorBlocks));
  } catch (err) {
    console.log(`[Worker] failed to write ledger error state into the modal for ${refNo}: ${err}`);
    if (payload.channel && payload.user) {
      await postEphemeral(env, payload.channel.id, payload.user.id, `⚠️ Couldn't load the ledger: \`${message}\`.`);
    }
  }
}

// =========================================================================
// VIEW_SUBMISSION (Submit on the comment modal) — now calls
// orchestrator-service DIRECTLY instead of forwarding to slack-service
// (which used to forward again to orchestrator-service — two Apps Script
// hops for one write). Ack 'clear' immediately; the actual write happens
// in the background via ctx.waitUntil.
//
// NOTE ON PAYLOAD SHAPE: this sends the exact same body shape
// slack-service's _handleViewSubmission already sends to orchestrator-
// service today — { action: 'handleSubmission', authToken, payload: rawData }
// — just from the Worker instead of from Apps Script. private_metadata is
// still parsed here (refNo/channelId/messageTs), but only so the Worker
// itself can post an ephemeral failure notice — the exact job
// slack-service's own _postEphemeralError used to do, which the Worker
// must now take over since slack-service no longer sees this traffic.
// If orchestrator-service's handleSubmission action expects a different
// shape than "the raw rawData under `payload`", update the fetch body
// below accordingly — that action's own source wasn't available at the
// time this Worker code was written, so this preserves the known-working
// contract rather than guessing at a new one.
// =========================================================================

async function handleViewSubmissionFastAck(payload, teamId, teamOk, env, ctx) {
  if (teamOk) {
    ctx.waitUntil(forwardSubmissionToOrchestrator(payload, env));
  } else {
    console.log(`[Worker] view_submission rejected: team_id mismatch (got ${teamId})`);
  }

  return new Response(JSON.stringify({ response_action: 'clear' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function forwardSubmissionToOrchestrator(payload, env) {
  // private_metadata is `refNo|channelId|messageTs` (see
  // buildCommentLoadingModal above) — channelId is where to post the
  // ephemeral failure notice, since view_submission has no `channel` field
  // the way block_actions does.
  const metadataParts = String((payload.view && payload.view.private_metadata) || '').split('|');
  const originChannelId = metadataParts[1] || null;
  const submitterUserId = payload.user ? payload.user.id : null;

  if (!env.ORCHESTRATOR && !env.ORCHESTRATOR_EXEC_URL) {
    console.log('[Worker] Neither ORCHESTRATOR service binding nor ORCHESTRATOR_EXEC_URL configured — comment was never sent anywhere.');
    await postEphemeral(env, originChannelId, submitterUserId, '⚠️ Your comment was NOT saved — the Orchestrator is not configured on the Worker.');
    return;
  }

  if (!env.INTERNAL_SERVICE_TOKEN) {
    console.log('[Worker] INTERNAL_SERVICE_TOKEN not configured — cannot authenticate to orchestrator-service.');
    await postEphemeral(env, originChannelId, submitterUserId, '⚠️ Your comment was NOT saved — the Worker is missing its INTERNAL_SERVICE_TOKEN secret.');
    return;
  }

  try {
    const resp = await callOrchestrator(env, '', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'handleSubmission',
        authToken: env.INTERNAL_SERVICE_TOKEN,
        payload: payload
      })
    });
    const parsed = await resp.json();
    if (!parsed.success) {
      console.log(`[Worker] orchestrator reported failure for comment submission: ${parsed.message || JSON.stringify(parsed)}`);
      await postEphemeral(env, originChannelId, submitterUserId, `⚠️ Your comment was NOT saved: \`${parsed.message || 'unknown error'}\`. Please try again or check with your admin.`);
    } else {
      console.log('[Worker] comment logged successfully via orchestrator-service.');
    }
  } catch (err) {
    console.log(`[Worker] call to orchestrator-service threw for comment submission: ${err}`);
    await postEphemeral(env, originChannelId, submitterUserId, `⚠️ Your comment was NOT saved — the request to the Orchestrator failed: \`${err}\`.`);
  }
}

// =========================================================================
// CATCH-ALL — only for payloads/action_ids this Worker doesn't own.
// =========================================================================

async function forwardToAppsScript(rawBody, contentType, env) {
  const resp = await fetch(env.APPS_SCRIPT_EXEC_URL, {
    method: 'POST',
    headers: { 'Content-Type': contentType || 'application/x-www-form-urlencoded' },
    body: rawBody
  });
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { 'Content-Type': resp.headers.get('content-type') || 'application/json' }
  });
}
