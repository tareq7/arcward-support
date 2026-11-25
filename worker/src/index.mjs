/**
 * Arcward Theme Support API — Standalone Cloudflare Worker (Free Tier)
 * Shopify Theme Store §21 compliant contact form handler with Resend delivery,
 * optional <=10 MB attachment pass-through (zero server storage), and automatic
 * 2-business-day merchant acknowledgement email.
 */

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
]);
const ALLOWED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf']);
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"\r\n]+@[^\s@<>()[\]\\,;:"\r\n]+\.[^\s@<>()[\]\\,;:"\r\n]{2,}$/;

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_REQUESTS = 5;
const ipHits = new Map();

export function resetRateLimiterForTests() {
  ipHits.clear();
}

function checkRateLimit(ip, now = Date.now()) {
  if (!ip) return true;
  const recent = (ipHits.get(ip) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_REQUESTS) {
    ipHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  ipHits.set(ip, recent);
  if (ipHits.size > 2000) {
    for (const [k, arr] of ipHits) {
      const kept = arr.filter((ts) => now - ts < RATE_WINDOW_MS);
      if (kept.length === 0) ipHits.delete(k);
      else ipHits.set(k, kept);
    }
  }
  return true;
}

function stripCrlf(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function cleanMultiline(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeFilename(name) {
  const base = String(name || 'attachment').split(/[\\/]/).pop() || 'attachment';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'attachment';
}

function getExt(name) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function validStoreUrl(raw) {
  const trimmed = stripCrlf(raw);
  if (!trimmed || trimmed.length > 250) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.SUPPORT_ORIGIN || 'https://tareq7.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Vary': 'Origin',
  };
}

function wantsJson(request) {
  return (request.headers.get('accept') || '').toLowerCase().includes('application/json');
}

function respondError(request, env, status, message) {
  if (wantsJson(request)) {
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
    });
  }
  const supportEmail = env.SUPPORT_TO_EMAIL || 't.naji@tribonds.net';
  const backUrl = env.SUPPORT_FORM_URL || 'https://tareq7.github.io/arcward-support/';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Support Request Notice — Arcward</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1.25rem;background:#faf9f6;color:#171614}.card{background:#fff;border:1px solid #d8d3c8;border-radius:12px;padding:1.75rem}a{color:#184e4a;font-weight:600}</style></head><body><main class="card"><h1>Could not submit support request</h1><p>${escapeHtml(message)}</p><p>You can return to the <a href="${escapeHtml(backUrl)}">support form</a> or email us directly at <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(env) },
  });
}

async function sendResendEmail(fetchImpl, apiKey, payload) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ArcwardSupportWorker/1.0',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new Error(`Resend HTTP ${res.status}: ${parsed.message || text.slice(0, 200)}`);
  }
  return parsed;
}

