// Jest-native tests for legal-ops-orchestrator (Phase 2).
// Run: npm test  (or: node --experimental-vm-modules node_modules/.bin/jest)
//
// No network access, no Miniflare dependency — mocks global fetch and
// exercises the routing/handlers directly.

import { jest } from '@jest/globals';
import { webcrypto } from 'node:crypto';
import { SignJWT } from 'jose';
import worker from '../src/index.js';

// jose (used below to sign test JWTs, and by src/clients.js's
// verifyStaffJwt at runtime) needs the Web Crypto API. The real
// Cloudflare Workers runtime this code actually runs in has `crypto` as
// a standard global -- Node's Jest environment doesn't, by default. This
// is a test-environment-only polyfill, not a production concern.
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const ENV = {
  DATABASE_SERVICE_EXEC_URL: 'https://script.google.com/macros/s/db-service/exec',
  SLACK_SERVICE_EXEC_URL: 'https://script.google.com/macros/s/slack-service/exec',
  INTERNAL_SERVICE_TOKEN: 'test-token-123',
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_JWT_SECRET: 'test-jwt-secret-at-least-32-bytes-long!!',
  SLACK_BOT_TOKEN: 'xoxb-test-bot-token'
};

async function makeStaffToken(authUserId) {
  const secret = new TextEncoder().encode(ENV.SUPABASE_JWT_SECRET);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(authUserId)
    .setExpirationTime('1h')
    .sign(secret);
}

// Responder can return either a plain object/array (old Apps-Script-style
// tests -- treated as the JSON body, ok:true/status:200 implied) or an
// explicit { __ok, __status, __body } for Supabase-style tests that need
// pgFetch's resp.ok check to see something other than success.
function mockFetch(responder) {
  const calls = [];
  global.fetch = jest.fn(async (url, options) => {
    calls.push({ url, options });
    const result = responder(url, options);
    const ok = result && result.__ok !== undefined ? result.__ok : true;
    const status = result && result.__status !== undefined ? result.__status : 200;
    const body = result && result.__body !== undefined ? result.__body : result;
    return { ok, status, json: async () => body };
  });
  return calls;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET routes', () => {
  test('getLedgerData proxies to database-service unauthenticated', async () => {
    const calls = mockFetch((url) => {
      expect(url).toMatch(/action=getLedgerData/);
      expect(url).toMatch(/refNo=TP%2F001/);
      return { success: true, data: { comments: [] } };
    });

    const req = new Request('https://worker.example/?action=getLedgerData&refNo=TP/001', { method: 'GET' });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.method).toBe('GET');
  });

  test('getMatterTasks missing refNo returns an error without calling out', async () => {
    const calls = mockFetch(() => { throw new Error('should not be called'); });

    const req = new Request('https://worker.example/?action=getMatterTasks', { method: 'GET' });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.message).toMatch(/Missing required parameter: refNo/);
    expect(calls).toHaveLength(0);
  });

  test('unknown action returns an error', async () => {
    mockFetch(() => ({}));
    const req = new Request('https://worker.example/?action=doSomethingElse', { method: 'GET' });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.message).toMatch(/Unknown or missing GET action/);
  });
});

describe('POST auth gating', () => {
  test('missing authToken is rejected before any network call', async () => {
    const calls = mockFetch(() => { throw new Error('should not be called'); });

    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({ action: 'refreshMatterCard', refNo: 'TP/001' })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.message).toMatch(/Unauthorized/);
    expect(calls).toHaveLength(0);
  });

  test('wrong authToken is rejected (constant-time compare, not just truthy)', async () => {
    mockFetch(() => { throw new Error('should not be called'); });
    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({ action: 'refreshMatterCard', authToken: 'wrong-token', refNo: 'TP/001' })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/Unauthorized/);
  });
});

