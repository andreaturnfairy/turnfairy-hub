// ─────────────────────────────────────────────────────────────
// saturday-briefing.js
// Netlify scheduled function — runs every Saturday at 9:00 AM PT (17:00 UTC)
// Queries Notion for open action items, builds a pre-call briefing email,
// and sends it to the team via the configured email service.
// ─────────────────────────────────────────────────────────────

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ACTIONS = process.env.NOTION_DB_ACTIONS;
const NOTION_DB_AGENDA = process.env.NOTION_DB_AGENDA;
const NOTION_DB_SETTINGS = process.env.NOTION_DB_SETTINGS;
const FROM_EMAIL = process.env.FROM_EMAIL || 'hub@turnfairy.com';
const TEAM_EMAILS = (process.env.TEAM_EMAILS || 'greg@turnfairy.com,andrea@turnfairy.com,mike@turnfairy.com,lauren@turnfairy.com').split(',');
const { buildHtmlEmail } = require('./email-template');

async function notionQuery(dbId, filter) {
  const body = filter ? { filter, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] } : {};
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Notion query ${dbId}: ${res.status}`);
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
    // ── 1. Query open action items ────────────────────────────
    const actionsData = await notionQuery(NOTION_DB_ACTIONS, {
      and: [
        { property: 'Status', select: { does_not_equal: 'Done' } },
        { property: 'Status', select: { does_not_equal: 'Archived' } }
      ]
    });

    const items = (actionsData.results || []).map(p => ({
      task: getProp(p.properties, 'Action Item'),
      owner: getProp(p.properties, 'Owner'),
      status: getProp(p.properties, 'Status'),
      priority: getProp(p.properties, 'Priority'),
      due: getProp(p.properties, 'Due Date'),
    })).filter(i => i.task);

    // ── 2. Query agenda items for tomorrow's call ─────────────
    const agendaData = await notionQuery(NOTION_DB_AGENDA, {
      property: 'Status', select: { does_not_equal: 'Done' }
    });

    const agendaItems = (agendaData.results || []).map(p => ({
      topic: getProp(p.properties, 'Topic'),
      presenter: getProp(p.properties, 'Presenter'),
      section: getProp(p.properties, 'Section'),
      duration: p.properties['Duration']?.number || 5,
    })).filter(i => i.topic);

    // ── 3. Get the real meeting date from Notion Settings ─────
    // Previously this blindly computed "tomorrow" as today+1, which meant
    // the email claimed a call was happening every single day it ran,
    // regardless of whether one was actually scheduled. Now it reads the
    // real meetingDate set by auto-process-call.js and only sends if that
    // date is genuinely tomorrow (server-local).
    if (!NOTION_DB_SETTINGS) {
      console.log('NOTION_DB_SETTINGS not configured — cannot verify meeting date, skipping send');
      return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'NOTION_DB_SETTINGS not configured' }) };
    }

    const settingsRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_SETTINGS}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { property: 'Key', title: { equals: 'meetingDate' } } })
    });
    const settingsData = await settingsRes.json();
    const meetingDateRow = (settingsData.results || [])[0];
    const meetingDateValue = meetingDateRow?.properties?.['Value']?.rich_text?.[0]?.plain_text;

    if (!meetingDateValue) {
      console.log('No meetingDate found in Settings — skipping send');
      return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'No meetingDate set in Settings' }) };
    }

    const tomorrowCheck = new Date();
    tomorrowCheck.setDate(tomorrowCheck.getDate() + 1);
    const tomorrowStr = tomorrowCheck.toISOString().split('T')[0];

    if (meetingDateValue !== tomorrowStr) {
      console.log(`meetingDate (${meetingDateValue}) is not tomorrow (${tomorrowStr}) — skipping send. No call scheduled tomorrow.`);
      return {
        statusCode: 200,
        body: JSON.stringify({ skipped: true, reason: 'No call scheduled tomorrow', meetingDate: meetingDateValue, tomorrow: tomorrowStr })
      };
    }

    const tomorrow = new Date(meetingDateValue + 'T12:00:00');
    const dateFmt = tomorrow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const nvTime = '8:00 AM NV · 5:00 PM Spain';

    // ── 4. Group items by owner ───────────────────────────────
    const owners = ['Greg', 'Andrea', 'Mike', 'Lauren', 'Pennylaine'];
    const urgentItems = items.filter(i => i.priority === 'Urgent');
    const byOwner = owners.map(owner => ({
      owner,
      items: items.filter(i => i.owner === owner)
    })).filter(o => o.items.length > 0);

    // ── 5. Build email body ───────────────────────────────────
    let body = `Hi team,

Our weekly Turnfairy call is ${dateFmt} at ${nvTime}.

`;

    // Urgent items first
    if (urgentItems.length) {
      body += `🚨 URGENT — NEEDS ATTENTION BEFORE THE CALL\n`;
      urgentItems.forEach(i => { body += `  • ${i.task} (${i.owner})\n`; });
      body += '\n';
    }

    // Agenda topics
    if (agendaItems.length) {
      body += `📋 AGENDA TOPICS\n`;
      const sections = ['Operations', 'Owners', 'Team', 'Finance', 'Sales', 'Other'];
      sections.forEach(sec => {
        const secItems = agendaItems.filter(i => i.section === sec);
        if (secItems.length) {
          body += `\n${sec.toUpperCase()}\n`;
          secItems.forEach(i => { body += `  • ${i.topic}${i.presenter ? ` (${i.presenter})` : ''} — ${i.duration}min\n`; });
        }
      });
      body += '\n';
    }

    // Open items by owner
    body += `✅ OPEN ACTION ITEMS BY OWNER\n`;
    byOwner.forEach(({ owner, items: ownerItems }) => {
      body += `\n${owner} (${ownerItems.length} open):\n`;
      ownerItems.forEach(i => {
        const urgentFlag = i.priority === 'Urgent' ? ' 🚨' : '';
        body += `  ☐ ${i.task}${urgentFlag}\n`;
      });
    });

    body += `\n──────────────────────────────
Update your items before the call.

See you then,
Turnfairy Hub`;

    const subject = `Turnfairy Weekly Call — ${dateFmt}`;

    // ── 6. Send via Resend (or log if no key) ─────────────────
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const htmlBody = buildHtmlEmail(body);
    if (RESEND_KEY) {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: TEAM_EMAILS,
          subject,
          text: body,
          html: htmlBody,
        })
      });
      if (!emailRes.ok) {
        const err = await emailRes.text();
        throw new Error(`Resend: ${emailRes.status} ${err}`);
      }
      console.log('Email sent via Resend');
    } else {
      // No email key — return the email body for manual review
      console.log('No RESEND_API_KEY — returning email body');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        subject,
        emailBody: body,
        stats: { openItems: items.length, urgentItems: urgentItems.length, agendaTopics: agendaItems.length },
        sent: !!RESEND_KEY,
      })
    };

  } catch (err) {
    console.error('saturday-briefing error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};



