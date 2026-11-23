'use strict';

/**
 * Paddle helpers (Pass 3: subscriptions).
 *
 * Paddle keys come from the environment ONLY (PADDLE_API_KEY,
 * PADDLE_WEBHOOK_SECRET, PADDLE_ENV). No real keys in the repo, ever.
 * Until Rza's Paddle account is verified and the keys are set, the
 * platform runs in sandbox / not-configured mode and says so honestly
 * wherever the subscription is shown.
 *
 * Webhook verification follows Paddle's documented scheme:
 *   Paddle-Signature: ts=<unix seconds>;h1=<hmac-sha256 hex>
 *   h1 = HMAC-SHA256(webhook_secret, "<ts>:<raw request body>")
 * Several h1 values may be present (key rotation) — any match accepts.
 */

const crypto = require('node:crypto');

/** 'sandbox' | 'live' | 'not-configured'. Sandbox until Paddle is live. */
function paddleMode() {
  if (!process.env.PADDLE_API_KEY) return 'not-configured';
  return process.env.PADDLE_ENV === 'live' ? 'live' : 'sandbox';
}

function paddleConfigured() {
  return !!process.env.PADDLE_API_KEY;
}

/**
 * Verify a Paddle webhook signature against the raw request body.
 * Returns { ok: true } or { ok: false, error }.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: false, error: 'Paddle webhook is not configured — set PADDLE_WEBHOOK_SECRET in the environment.' };
  }
  if (!signatureHeader) {
    return { ok: false, error: 'Missing Paddle-Signature header.' };
  }
  const parts = String(signatureHeader).split(';').map((s) => s.trim());
  const ts = (parts.find((p) => p.startsWith('ts=')) || '').slice(3);
  const h1s = parts.filter((p) => p.startsWith('h1=')).map((p) => p.slice(3));
  if (!ts || h1s.length === 0) {
    return { ok: false, error: 'Paddle-Signature header is malformed.' };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}:${rawBody.toString('utf8')}`)
    .digest('hex');
  const ok = h1s.some(
    (h) => h.length === expected.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(expected))
  );
  return ok
    ? { ok: true }
    : { ok: false, error: 'Paddle webhook signature does not match — event rejected.' };
}

/** Map a Paddle subscription status to our clinic subscription_status. */
function mapPaddleStatus(paddleStatus) {
  switch (paddleStatus) {
    case 'trialing':
      return 'trial';
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'canceled':
      return 'cancelled';
    case 'past_due':
      return null; // payment failed — Paddle retries; keep the current status
    default:
      return null;
  }
}

module.exports = { paddleMode, paddleConfigured, verifyWebhookSignature, mapPaddleStatus };
