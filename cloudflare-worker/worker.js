/**
 * LOGINA — Waitlist gateway (Cloudflare Worker)
 * ---------------------------------------------
 * Browser (GitHub Pages)  ->  THIS WORKER  ->  Google Apps Script  ->  Google Sheet
 *
 * Why: the shared secret and spam checks live here, on Cloudflare's servers.
 * The browser never sees the secret. GitHub Pages only knows this Worker's public URL.
 *
 * Secrets / vars (set with `wrangler secret put` or in the dashboard):
 *   APPS_SCRIPT_URL   - your Google Apps Script Web App URL (ends with /exec)
 *   SHARED_SECRET     - a long random string; the .gs script checks this
 *   ALLOWED_ORIGIN    - your site origin, e.g. https://you.github.io  (or a custom domain)
 *                       Use "*" only for quick testing; lock it down before go-live.
 *   TURNSTILE_SECRET  - (optional) Cloudflare Turnstile secret key for CAPTCHA check
 *
 * Rate limiting uses an in-memory counter per isolate. It's best-effort and resets
 * when the isolate recycles. For strict limits, bind a KV namespace (see README).
 */

const MIN_FILL_MS = 2000;      // reject form submitted faster than 2s (bots)
const MAX_AGE_MS = 1000 * 60 * 60; // reject stale forms older than 1 hour
const RATE_MAX = 5;            // max submissions...
const RATE_WINDOW_MS = 60_000; // ...per IP per minute

const hits = new Map(); // ip -> [timestamps] (best-effort, per-isolate)

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    const cors = corsHeaders(origin, allowOrigin);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405, cors);
    }
    // Origin allow-list (skip when ALLOWED_ORIGIN is "*")
    if (allowOrigin !== '*' && origin && origin !== allowOrigin) {
      return json({ ok: false, error: 'Forbidden origin' }, 403, cors);
    }

    // Rate limit by client IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(ip)) {
      return json({ ok: false, error: 'Too many requests. Please try again shortly.' }, 429, cors);
    }

    // Parse body
    let data;
    try {
      data = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400, cors);
    }

    // --- Spam checks ---
    // 1) Honeypot: a hidden field real users leave empty.
    if (data.company_website) {
      // Pretend success so bots don't learn they were caught.
      return json({ ok: true }, 200, cors);
    }
    // 2) Timing: form must have been on screen a human amount of time.
    const elapsed = Date.now() - Number(data.formLoadedAt || 0);
    if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS || elapsed > MAX_AGE_MS) {
      return json({ ok: false, error: 'Form submitted too quickly. Please try again.' }, 400, cors);
    }

    // 3) Optional Turnstile CAPTCHA verification
    if (env.TURNSTILE_SECRET) {
      const ok = await verifyTurnstile(env.TURNSTILE_SECRET, data.turnstileToken, ip);
      if (!ok) return json({ ok: false, error: 'CAPTCHA verification failed.' }, 400, cors);
    }

    // --- Required field validation (defence in depth; .gs validates too) ---
    if (!data.name || !data.email || !data.role || data.consent !== true) {
      return json({ ok: false, error: 'Missing required fields.' }, 400, cors);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email))) {
      return json({ ok: false, error: 'Invalid email.' }, 400, cors);
    }

    if (!env.APPS_SCRIPT_URL || !env.SHARED_SECRET) {
      return json({ ok: false, error: 'Server not configured.' }, 500, cors);
    }

    // Forward to Apps Script with the shared secret attached.
    const payload = {
      secret: env.SHARED_SECRET,
      name: String(data.name).slice(0, 200),
      email: String(data.email).slice(0, 200),
      role: String(data.role).slice(0, 100),
      organization: String(data.organization || '').slice(0, 200),
      context: String(data.context || '').slice(0, 1000),
      consent: data.consent === true,
      source: String(data.source || 'LOGINA waitlist landing page').slice(0, 120),
      submittedAt: String(data.submittedAt || new Date().toISOString())
    };

    try {
      const upstream = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const text = await upstream.text();
      let result;
      try { result = JSON.parse(text); } catch { result = { ok: upstream.ok, raw: text }; }
      if (!upstream.ok || result.ok === false) {
        return json({ ok: false, error: result.error || 'Upstream error' }, 502, cors);
      }
      return json({ ok: true, duplicate: result.duplicate === true }, 200, cors);
    } catch (err) {
      return json({ ok: false, error: 'Could not reach storage backend.' }, 502, cors);
    }
  }
};

function isRateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body
    });
    const out = await r.json();
    return out.success === true;
  } catch {
    return false;
  }
}

function corsHeaders(origin, allowOrigin) {
  const allow = allowOrigin === '*' ? '*' : (origin === allowOrigin ? origin : allowOrigin);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}
