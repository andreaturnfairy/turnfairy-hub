// ─────────────────────────────────────────────────────────────
// auto-process-call.js
// Thin TRIGGER function — invoked by the Sunday 11am PT cron
// schedule, or manually via POST/GET. Does no real work itself;
// it just kicks off auto-process-call-background.js and returns
// immediately, so callers (including the cron trigger itself)
// never wait on or time out from the slow Claude analysis step.
//
// Netlify auto-discovers any file ending in "-background.js" in
// this directory and gives it up to 15 minutes to run, completely
// independent of this function's own (much shorter) lifetime.
// ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const isScheduled = event.source === 'aws.events' || event.triggerSource === 'scheduled';
  const isManual = event.httpMethod === 'POST' || event.httpMethod === 'GET';

  if (!isScheduled && !isManual) {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    // Invoke the background function by hitting its own endpoint.
    // Netlify runs background functions async — this call returns
    // almost instantly (202) without waiting for the work to finish.
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || 'https://turnfairy-hub.netlify.app';
    const res = await fetch(`${siteUrl}/.netlify/functions/auto-process-call-background`, {
      method: 'POST',
    });

    console.log(`Triggered background function, response status: ${res.status}`);

    return {
      statusCode: 202,
      body: JSON.stringify({
        message: 'Processing started in background. Check Notion and your email in 1-2 minutes for results. Function logs for auto-process-call-background will show detailed progress.',
        triggeredAt: new Date().toISOString(),
      })
    };
  } catch (err) {
    console.error('auto-process-call trigger error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
