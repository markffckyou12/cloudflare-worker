import assert from 'node:assert/strict';
import worker from '../src/index.js';

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

test('GET getLedgerData proxies to database-service unauthenticated', async () => {
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

// ... repeat for all other tests, changing `await test(` to `test(`
