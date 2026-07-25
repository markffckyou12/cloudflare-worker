// =========================================================================
// INBOUND EMAIL GATEWAY (Cloudflare Email Worker - TypeScript Edition)
// =========================================================================

import PostalMime from 'postal-mime';

// 1. Define the type environment interface for Wrangler secrets & variables
export interface Env {
  FORWARD_TO_EMAIL: string;
  INTERNAL_SERVICE_TOKEN: string;
  DATABASE_SERVICE_URL: string;
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
}

// 2. Define internal structural interfaces for our routing architecture
interface LeadSource {
  name: string;
  matchesSender: (fromAddress: string) => boolean;
  matchesSubject: (subject: string) => boolean;
  refRegex: RegExp;
  actions: string[];
  forwardToInbox: boolean;
}

interface MatchedRoute {
  type: string;
  source: LeadSource | null;
  actions: string[];
  forwardToInbox: boolean;
}

// 3. Define the lead routing profiles
const LEAD_SOURCES: LeadSource[] = [
  {
    name: 'linktree',
    matchesSender: (fromAddress: string) => fromAddress.includes('subscribers.linktr.ee'),
    matchesSubject: (subject: string) => /new form answer/i.test(subject),
    refRegex: /Ref(?:erence)?\s*(?:No\.?|ID)?[:\s]+([A-Za-z0-9-]+)/i,
    actions: ['database'],
    forwardToInbox: true
  }
];

// 4. Main Exported Worker handlers
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

    // Side effects never block the forward pipeline
    ctx.waitUntil(_runRouteActions(route, message, email, env));

    if (route.forwardToInbox) {
      await message.forward(env.FORWARD_TO_EMAIL);
    }
  }
};

// 5. Utility Helper Routing Functions
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

async function _handleLeadEmail(
  route: MatchedRoute, 
  message: ForwardableEmailMessage, 
  email: any, 
  env: Env
): Promise<void> {
  if (!route.source) return;

  const bodyText: string = email.text || email.html || '';
  const refMatch = bodyText.match(route.source.refRegex);

  if (!refMatch) {
    console.warn(`${route.source.name} lead email matched but no reference ID found in body.`);
    return;
  }

  const resp = await fetch(env.DATABASE_SERVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'recordLeadFromEmail',
      authToken: env.INTERNAL_SERVICE_TOKEN,
      source: route.source.name,
      refNo: refMatch[1],
      fromSender: message.from,
      subject: email.subject,
      receivedAt: new Date().toISOString()
    })
  });

  if (!resp.ok) {
    console.error(`database-service returned HTTP ${resp.status} for ref ${refMatch[1]} (source: ${route.source.name})`);
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
