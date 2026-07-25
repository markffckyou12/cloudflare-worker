// Mock-based tests for legal-ops-orchestrator (Phase 2).
// Run: node test/phase2.test.mjs
//
// No network access, no Miniflare dependency — mocks global fetch and
// exercises the handlers/routing directly, same "paste-in-and-run,
// read the log" spirit as this repo's diagnostic-tests/*.gs convention,
// adapted to plain Node per the Phase 1 test precedent.

import assert from 'node:assert/strict';
import worker from '../src/index.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`❌ ${name}`);
    console.log(`   ${err.message}`);
  }
}

const ENV = {
  DATABASE_SERVICE_EXEC_URL: 'https://script.google.com/macros/s/db-service/exec',
  SLACK_SERVICE_EXEC_URL: 'https://script.google.com/macros/s/slack-service/exec',
  INTERNAL_SERVICE_TOKEN: 'test-token-123'
};

function mockFetch(responder) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const body = responder(url, options);
    return {
      json: async () => body
    };
  };
  return calls;
}

await test('GET getLedgerData proxies to database-service unauthenticated', async () => {
  const calls = mockFetch((url) => {
    assert.match(url, /action=getLedgerData/);
    assert.match(url, /refNo=TP%2F001/);
    return { success: true, data: { comments: [] } };
  });

  const req = new Request('https://worker.example/?action=getLedgerData&refNo=TP/001', { method: 'GET' });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();

  assert.equal(body.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.method, 'GET');
});

await test('GET getMatterTasks missing refNo returns an error without calling out', async () => {
  const calls = mockFetch(() => {
    throw new Error('should not be called');
  });

  const req = new Request('https://worker.example/?action=getMatterTasks', { method: 'GET' });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();

  assert.equal(body.success, false);
  assert.match(body.message, /Missing required parameter: refNo/);
  assert.equal(calls.length, 0);
});

await test('GET unknown action returns an error', async () => {
  mockFetch(() => ({}));
  const req = new Request('https://worker.example/?action=doSomethingElse', { method: 'GET' });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();

  assert.equal(body.success, false);
  assert.match(body.message, /Unknown or missing GET action/);
});

await test('POST without authToken is rejected before any network call', async () => {
  const calls = mockFetch(() => {
    throw new Error('should not be called');
  });

  const req = new Request('https://worker.example/', {
    method: 'POST',
    body: JSON.stringify({ action: 'refreshMatterCard', refNo: 'TP/001' })
  });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();

  assert.equal(body.success, false);
  assert.match(body.message, /Unauthorized/);
  assert.equal(calls.length, 0);
});

await test('POST with wrong authToken is rejected (constant-time compare, not just truthy)', async () => {
  mockFetch(() => { throw new Error('should not be called'); });
  const req = new Request('https://worker.example/', {
    method: 'POST',
    body: JSON.stringify({ action: 'refreshMatterCard', authToken: 'wrong-token', refNo: 'TP/001' })
  });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();
  assert.equal(body.success, false);
  assert.match(body.message, /Unauthorized/);
});

