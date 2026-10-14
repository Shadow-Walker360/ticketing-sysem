import { randomUUID } from 'node:crypto';

/**
 * Stand-in for a real payment provider (M-Pesa, Stripe, ...).
 * Tokens of the form "tok_..." succeed, except "tok_decline" which is declined.
 */
export async function charge({ token }) {
  if (token === 'tok_decline') {
    return { ok: false, reference: 'card_declined' };
  }
  if (!/^tok_[A-Za-z0-9_]+$/.test(token)) {
    return { ok: false, reference: 'invalid_token' };
  }
  return { ok: true, reference: `mock_${randomUUID()}` };
}