export async function handleRequest(request, env = {}, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = deps.now ? deps.now() : Date.now();
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return new Response(JSON.stringify({
      ok: true,
      service: 'arcward-support-api',
      provider: 'resend',
      resendConfigured: Boolean(env.ARCWARD_RESEND_API_KEY),
      fromAddress: env.SUPPORT_FROM_EMAIL || 'Arcward Theme Support <support@tribonds.net>',
      supportRecipient: env.SUPPORT_TO_EMAIL || 't.naji@tribonds.net',
      freeTier: true,
      slaBusinessDays: 2,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
    });
  }

  if (request.method !== 'POST' || url.pathname !== '/submit') {
    return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
    });
  }

  const clientIp = request.headers.get('cf-connecting-ip') || '';
  if (!checkRateLimit(clientIp, now)) {
    return respondError(request, env, 429, 'Too many support requests from this network. Please wait a few minutes or email t.naji@tribonds.net directly.');
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return respondError(request, env, 400, 'Invalid form submission payload.');
  }

  const successUrl = env.SUPPORT_SUCCESS_URL || 'https://tareq7.github.io/arcward-support/thanks.html';
  const honey = stripCrlf(formData.get('_honey'));
  if (honey) {
    if (wantsJson(request)) {
      return new Response(JSON.stringify({ ok: true, filtered: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
      });
    }
    return Response.redirect(successUrl, 303);
  }

  const firstName = stripCrlf(formData.get('first_name'));
  const lastName = stripCrlf(formData.get('last_name'));
  const combinedName = stripCrlf(formData.get('name')) || `${firstName} ${lastName}`.trim();
  const rawEmail = String(formData.get('email') ?? '');
  const email = rawEmail.trim();
  const storeUrl = validStoreUrl(formData.get('store_url'));
  const themeName = stripCrlf(formData.get('theme_name') || formData.get('theme') || 'Arcward') || 'Arcward';
  const themeVersion = stripCrlf(formData.get('theme_version'));
  const subject = stripCrlf(formData.get('_subject') || formData.get('subject'));
  const description = cleanMultiline(formData.get('description') || formData.get('message'));

  if (!combinedName || combinedName.length < 2 || combinedName.length > 120) {
    return respondError(request, env, 400, 'Please enter your first and last name (2–120 characters).');
  }
  if (/[\r\n]/.test(rawEmail) || !EMAIL_RE.test(email) || email.length > 254) {
    return respondError(request, env, 400, 'Please enter a valid email address.');
  }
  if (!storeUrl) {
    return respondError(request, env, 400, 'Please enter a valid Shopify store URL (for example, https://storename.myshopify.com).');
  }
  if (!subject || subject.length < 2 || subject.length > 160) {
    return respondError(request, env, 400, 'Please enter a brief subject (2–160 characters).');
  }
  if (!description || description.length < 10 || description.length > 10000) {
    return respondError(request, env, 400, 'Please describe your issue in at least 10 characters.');
  }

  const attachments = [];
  const fileEntry = formData.get('attachment');
  if (fileEntry && typeof fileEntry === 'object' && typeof fileEntry.arrayBuffer === 'function' && fileEntry.size > 0) {
    if (fileEntry.size > MAX_ATTACHMENT_BYTES) {
      return respondError(request, env, 413, 'Attachment exceeds the 10 MB maximum file size.');
    }
    const safeName = sanitizeFilename(fileEntry.name);
    const ext = getExt(safeName);
    const mime = String(fileEntry.type || '').toLowerCase();
    if (!ALLOWED_EXTS.has(ext) || (mime && !ALLOWED_MIME_TYPES.has(mime))) {
      return respondError(request, env, 400, 'Unsupported attachment type. Please upload PNG, JPG, WebP, or PDF only.');
    }
    const buf = await fileEntry.arrayBuffer();
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      return respondError(request, env, 413, 'Attachment exceeds the 10 MB maximum file size.');
    }
    attachments.push({
      filename: safeName,
      content: arrayBufferToBase64(buf),
    });
  }

  const apiKey = (env.ARCWARD_RESEND_API_KEY || '').trim();
  if (!apiKey) {
    return respondError(
      request,
      env,
      503,
      'Online support form delivery is pending domain sender activation. Please email your request directly to t.naji@tribonds.net and we will reply within 2 business days.'
    );
  }

  const fromAddress = (env.SUPPORT_FROM_EMAIL || 'Arcward Theme Support <support@tribonds.net>').trim();
  const toAddress = (env.SUPPORT_TO_EMAIL || 't.naji@tribonds.net').trim();
  const submittedAt = new Date(now).toISOString();

  const ticketText = [
    'Arcward Theme Support Request',
    `Submitted: ${submittedAt}`,
    `Name: ${combinedName}`,
    `Email: ${email}`,
    `Store URL: ${storeUrl}`,
    `Theme / Preset: ${themeName}${themeVersion ? ` (v${themeVersion})` : ''}`,
    `Subject: ${subject}`,
    `Attachment: ${attachments.length ? attachments[0].filename : 'None'}`,
    '',
    'Description:',
    description,
  ].join('\n');

  const ticketHtml = `<h2>Arcward Theme Support Request</h2>
<table style="border-collapse:collapse;font:14px/1.5 system-ui,sans-serif">
<tr><th align="left" style="padding:4px 12px 4px 0">Name</th><td>${escapeHtml(combinedName)}</td></tr>
<tr><th align="left" style="padding:4px 12px 4px 0">Email</th><td>${escapeHtml(email)}</td></tr>
<tr><th align="left" style="padding:4px 12px 4px 0">Store URL</th><td><a href="${escapeHtml(storeUrl)}">${escapeHtml(storeUrl)}</a></td></tr>
<tr><th align="left" style="padding:4px 12px 4px 0">Theme / Preset</th><td>${escapeHtml(themeName)}${themeVersion ? ` (v${escapeHtml(themeVersion)})` : ''}</td></tr>
<tr><th align="left" style="padding:4px 12px 4px 0">Subject</th><td>${escapeHtml(subject)}</td></tr>
<tr><th align="left" style="padding:4px 12px 4px 0">Submitted (UTC)</th><td>${escapeHtml(submittedAt)}</td></tr>
</table>
<h3>Description</h3>
<pre style="white-space:pre-wrap;font:14px/1.6 system-ui,sans-serif;background:#f7f6f2;padding:12px;border-radius:8px">${escapeHtml(description)}</pre>`;

  const ticketPayload = {
    from: fromAddress,
    to: [toAddress],
    reply_to: email,
    subject: `[Arcward Support] ${subject} (${themeName})`,
    text: ticketText,
    html: ticketHtml,
  };
  if (attachments.length) ticketPayload.attachments = attachments;

  let ticketRes;
  try {
    ticketRes = await sendResendEmail(fetchImpl, apiKey, ticketPayload);
  } catch {
    return respondError(request, env, 502, 'We could not deliver your request right now. Please email t.naji@tribonds.net directly.');
  }

  const ticketId = ticketRes.id || 'received';
  const autoText = [
    `Hello ${combinedName},`,
    '',
    'Thank you for contacting Arcward Theme Support (Tri Bonds General Trading).',
    `We have received your support request ("${subject}") for ${themeName}.`,
    `Reference ID: ${ticketId}`,
    '',
    'Our support team replies within 2 business days.',
    `You can also reply directly to ${toAddress}. Please never share store passwords, collaborator codes, or customer personal data.`,
    '',
    'Merchant Help Center: https://docs.google.com/document/d/1zxeEdq4sUVrPmYXc-W6X9Tl5hRslM8XnWGYdiWHP6C8/edit',
  ].join('\n');

  let autoResponseId = null;
  try {
    const autoRes = await sendResendEmail(fetchImpl, apiKey, {
      from: fromAddress,
      to: [email],
      reply_to: toAddress,
      subject: `We received your Arcward support request: ${subject}`,
      text: autoText,
      html: `<p>Hello ${escapeHtml(combinedName)},</p><p>Thank you for contacting <strong>Arcward Theme Support</strong> (Tri Bonds General Trading). We have received your support request (<strong>${escapeHtml(subject)}</strong>) for ${escapeHtml(themeName)}.</p><p><strong>Reference ID:</strong> <code>${escapeHtml(ticketId)}</code></p><p>We reply to all merchant support requests within <strong>2 business days</strong>. Please never share store passwords, collaborator codes, or customer personal data.</p><p><a href="https://docs.google.com/document/d/1zxeEdq4sUVrPmYXc-W6X9Tl5hRslM8XnWGYdiWHP6C8/edit">Arcward Merchant Help Center &amp; FAQ</a></p>`,
    });
    autoResponseId = autoRes.id || null;
  } catch {
    // Ticket was already delivered; surface status transparently in JSON if requested
  }

  if (wantsJson(request)) {
    return new Response(JSON.stringify({ ok: true, ticketId, autoResponseId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
    });
  }

  const redirectTarget = new URL(successUrl);
  redirectTarget.searchParams.set('ref', ticketId);
  return Response.redirect(redirectTarget.toString(), 303);
}

export default {
  fetch: (request, env) => handleRequest(request, env),
};