describe('refreshMatterCard', () => {
  test('valid call forwards all fields to slack-service', async () => {
    const calls = mockFetch((url, options) => {
      const parsed = JSON.parse(options.body);
      expect(parsed.action).toBe('updateMatterCard');
      expect(parsed.channelId).toBe('C123');
      expect(parsed.messageTs).toBe('1234.5678');
      expect(parsed.refNo).toBe('TP/001');
      expect(parsed.progressPercent).toBe(77);
      return { success: true, message: 'ok' };
    });

    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({
        action: 'refreshMatterCard',
        authToken: ENV.INTERNAL_SERVICE_TOKEN,
        refNo: 'TP/001',
        channelId: 'C123',
        messageTs: '1234.5678',
        clientName: 'Test Client',
        matterType: 'Test Type',
        progressPercent: 77,
        officersStackedString: '_unassigned_',
        statusEnum: 'Active'
      })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('missing required field short-circuits before calling out', async () => {
    const calls = mockFetch(() => { throw new Error('should not be called'); });
    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({ action: 'refreshMatterCard', authToken: ENV.INTERNAL_SERVICE_TOKEN, refNo: 'TP/001' })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/Missing required fields/);
    expect(calls).toHaveLength(0);
  });
});

describe('provisionSlackWorkflow', () => {
  // Phase 10 rewrite: this used to go through the legacy Sheets-backed
  // database-service (getMatterContext/updateSlackLinks), which had no
  // knowledge of matters created after the Supabase migration and would
  // fail for all of them. It's Supabase-native now -- these tests mock
  // Supabase's REST endpoints instead of the old Apps Script actions.
  test('full happy path: resolve ref_no -> matter+officers from Supabase -> createChannel -> write back -> updateMatterCard', async () => {
    const seen = [];
    mockFetch((url, options) => {
      const u = String(url);
      if (u.includes('/rest/v1/matters?ref_no=eq.')) {
        seen.push('getMatterIdByRefNo');
        return { __body: [{ id: 42 }] };
      }
      if (u.includes('/rest/v1/matters?id=eq.42&select=ref_no')) {
        seen.push('getMatterForSlackProvisioning');
        return { __body: [{ ref_no: 'TP/001', client_name: 'Acme Corp', progress_pct: 10, status: 'Active', project_types: { name: 'Litigation' } }] };
      }
      if (u.includes('/rest/v1/matter_officers?matter_id=eq.42')) {
        seen.push('getMatterOfficersForSlack');
        return { __body: [{ staff: { name: 'Jane', initial: 'JD', slack_member_id: 'U111' } }] };
      }
      if (u.includes('/rest/v1/matters?id=eq.42') && options?.method === 'PATCH') {
        const parsed = JSON.parse(options.body);
        expect(parsed.slack_channel_id).toBe('C999');
        seen.push('updateMatter');
        return { __body: [{ id: 42, ...parsed }] };
      }
      const parsed = options?.body ? JSON.parse(options.body) : null;
      const action = parsed?.action;
      if (action === 'createChannel') {
        expect(parsed.refNo).toBe('TP/001'); // true clean refNo, not compound channelName
        seen.push('createChannel');
        return { success: true, channelId: 'C999', messageTs: '111.222' };
      }
      if (action === 'updateMatterCard') {
        expect(parsed.statusEnum).toBe('Active');
        seen.push('updateMatterCard');
        return { success: true };
      }
      throw new Error(`unexpected call: ${u} / ${action}`);
    });

    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({ action: 'provisionSlackWorkflow', authToken: ENV.INTERNAL_SERVICE_TOKEN, refNo: 'TP/001' })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.channelId).toBe('C999');
    expect(seen).toEqual(['getMatterIdByRefNo', 'getMatterForSlackProvisioning', 'getMatterOfficersForSlack', 'createChannel', 'updateMatter', 'updateMatterCard']);
  });

  test('skips updateMatterCard polish step if createChannel returned no messageTs', async () => {
    const seen = [];
    mockFetch((url, options) => {
      const u = String(url);
      if (u.includes('/rest/v1/matters?ref_no=eq.')) return { __body: [{ id: 42 }] };
      if (u.includes('/rest/v1/matters?id=eq.42&select=ref_no')) {
        return { __body: [{ ref_no: 'TP/001', client_name: 'Acme', progress_pct: 0, status: 'Draft', project_types: { name: 'Subsale' } }] };
      }
      if (u.includes('/rest/v1/matter_officers?matter_id=eq.42')) return { __body: [] };
      if (u.includes('/rest/v1/matters?id=eq.42') && options?.method === 'PATCH') return { __body: [{ id: 42 }] };
      const parsed = options?.body ? JSON.parse(options.body) : null;
      const action = parsed?.action;
      if (action === 'createChannel') { seen.push('createChannel'); return { success: true, channelId: 'C999', messageTs: null }; }
      if (action === 'updateMatterCard') { seen.push('updateMatterCard'); return { success: true }; }
      return { success: true };
    });

    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({ action: 'provisionSlackWorkflow', authToken: ENV.INTERNAL_SERVICE_TOKEN, refNo: 'TP/001' })
    });
    const res = await worker.fetch(req, ENV, {});
    await res.json();

    expect(seen).toEqual(['createChannel']); // no messageTs -> updateMatterCard never called
  });

  test('unknown refNo returns a clear error without calling Slack at all', async () => {
    const seen = [];
    mockFetch((url, options) => {
      const u = String(url);
      if (u.includes('/rest/v1/matters?ref_no=eq.')) return { __body: [] }; // no matching matter
      const parsed = options?.body ? JSON.parse(options.body) : null;
      if (parsed?.action) seen.push(parsed.action);
      return { success: true };
    });

    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({ action: 'provisionSlackWorkflow', authToken: ENV.INTERNAL_SERVICE_TOKEN, refNo: 'TP/does-not-exist' })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.message).toMatch(/no matter found/i);
    expect(seen).toEqual([]); // never even tried Slack
  });
});

