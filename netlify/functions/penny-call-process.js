// ─────────────────────────────────────────────────────────────
// penny-call-process.js
// Thin TRIGGER function — invoked manually (POST or GET) after
// each Penny monthly call. Kicks off
// penny-call-process-background.js and returns immediately, so
// the caller never waits on or times out from the slow Claude
// analysis step. See auto-process-call.js for the same pattern
// applied to the manager weekly call.
// ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const isManual = event.httpMethod === 'POST' || event.httpMethod === 'GET';
  if (!isManual) return { statusCode: 405, body: 'Method not allowed' };

  try {
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || 'https://turnfairy-hub.netlify.app';
    const res = await fetch(`${siteUrl}/.netlify/functions/penny-call-process-background`, {
      method: 'POST',
    });

    console.log(`Triggered background function, response status: ${res.status}`);

    return {
      statusCode: 202,
      body: JSON.stringify({
        message: 'Processing started in background. Check Notion and email in 1-2 minutes for results. Function logs for penny-call-process-background will show detailed progress.',
        triggeredAt: new Date().toISOString(),
      })
    };
  } catch (err) {
    console.error('penny-call-process trigger error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
