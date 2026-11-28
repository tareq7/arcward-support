import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, resetRateLimiterForTests } from '../src/index.mjs';

const baseEnv = {
  ARCWARD_RESEND_API_KEY: 're_test_mock_key_not_real',
  SUPPORT_FROM_EMAIL: 'Arcward Theme Support <care@lolly.ae>',
  SUPPORT_TO_EMAIL: 'care@lolly.ae',
  SUPPORT_SUCCESS_URL: 'https://tareq7.github.io/arcward-support/thanks.html',
  SUPPORT_ORIGIN: 'https://tareq7.github.io',
};

function makeForm(overrides = {}) {
  const fd = new FormData();
  const fields = {
    first_name: 'Jordan',
    last_name: 'Taylor',
    email: 'merchant@example.com',
    store_url: 'https://demo-merchant.myshopify.com',
    theme_name: 'Arcward (Home)',
    theme_version: '1.0.0',
    _subject: 'Hero slideshow question',
    description: 'How do I add a second slide in the Arcward Home hero carousel?',
    _honey: '',
    ...overrides,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) fd.set(k, v);
  }
  return fd;
}

test('GET /health returns safe service status without leaking secrets', async () => {
  const res = await handleRequest(new Request('https://arcward-support-api.najetareqz.workers.dev/health'), baseEnv);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'arcward-support-api');
  assert.equal(body.resendConfigured, true);
  assert.equal(body.slaBusinessDays, 2);
  assert.doesNotMatch(JSON.stringify(body), /re_test_mock/);
});

test('POST /submit fails closed with 503 when ARCWARD_RESEND_API_KEY is absent', async () => {
  resetRateLimiterForTests();
  const req = new Request('https://arcward-support-api.najetareqz.workers.dev/submit', {
    method: 'POST',
    headers: { Accept: 'application/json', 'cf-connecting-ip': '203.0.113.10' },
    body: makeForm(),
  });
  const res = await handleRequest(req, { ...baseEnv, ARCWARD_RESEND_API_KEY: '' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /care@lolly\.ae/);
});

test('POST /submit rejects CRLF email injection and invalid attachments', async () => {
  resetRateLimiterForTests();
  const badEmailReq = new Request('https://arcward-support-api.najetareqz.workers.dev/submit', {
    method: 'POST',
    headers: { Accept: 'application/json', 'cf-connecting-ip': '203.0.113.11' },
    body: makeForm({ email: 'evil@example.com\r\nBcc: victim@example.com' }),
  });
  const res1 = await handleRequest(badEmailReq, baseEnv);
  assert.equal(res1.status, 400);

  const fdBadFile = makeForm();
  fdBadFile.set('attachment', new File([new Uint8Array([1, 2, 3])], 'payload.html', { type: 'text/html' }));
  const badFileReq = new Request('https://arcward-support-api.najetareqz.workers.dev/submit', {
    method: 'POST',
    headers: { Accept: 'application/json', 'cf-connecting-ip': '203.0.113.12' },
    body: fdBadFile,
  });
  const res2 = await handleRequest(badFileReq, baseEnv);
  assert.equal(res2.status, 400);
});

test('POST /submit traps honeypot submissions without calling Resend', async () => {
  resetRateLimiterForTests();
  let calls = 0;
  const req = new Request('https://arcward-support-api.najetareqz.workers.dev/submit', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '203.0.113.13' },
    body: makeForm({ _honey: 'spam-bot-value' }),
  });
  const res = await handleRequest(req, baseEnv, { fetch: async () => { calls++; throw new Error('must not send'); } });
  assert.equal(res.status, 303);
  assert.equal(calls, 0);
});

test('POST /submit sends ticket + PNG attachment to care@lolly.ae AND 2-business-day auto-responder to merchant, redirecting 303', async () => {
  resetRateLimiterForTests();
  const sent = [];
  const fakeFetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: `em_${sent.length}` }), { status: 200 });
  };
  const fd = makeForm({ description: 'Problem with <script>alert(1)</script> section spacing.' });
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  fd.set('attachment', new File([pngBytes], 'bug screenshot.png', { type: 'image/png' }));

  const req = new Request('https://arcward-support-api.najetareqz.workers.dev/submit', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '203.0.113.14' },
    body: fd,
  });
  const res = await handleRequest(req, baseEnv, { fetch: fakeFetch });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://tareq7.github.io/arcward-support/thanks.html?ref=em_1');
  assert.equal(sent.length, 2);

  // 1) Support ticket to care@lolly.ae
  assert.deepEqual(sent[0].body.to, ['care@lolly.ae']);
  assert.equal(sent[0].body.reply_to, 'merchant@example.com');
  assert.equal(sent[0].body.from, 'Arcward Theme Support <care@lolly.ae>');
  assert.match(sent[0].body.subject, /Hero slideshow question/);
  assert.equal(sent[0].body.attachments.length, 1);
  assert.equal(sent[0].body.attachments[0].filename, 'bug_screenshot.png');
  assert.equal(sent[0].body.attachments[0].content, Buffer.from(pngBytes).toString('base64'));
  assert.doesNotMatch(sent[0].body.html, /<script>/);
  assert.match(sent[0].body.html, /&lt;script&gt;/);

  // 2) Auto-responder to merchant
  assert.deepEqual(sent[1].body.to, ['merchant@example.com']);
  assert.equal(sent[1].body.reply_to, 'care@lolly.ae');
  assert.match(sent[1].body.text, /2 business days/);
  assert.match(sent[1].body.text, /em_1/);
});

test('POST /submit enforces per-IP rate limit (429 on 6th request in window)', async () => {
  resetRateLimiterForTests();
  const fakeFetch = async () => new Response(JSON.stringify({ id: 'em_ok' }), { status: 200 });
  for (let i = 0; i < 5; i++) {
    const r = await handleRequest(new Request('https://arcward-support-api.najetareqz.workers.dev/submit', {
      method: 'POST',
      headers: { Accept: 'application/json', 'cf-connecting-ip': '203.0.113.99' },
      body: makeForm(),
    }), baseEnv, { fetch: fakeFetch, now: () => 1000000 + i * 1000 });
    assert.equal(r.status, 200);
  }
  const blocked = await handleRequest(new Request('https://arcward-support-api.najetareqz.workers.dev/submit', {
    method: 'POST',
    headers: { Accept: 'application/json', 'cf-connecting-ip': '203.0.113.99' },
    body: makeForm(),
  }), baseEnv, { fetch: fakeFetch, now: () => 1006000 });
  assert.equal(blocked.status, 429);
});
