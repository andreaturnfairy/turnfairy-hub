// ─────────────────────────────────────────────────────────────
// penny-monday-email.js
// Netlify scheduled function — runs every Monday at 8:00 AM PT (16:00 UTC)
// Queries Notion for all items assigned to Pennylaine,
// builds a structured task email, and sends it to her.
// ─────────────────────────────────────────────────────────────

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ACTIONS = process.env.NOTION_DB_ACTIONS;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PENNY_EMAIL = process.env.PENNY_EMAIL || 'pennylaine@turnfairy.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'hub@turnfairy.com';
const PORTAL_URL = 'https://turnfairy-hub.netlify.app/penny';

async function notionQuery(dbId, filter) {
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ filter, sorts: [
      { property: 'Priority', direction: 'ascending' },
      { timestamp: 'created_time', direction: 'ascending' }
    ]})
  });
  if (!res.ok) throw new Error(`Notion: ${res.status}`);
  return res.json();
}

function getProp(props, name) {
  const p = props[name];
  if (!p) return '';
  if (p.type === 'title') return p.title?.[0]?.plain_text || '';
  if (p.type === 'rich_text') return p.rich_text?.[0]?.plain_text || '';
  if (p.type === 'select') return p.select?.name || '';
  if (p.type === 'date') return p.date?.start || '';
  return '';
}

exports.handler = async (event) => {
  const isScheduled = event.source === 'aws.events';
  const isManual = event.httpMethod === 'POST' || event.httpMethod === 'GET';
  if (!isScheduled && !isManual) return { statusCode: 405, body: 'Not allowed' };

  try {
    // ── 1. Query Penny's open tasks ───────────────────────────
    const data = await notionQuery(NOTION_DB_ACTIONS, {
      and: [
        { property: 'Owner', select: { equals: 'Pennylaine' } },
        { property: 'Status', select: { does_not_equal: 'Done' } },
        { property: 'Status', select: { does_not_equal: 'Archived' } },
      ]
    });

    const tasks = (data.results || []).map(p => ({
      task: getProp(p.properties, 'Action Item'),
      status: getProp(p.properties, 'Status'),
      priority: getProp(p.properties, 'Priority') || 'Normal',
      notes: getProp(p.properties, 'Notes'),
      due: getProp(p.properties, 'Due Date'),
      section: getProp(p.properties, 'Source Meeting') || '',
    })).filter(t => t.task);

    const urgent = tasks.filter(t => t.priority === 'Urgent');
    const high = tasks.filter(t => t.priority === 'High');
    const normal = tasks.filter(t => t.priority === 'Normal' || !t.priority);

    // ── 2. Build email ────────────────────────────────────────
    const today = new Date();
    const dateFmt = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    let body = `Hi Pennylaine,

Here are your open tasks for the week — ${dateFmt}.

Please reply to this email by end of day Wednesday with a status update on each item. Just copy this list and add a note next to each one.

`;

    if (urgent.length) {
      body += `🚨 URGENT — DO THESE TODAY\n`;
      urgent.forEach(t => {
        body += `  ☐ ${t.task}\n`;
        if (t.notes) body += `     Context: ${t.notes}\n`;
        if (t.due) body += `     Due: ${t.due}\n`;
        body += '\n';
      });
    }

    if (high.length) {
      body += `🟠 HIGH PRIORITY — THIS WEEK\n`;
      high.forEach(t => {
        body += `  ☐ ${t.task}\n`;
        if (t.notes) body += `     Context: ${t.notes}\n`;
        if (t.due) body += `     Due: ${t.due}\n`;
        body += '\n';
      });
    }

    if (normal.length) {
      body += `🟢 NORMAL — WHEN YOU CAN\n`;
      normal.forEach(t => {
        body += `  ☐ ${t.task}\n`;
        if (t.notes) body += `     Context: ${t.notes}\n`;
        body += '\n';
      });
    }

    if (!tasks.length) {
      body += `✅ No open tasks right now — you're all caught up!\n\n`;
    }

    body += `──────────────────────────────
View and update your tasks: ${PORTAL_URL}

A few reminders:
• Breezeway-first for all maintenance — no WhatsApp-only dispatches
• Get manager approval before offering any refund or compensation
• If something feels urgent and you can't reach anyone — call Mike first, then Lauren

Have a great week,
Turnfairy Hub`;

    const subject = `Your Turnfairy Tasks — ${dateFmt} (${tasks.length} open)`;

    // ── 3. Send via Resend ────────────────────────────────────
    let sent = false;
    if (RESEND_API_KEY) {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [PENNY_EMAIL],
          subject,
          text: body,
        })
      });
      if (!emailRes.ok) {
        const err = await emailRes.text();
        throw new Error(`Resend: ${emailRes.status} ${err}`);
      }
      sent = true;
      console.log(`Penny task email sent — ${tasks.length} tasks`);
    } else {
      console.log('No RESEND_API_KEY — returning email body only');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        subject,
        emailBody: body,
        taskCount: tasks.length,
        urgent: urgent.length,
        high: high.length,
        normal: normal.length,
        sent,
      })
    };

  } catch(err) {
    console.error('penny-monday-email error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
