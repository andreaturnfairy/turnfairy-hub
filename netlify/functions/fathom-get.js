// fathom-get.js — pulls the latest Turnfairy call transcript from Fathom.
//
// REPAIRED 2026-08-16. Two bugs made this endpoint fail 100% of the time:
//
//   1. Doubled version prefix. fathomRequest() already prepends
//      `/external/v1`, but callers passed `/v1/calls`, producing
//      `https://api.fathom.ai/external/v1/v1/calls`.
//   2. Nonexistent endpoints. Fathom has no `/calls` or
//      `/calls/{id}/transcript`. The real list endpoint is `/meetings`,
//      which can return the transcript inline via `include_transcript=true`.
//
// auto-process-call-background.js was fixed for exactly this in an earlier
// session and carries a comment saying so; the fix was never applied here.
// That is why the scheduled job could work while the Transcript tab did not.
//
// Call selection is by calendar invitee, NOT by title: every recording in
// this Fathom account comes through as "Impromptu Google Meet Meeting", so
// title matching silently matches everything or nothing.

const https = require('https');

const FATHOM_API_KEY = process.env.FATHOM_API_KEY;
const PENNY_EMAIL = (process.env.PENNY_EMAIL || 'vapennylaine@gmail.com').toLowerCase();

function fathomRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.fathom.ai',
      path: `/external/v1${path}`,
      method: 'GET',
      headers: {
        'X-Api-Key': FATHOM_API_KEY,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Fathom ${path}: ${res.statusCode} ${raw.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Invalid JSON from Fathom: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Collect every email attached to a meeting, across the response shapes
// Fathom has used for invitees.
function emailsOf(meeting) {
  const out = [];
  const push = (v) => { if (v && typeof v === 'string') out.push(v.toLowerCase()); };
  for (const list of [meeting.calendar_invitees, meeting.invitees, meeting.participants]) {
    if (Array.isArray(list)) list.forEach(p => push(typeof p === 'string' ? p : (p && (p.email || p.email_address))));
  }
  const rb = meeting.recorded_by;
  if (rb) push(typeof rb === 'string' ? rb : rb.email);
  return out;
}

// Impromptu recordings may carry no calendar event, so calendar_invitees
// can be empty. Fall back to whether Penny actually spoke.
function speakersOf(meeting) {
  const t = meeting.transcript;
  if (!Array.isArray(t)) return [];
  return t.map(s => String(
    (s && s.speaker && (s.speaker.display_name || s.speaker.name)) || (s && s.speaker) || (s && s.speakerName) || ''
  ).toLowerCase());
}

const isPennyCall = (m) =>
  emailsOf(m).includes(PENNY_EMAIL) ||
  speakersOf(m).some(n => /penny|pennylaine/.test(n));

// Fathom returns a transcript as an array of { speaker, text } items.
// Older/other shapes are tolerated so a response-format change degrades
// to "no transcript" rather than a crash.
function transcriptText(meeting) {
  const t = meeting.transcript;
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    return t
      .map(s => {
        if (typeof s === 'string') return s;
        const who = (s.speaker && (s.speaker.display_name || s.speaker.name)) || s.speaker || s.speakerName || 'Speaker';
        return `${who}: ${s.text || s.content || ''}`;
      })
      .join('\n');
  }
  return '';
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!FATHOM_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'FATHOM_API_KEY not configured in Netlify environment variables' }) };
  }

  try {
    // `kind` lets the caller ask for the weekly manager call or the Penny
    // call explicitly. Default is the weekly call.
    const { kind, days } = JSON.parse(event.body || '{}');
    const lookbackDays = Number(days) > 0 ? Number(days) : 14;
    const cutoffIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    const res = await fathomRequest(
      `/meetings?created_after=${encodeURIComponent(cutoffIso)}&include_transcript=true`
    );
    const meetings = res.items || res.data || [];

    if (!meetings.length) {
      return {
        statusCode: 404, headers,
        body: JSON.stringify({ error: `No Fathom calls found in the last ${lookbackDays} days.` }),
      };
    }

    // Sort newest-first rather than trusting the API's order.
    const dateOf = (m) => new Date(m.created_at || m.scheduled_start_time || m.start_time || m.recorded_at || 0).getTime();
    const sorted = meetings.slice().sort((a, b) => dateOf(b) - dateOf(a));

    const wantPenny = /penny/i.test(kind || '');
    const targetCall = sorted.find(m => isPennyCall(m) === wantPenny) || sorted[0];

    const text = transcriptText(targetCall);
    if (!text || text.length < 100) {
      return {
        statusCode: 404, headers,
        body: JSON.stringify({
          error: 'Transcript not yet available — Fathom may still be processing this call. Try again in a few minutes.',
          title: targetCall.title,
          recordingId: targetCall.recording_id || targetCall.id || null,
        }),
      };
    }

    const rawDate = targetCall.created_at || targetCall.scheduled_start_time || targetCall.start_time || targetCall.recorded_at;

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        transcript: text,
        title: targetCall.title,
        meetingDate: rawDate ? String(rawDate).split('T')[0] : null,
        callId: targetCall.recording_id || targetCall.id || null,
        recordingId: targetCall.recording_id || null,
        url: targetCall.url || null,
        isPennyCall: isPennyCall(targetCall),
      }),
    };

  } catch (err) {
    console.error('Fathom error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
