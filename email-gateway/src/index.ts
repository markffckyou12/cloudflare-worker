// =========================================================================
// INBOUND EMAIL GATEWAY (Cloudflare Email Worker - TypeScript Edition)
// =========================================================================
// FIXED (2026-07-27): this was calling database-service with
// action:'recordLeadFromEmail', which database-service's router never
// implemented (only 'writeLead' exists) -- and even that would have failed,
// since it sends {source, refNo, fromSender, subject, receivedAt}, none of
// which match writeLead's required {name, email}. On top of that, the
// refRegex gate never matched a real Linktree "New form answer" email at
// all -- there's no "Ref" field in that format -- so _handleLeadEmail was
// returning at `if (!refMatch) return` before the broken fetch() call was
// even reached. Confirmed against a real sample email (6 real submissions,
// all matching the Email/Name/Phone number/Message label format below, none
// containing anything matching a "Ref" pattern).
//
// Fix: parse the actual labeled fields Linktree sends, and call
// legal-ops-orchestrator's action-dispatch endpoint (not database-service
// directly) with a real 'writeLead' action -- matching the field names
// database-service's _api_handleWriteLead already expects, since
// legal-ops-orchestrator's new writeLead handler writes to the same
// response_leads shape.
// =========================================================================

import PostalMime from 'postal-mime';

export interface Env {
  FORWARD_TO_EMAIL: string;
  INTERNAL_SERVICE_TOKEN: string;
  // RENAMED from DATABASE_SERVICE_URL: this now points at
  // legal-ops-orchestrator's Worker URL, not database-service's Apps Script
  // /exec URL -- update the deployed secret/var accordingly.
  ORCHESTRATOR_URL: string;
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
}

interface LeadSource {
  name: string;
  matchesSender: (fromAddress: string) => boolean;
  matchesSubject: (subject: string) => boolean;
  actions: string[];
  forwardToInbox: boolean;
}

interface MatchedRoute {
  type: string;
  source: LeadSource | null;
  actions: string[];
  forwardToInbox: boolean;
}

const LEAD_SOURCES: LeadSource[] = [
  {
    name: 'linktree',
    matchesSender: (fromAddress: string) => fromAddress.includes('subscribers.linktr.ee'),
    matchesSubject: (subject: string) => /new form answer/i.test(subject),
    actions: ['database'],
    forwardToInbox: true
  }
];

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    let email;
    try {
      email = await PostalMime.parse(message.raw);
    } catch (err) {
      console.error('Failed to parse inbound email:', err);
      await message.forward(env.FORWARD_TO_EMAIL);
      return;
    }

    const route = _matchRoute(message, email);

    ctx.waitUntil(_runRouteActions(route, message, email, env));

    if (route.forwardToInbox) {
      await message.forward(env.FORWARD_TO_EMAIL);
    }
  }
};

function _matchRoute(message: ForwardableEmailMessage, email: any): MatchedRoute {
  const fromAddress = (message.from || '').toLowerCase();
  const subject = email.subject || '';

  const source = LEAD_SOURCES.find(s => s.matchesSender(fromAddress) && s.matchesSubject(subject));
  if (source) {
    return {
      type: `lead:${source.name}`,
      source,
      actions: source.actions,
      forwardToInbox: source.forwardToInbox
    };
  }

  return { type: 'unmatched', source: null, actions: [], forwardToInbox: true };
}

async function _runRouteActions(
  route: MatchedRoute,
  message: ForwardableEmailMessage,
  email: any,
  env: Env
): Promise<void> {
  for (const action of route.actions) {
    try {
      if (action === 'database') await _handleLeadEmail(route, message, email, env);
      if (action === 'slack') await _notifySlack(route, message, email, env);
      if (action === 'discord') await _notifyDiscord(route, message, env);
    } catch (err) {
      console.error(`Route action "${action}" failed for ${route.type}:`, err);
    }
  }
}

/**
 * Parses Linktree's "New form answer" body format:
 *   Email\n<value>\n\nName\n<value>\n\nPhone number\n<value>\n\nMessage\n<value>
 * Verified against 6 real sample submissions from the actual inbound email
 * (all matched correctly, including a name/message as short as "Hi"/"Test").
 */
function _parseLinktreeFields(bodyText: string): { email: string | null; name: string | null; phone: string | null; message: string | null } {
  const get = (label: string): string | null => {
    const re = new RegExp(`${label}\\s*\\n+([^\\n]+)`, 'i');
    const m = bodyText.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    email: get('Email'),
    name: get('Name'),
    phone: get('Phone number'),
    message: get('Message'),
  };
}

async function _handleLeadEmail(
  route: MatchedRoute,
  message: ForwardableEmailMessage,
  email: any,
  env: Env
): Promise<void> {
  if (!route.source) return;

  const bodyText: string = email.text || email.html || '';
  const fields = _parseLinktreeFields(bodyText);

  // Mirrors legal-ops-orchestrator's writeLead handler's own requirement
  // (name + email required) -- check here too so a malformed/unexpected
  // Linktree template change fails loudly in logs rather than silently
  // sending a request that'll just get rejected downstream anyway.
  if (!fields.name || !fields.email) {
    console.warn(`${route.source.name} lead email matched but could not parse name/email from body. Parsed:`, fields);
    return;
  }

  const resp = await fetch(env.ORCHESTRATOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'writeLead',
      authToken: env.INTERNAL_SERVICE_TOKEN,
      name: fields.name,
      email: fields.email,
      phone: fields.phone || '',
      notes: fields.message || '',
      deliveryMethod: `Linktree (${route.source.name})`,
      // email.messageId is this email's Message-ID header (via PostalMime) --
      // used the same way Gmail's message ID was: as an idempotency key so a
      // re-delivered/duplicate inbound email doesn't create a second lead.
      gmailMessageId: email.messageId || ''
    })
  });

  if (!resp.ok) {
    console.error(`legal-ops-orchestrator returned HTTP ${resp.status} for lead ${fields.email} (source: ${route.source.name})`);
    return;
  }

  const result = await resp.json().catch(() => null) as { success?: boolean } | null;
  if (!result || !result.success) {
    console.error(`legal-ops-orchestrator rejected writeLead for ${fields.email}:`, result);
  }
}

async function _notifySlack(
  route: MatchedRoute,
  message: ForwardableEmailMessage,
  email: any,
  env: Env
): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;
  await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `📩 ${route.type}: "${email.subject}" from ${message.from}` })
  });
}

async function _notifyDiscord(
  route: MatchedRoute,
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return;
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `📩 ${route.type}: from ${message.from}` })
  });
}