describe('handleSubmission', () => {
  test('writes comment with globalTaskId when task_select present', async () => {
    const calls = mockFetch((url, options) => {
      const parsed = JSON.parse(options.body);
      expect(parsed.action).toBe('writeComment');
      expect(parsed.refNo).toBe('TP/001');
      expect(parsed.globalTaskId).toBe('TASK-42');
      expect(parsed.author).toBe('jdoe');
      return { success: true, message: 'written' };
    });

    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({
        action: 'handleSubmission',
        authToken: ENV.INTERNAL_SERVICE_TOKEN,
        payload: {
          user: { username: 'jdoe', id: 'U1' },
          view: {
            private_metadata: 'TP/001|C123|111.222',
            state: {
              values: {
                comment_block: { comment_text: { value: 'hello world' } },
                task_block: { task_select: { selected_option: { value: 'TASK-42' } } }
              }
            }
          }
        }
      })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('general comment (no task_block) falls through to empty globalTaskId, not an error', async () => {
    mockFetch((url, options) => {
      const parsed = JSON.parse(options.body);
      expect(parsed.globalTaskId).toBe('');
      return { success: true, message: 'written' };
    });

    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({
        action: 'handleSubmission',
        authToken: ENV.INTERNAL_SERVICE_TOKEN,
        payload: {
          user: { id: 'U1' },
          view: {
            private_metadata: 'TP/001',
            state: { values: { comment_block: { comment_text: { value: 'hi' } } } }
          }
        }
      })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('empty comment text is rejected without calling out', async () => {
    const calls = mockFetch(() => { throw new Error('should not be called'); });
    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({
        action: 'handleSubmission',
        authToken: ENV.INTERNAL_SERVICE_TOKEN,
        payload: {
          view: { private_metadata: 'TP/001', state: { values: { comment_block: { comment_text: { value: '' } } } } }
        }
      })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/empty/i);
    expect(calls).toHaveLength(0);
  });
});

describe('getPinnedMessageTs', () => {
  test('missing channelId rejected before calling out', async () => {
    const calls = mockFetch(() => { throw new Error('should not be called'); });
    const req = new Request('https://worker.example/', {
      method: 'POST',
      body: JSON.stringify({ action: 'getPinnedMessageTs', authToken: ENV.INTERNAL_SERVICE_TOKEN })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('updateMatter officer sync (direct Slack API)', () => {
  test('invites newly-added officer, removes dropped officer, ignores unchanged one', async () => {
    const seen = [];
    const token = await makeStaffToken('auth-user-1');

    mockFetch((url, options) => {
      const u = String(url);
      const method = options?.method;

      // Auth: resolve the signed-in staff member.
      if (u.includes('/rest/v1/staff?auth_user_id=eq.')) {
        return { __body: [{ id: 1, name: 'Admin', initial: 'ADMIN', is_active: true }] };
      }
      // BEFORE state: officers currently on the matter (staff A + staff B, both Slack-linked).
      if (u.includes('/rest/v1/matter_officers?matter_id=eq.99')) {
        seen.push('getMatterOfficersForSlack');
        return { __body: [{ staff: { name: 'A', initial: 'A', slack_member_id: 'U_A' } }, { staff: { name: 'B', initial: 'B', slack_member_id: 'U_B' } }] };
      }
      // setMatterOfficers: clear then re-insert.
      if (u.includes('/rest/v1/matter_officers?matter_id=eq.99') === false && u.includes('/rest/v1/matter_officers') && method === 'DELETE') {
        seen.push('clearOfficers');
        return { __body: null };
      }
      if (u.includes('/rest/v1/matter_officers') && method === 'POST') {
        seen.push('insertOfficers');
        return { __body: null };
      }
      // AFTER state resolution: new officer id list -> Slack ids (staff B stays, staff C is new).
      if (u.includes('/rest/v1/staff?id=in.')) {
        seen.push('getStaffSlackMemberIds');
        return { __body: [{ id: 2, slack_member_id: 'U_B' }, { id: 3, slack_member_id: 'U_C' }] };
      }
      // Matter lookup for its slack_channel_id.
      if (u.includes('/rest/v1/matters?id=eq.99&select=ref_no')) {
        seen.push('getMatterForSlackProvisioning');
        return { __body: [{ ref_no: 'TP/001', client_name: 'Acme', progress_pct: 50, status: 'Active', slack_channel_id: 'C123', project_types: { name: 'Litigation' } }] };
      }
      // Audit log insert.
      if (u.includes('/rest/v1/audit_log')) return { __body: null };

      // Direct Slack API calls.
      if (u === 'https://slack.com/api/conversations.invite') {
        const body = JSON.parse(options.body);
        expect(body.channel).toBe('C123');
        expect(body.users).toBe('U_C'); // only the newly-added one
        seen.push('slackInvite');
        return { ok: true };
      }
      if (u === 'https://slack.com/api/conversations.kick') {
        const body = JSON.parse(options.body);
        expect(body.channel).toBe('C123');
        expect(body.user).toBe('U_A'); // only the dropped one
        seen.push('slackKick');
        return { ok: true };
      }
      throw new Error(`unexpected call: ${u} ${method || ''}`);
    });

    const req = new Request('https://worker.example/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'updateMatter', matterId: 99, officerStaffIds: [2, 3] }) // drop A(1), keep B(2), add C(3)
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(seen).toContain('slackInvite');
    expect(seen).toContain('slackKick');
    // B (unchanged) never triggers either call -- only the diff does.
  });

  test('does nothing Slack-side if the matter has no channel yet', async () => {
    const seen = [];
    const token = await makeStaffToken('auth-user-1');

    mockFetch((url, options) => {
      const u = String(url);
      const method = options?.method;
      if (u.includes('/rest/v1/staff?auth_user_id=eq.')) return { __body: [{ id: 1, name: 'Admin', initial: 'ADMIN', is_active: true }] };
      if (u.includes('/rest/v1/matter_officers') && method === 'DELETE') return { __body: null };
      if (u.includes('/rest/v1/matter_officers') && method === 'POST') return { __body: null };
      if (u.includes('/rest/v1/matter_officers?matter_id=eq.')) return { __body: [] };
      if (u.includes('/rest/v1/matters?id=eq.5&select=ref_no')) {
        return { __body: [{ ref_no: 'TP/002', client_name: 'Beta', progress_pct: 0, status: 'Draft', slack_channel_id: null, project_types: { name: 'Tax' } }] };
      }
      if (u.includes('/rest/v1/audit_log')) return { __body: null };
      if (u.includes('slack.com/api/')) { seen.push('slackCall'); return { ok: true }; }
      return { __body: null };
    });

    const req = new Request('https://worker.example/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'updateMatter', matterId: 5, officerStaffIds: [2] })
    });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(seen).toEqual([]); // no channel -> never touches Slack
  });
});

describe('robustness', () => {
  test('malformed JSON body does not throw, returns a clean error envelope', async () => {
    mockFetch(() => ({}));
    const req = new Request('https://worker.example/', { method: 'POST', body: '{not json' });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  test('unsupported HTTP method returns a clean error, not a crash', async () => {
    mockFetch(() => ({}));
    const req = new Request('https://worker.example/', { method: 'DELETE' });
    const res = await worker.fetch(req, ENV, {});
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/Unsupported method/);
  });
});
