const https = require('https');

const FATHOM_API_KEY = process.env.FATHOM_API_KEY;

function fathomRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.fathom.video',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${FATHOM_API_KEY}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Invalid JSON: ' + raw.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
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
    const { query } = JSON.parse(event.body || '{}');

    // List recent calls
    const callsRes = await fathomRequest('/v1/calls?limit=20');
    if (callsRes.error || !callsRes.calls) {
      throw new Error(callsRes.error || 'Could not fetch calls from Fathom');
    }

    // Find most recent Turnfairy call
    const searchTerm = (query || 'Turnfairy').toLowerCase();
    let targetCall = callsRes.calls.find(c =>
      c.title?.toLowerCase().includes(searchTerm) ||
      c.title?.toLowerCase().includes('manager') ||
      c.participants?.some(p => p.email?.includes('turnfairy'))
    );

    // Fall back to most recent call if no match
    if (!targetCall && callsRes.calls.length > 0) {
      targetCall = callsRes.calls[0];
    }

    if (!targetCall) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No calls found in Fathom' }) };
    }

    // Get transcript for the call
    const transcriptRes = await fathomRequest(`/v1/calls/${targetCall.id}/transcript`);
    if (transcriptRes.error) {
      throw new Error(transcriptRes.error || 'Could not fetch transcript');
    }

    // Format transcript text from segments
    let transcriptText = '';
    if (transcriptRes.transcript) {
      transcriptText = transcriptRes.transcript;
    } else if (transcriptRes.segments) {
      transcriptText = transcriptRes.segments
        .map(s => `${s.speaker || 'Speaker'}: ${s.text}`)
        .join('\n');
    } else if (Array.isArray(transcriptRes)) {
      transcriptText = transcriptRes
        .map(s => `${s.speaker || s.speakerName || 'Speaker'}: ${s.text || s.content}`)
        .join('\n');
    }

    if (!transcriptText) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transcript not yet available — Fathom may still be processing. Try again in a few minutes.' }) };
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        transcript: transcriptText,
        title: targetCall.title,
        meetingDate: targetCall.started_at ? targetCall.started_at.split('T')[0] : null,
        callId: targetCall.id,
      }),
    };

  } catch(err) {
    console.error('Fathom error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
