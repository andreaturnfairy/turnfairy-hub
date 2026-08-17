// verify-pin.js — server-side Manager Hub PIN verification.
//
// ADDED 2026-08-16. Replaces client-side PIN checking, which had two defects:
//
//   1. EXPOSURE. The front-end fetched `notion-get?type=settings` and read the
//      `pin_*` values out of it. That endpoint is public and unauthenticated,
//      so every team PIN was readable by anyone with the URL — confirmed from
//      an unauthenticated sandbox. The PINs are the Hub's only access control.
//
//   2. FAIL-OPEN. The check was `if (expected && pin !== expected)`. When the
//      settings fetch failed for any reason, `_userPins` stayed empty,
//      `expected` was undefined, and the comparison was SKIPPED — so any four
//      digits granted access. A network blip was an authentication bypass.
//
// This function keeps PIN values server-side. It answers only "yes" or "no"
// and never returns a PIN, a PIN list, or which names have PINs configured.
//
// Deliberate design notes:
//   - Fails CLOSED. Any error returns ok:false, never ok:true.
//   - A name with no configured PIN is DENIED, not waved through. If you want
//     open access for someone, give them a PIN.
//   - Timing-safe comparison, so response time does not leak digits.
//   - Uniform error text: the caller cannot distinguish "no such user" from
//     "wrong PIN", which would otherwise enumerate the team list.

const crypto = require('crypto');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_SETTINGS = process.env.NOTION_DB_SETTINGS;

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // crypto.timingSafeEqual throws on length mismatch, which would itself leak
  // length. Hash both to a fixed width first, then compare.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  const deny = { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'Incorrect PIN. Try again.' }) };

  try {
    if (!NOTION_TOKEN || !NOTION_DB_SETTINGS) {
      console.error('verify-pin: NOTION_TOKEN or NOTION_DB_SETTINGS not configured');
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'PIN verification unavailable. Contact an admin.' }) };
    }

    const { name, pin } = JSON.parse(event.body || '{}');
    if (!name || !pin) return deny;

    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_SETTINGS}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({ filter: { property: 'Key', title: { equals: `pin_${name}` } } }),
    });

    if (!res.ok) {
      // Fail CLOSED. This is the branch the old client-side code got wrong.
      console.error(`verify-pin: Notion query failed ${res.status}`);
      return { statusCode: 503, headers, body: JSON.stringify({ ok: false, error: 'PIN verification unavailable. Try again shortly.' }) };
    }

    const data = await res.json();
    const row = (data.results || [])[0];
    const expected = row?.properties?.['Value']?.rich_text?.[0]?.plain_text;

    // No PIN configured for this name => DENY. The old code granted access.
    if (!expected) {
      console.warn(`verify-pin: no PIN configured for "${name}" — denied`);
      return deny;
    }

    if (!timingSafeEqual(pin, expected)) {
      console.warn(`verify-pin: incorrect PIN attempt for "${name}"`);
      return deny;
    }

    console.log(`verify-pin: success for "${name}"`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, name }) };

  } catch (err) {
    console.error('verify-pin error:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'PIN verification unavailable. Try again shortly.' }) };
  }
};