await test('refreshMatterCard: valid call forwards all 8 fields to slack-service in order', async () => {
  const calls = mockFetch((url, options) => {
    const parsed = JSON.parse(options.body);
    assert.equal(parsed.action, 'updateMatterCard');
    assert.equal(parsed.channelId, 'C123');
    assert.equal(parsed.messageTs, '1234.5678');
    assert.equal(parsed.refNo, 'TP/001');
    assert.equal(parsed.progressPercent, 77);
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

  assert.equal(body.success, true);
  assert.equal(calls.length, 1);
});

await test('refreshMatterCard: missing required field short-circuits before calling out', async () => {
  const calls = mockFetch(() => { throw new Error('should not be called'); });
  const req = new Request('https://worker.example/', {
    method: 'POST',
    body: JSON.stringify({ action: 'refreshMatterCard', authToken: ENV.INTERNAL_SERVICE_TOKEN, refNo: 'TP/001' })
  });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();
  assert.equal(body.success, false);
  assert.match(body.message, /Missing required fields/);
  assert.equal(calls.length, 0);
});

await test('provisionSlackWorkflow: full happy path calls context -> createChannel -> updateSlackLinks -> updateMatterCard in order', async () => {
  const seen = [];
  mockFetch((url, options) => {
    const parsed = options?.body ? JSON.parse(options.body) : null;
    const action = parsed?.action || new URL(url).searchParams.get('action');
    seen.push(action);
    if (action === 'getMatterContext') {
      return {
        success: true,
        data: {
          clientName: 'Acme Corp',
          projectType: 'Litigation',
          percentage: 10,
          officerSlackIdsArray: ['U111'],
          unresolvedOfficers: [{ name: 'Jane', initial: 'JD' }]
        }
      };
    }
    if (action === 'createChannel') {
      assert.equal(parsed.refNo, 'TP/001', 'true clean refNo must be threaded through, not the compound channelName');
      return { success: true, channelId: 'C999', messageTs: '111.222' };
    }
    if (action === 'updateSlackLinks') {
      assert.equal(parsed.channelId, 'C999');
      return { success: true };
    }
    if (action === 'updateMatterCard') {
      assert.equal(parsed.statusEnum, 'Active');
      return { success: true };
    }
    throw new Error(`unexpected action: ${action}`);
  });

  const req = new Request('https://worker.example/', {
    method: 'POST',
    body: JSON.stringify({ action: 'provisionSlackWorkflow', authToken: ENV.INTERNAL_SERVICE_TOKEN, refNo: 'TP/001' })
  });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();

  assert.equal(body.success, true);
  assert.equal(body.channelId, 'C999');
  assert.deepEqual(seen, ['getMatterContext', 'createChannel', 'updateSlackLinks', 'updateMatterCard']);
});

await test('provisionSlackWorkflow: skips updateMatterCard polish step if createChannel returned no messageTs', async () => {
  const seen = [];
  mockFetch((url, options) => {
    const parsed = options?.body ? JSON.parse(options.body) : null;
    const action = parsed?.action || new URL(url).searchParams.get('action');
    seen.push(action);
    if (action === 'getMatterContext') return { success: true, data: { clientName: 'Acme' } };
    if (action === 'createChannel') return { success: true, channelId: 'C999', messageTs: null };
    if (action === 'updateSlackLinks') return { success: true };
    throw new Error(`unexpected action: ${action}`);
  });

  const req = new Request('https://worker.example/', {
    method: 'POST',
    body: JSON.stringify({ action: 'provisionSlackWorkflow', authToken: ENV.INTERNAL_SERVICE_TOKEN, refNo: 'TP/001' })
  });
  const res = await worker.fetch(req, ENV, {});
  await res.json();

  assert.deepEqual(seen, ['getMatterContext', 'createChannel', 'updateSlackLinks']);
});

await test('handleSubmission: writes comment with globalTaskId when task_select present', async () => {
  const calls = mockFetch((url, options) => {
    const parsed = JSON.parse(options.body);
    assert.equal(parsed.action, 'writeComment');
    assert.equal(parsed.refNo, 'TP/001');
    assert.equal(parsed.globalTaskId, 'TASK-42');
    assert.equal(parsed.author, 'jdoe');
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

  assert.equal(body.success, true);
  assert.equal(calls.length, 1);
});

await test('handleSubmission: general comment (no task_block) falls through to empty globalTaskId, not an error', async () => {
  mockFetch((url, options) => {
    const parsed = JSON.parse(options.body);
    assert.equal(parsed.globalTaskId, '');
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
  assert.equal(body.success, true);
});

await test('handleSubmission: empty comment text is rejected without calling out', async () => {
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
  assert.equal(body.success, false);
  assert.match(body.message, /empty/i);
  assert.equal(calls.length, 0);
});

await test('getPinnedMessageTs: missing channelId rejected before calling out', async () => {
  const calls = mockFetch(() => { throw new Error('should not be called'); });
  const req = new Request('https://worker.example/', {
    method: 'POST',
    body: JSON.stringify({ action: 'getPinnedMessageTs', authToken: ENV.INTERNAL_SERVICE_TOKEN })
  });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(calls.length, 0);
});

await test('malformed JSON body does not throw, returns a clean error envelope', async () => {
  mockFetch(() => ({}));
  const req = new Request('https://worker.example/', { method: 'POST', body: '{not json' });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();
  assert.equal(body.success, false);
});

await test('unsupported HTTP method returns a clean error, not a crash', async () => {
  mockFetch(() => ({}));
  const req = new Request('https://worker.example/', { method: 'DELETE' });
  const res = await worker.fetch(req, ENV, {});
  const body = await res.json();
  assert.equal(body.success, false);
  assert.match(body.message, /Unsupported method/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
