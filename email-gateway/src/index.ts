// =========================================================================
// INBOUND EMAIL GATEWAY (Cloudflare Email Worker - TypeScript Edition)
// =========================================================================
// UPDATED (2026-07-27): removed the Linktree lead-capture integration
// entirely (LEAD_SOURCES entry + its field parser). It turned out Linktree's
// notification emails were going to a plain Gmail address rather than a
// Cloudflare-Email-Routing-managed domain, so this Worker structurally could
// never receive them regardless of what the code did -- not something a
// code fix could solve. The routing/action scaffolding (_matchRoute,
// _runRouteActions, LEAD_SOURCES) is left in place, just empty, so a future
// lead source is a small addition rather than rebuilding this file.
//
// Right now this Worker just forwards every inbound email to
// FORWARD_TO_EMAIL and does nothing else.
// =========================================================================

import PostalMime from 'postal-mime';

export interface Env {
  FORWARD_TO_EMAIL: string;
  INTERNAL_SERVICE_TOKEN: string;
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

// No sources configured. Add a new entry here (and its handler in
// _runRouteActions) to wire up a future lead source.
const LEAD_SOURCES: LeadSource[] = [];

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
      if (action === 'slack') await _notifySlack(route, message, email, env);
      if (action === 'discord') await _notifyDiscord(route, message, env);
    } catch (err) {
      console.error(`Route action "${action}" failed for ${route.type}:`, err);
    }
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
