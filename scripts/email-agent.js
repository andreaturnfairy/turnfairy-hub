// ─────────────────────────────────────────────────────────────
// email-agent.js — Turnfairy Hub Email Automation
// Usage: node scripts/email-agent.js --type <reminder|agenda|summary>
//
// Authenticates via Azure AD client credentials, queries Notion,
// builds HTML email, sends via Microsoft Graph API.
// ─────────────────────────────────────────────────────────────

const https = require('https');
const args = process.argv.slice(2);
const typeIdx = args.indexOf('--type');
const EMAIL_TYPE = typeIdx !== -1 ? args[typeIdx + 1] : null;

if (!EMAIL_TYPE || !['reminder', 'agenda', 'summary'].includes(EMAIL_TYPE)) {
  console.error('Usage: node scripts/email-agent.js --type <reminder|agenda|summary>');
  process.exit(1);
}

// ── Config from environment ───────────────────────────────────
const TENANT_ID      = process.env.AZURE_TENANT_ID;
const CLIENT_ID      = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET  = process.env.AZURE_CLIENT_SECRET;
const SENDER_EMAIL   = process.env.SENDER_EMAIL;
const NOTION_KEY     = process.env.NOTION_KEY;
const DB_ACTIONS     = process.env.NOTION_DB_ACTIONS;
const DB_DECISIONS   = process.env.NOTION_DB_DECISIONS;
const DB_AGENDA      = process.env.NOTION_DB_AGENDA;
const DB_SETTINGS    = process.env.NOTION_DB_SETTINGS;

const TEAM_EMAILS = [
  'greg@turnfairy.com',
  'andrea@turnfairy.com',
  'andrea@thatvacationvibe.com',
  'mike@turnfairy.com',
  'lauren@turnfairy.com',
];
const HUB_URL = 'https://turnfairy-hub.netlify.app';

// ── HTTP helpers ──────────────────────────────────────────────
function httpPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── 1. Get Azure AD token ─────────────────────────────────────
async function getToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  }).toString();

  const res = await httpPost(
    'login.microsoftonline.com',
    `/${TENANT_ID}/oauth2/v2.0/token`,
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  );

  if (!res.access_token) throw new Error('Token error: ' + JSON.stringify(res));
  console.log('✓ Got Azure token');
  return res.access_token;
}

// ── 2. Notion helpers ─────────────────────────────────────────
function notionQuery(dbId, filter) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(filter ? { filter, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] } : {});
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/databases/${dbId}/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_KEY}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function prop(props, name) {
  const p = props[name];
  if (!p) return '';
  if (p.type === 'title') return p.title?.[0]?.plain_text || '';
  if (p.type === 'rich_text') return p.rich_text?.[0]?.plain_text || '';
  if (p.type === 'select') return p.select?.name || '';
  if (p.type === 'date') return p.date?.start || '';
  if (p.type === 'number') return p.number || 0;
  return '';
}

// ── 3. Fetch all data from Notion ─────────────────────────────
async function fetchNotionData() {
  console.log('Fetching Notion data...');

  const [actRes, agendaRes, decRes, setRes] = await Promise.all([
    notionQuery(DB_ACTIONS, {
      and: [
        { property: 'Status', select: { does_not_equal: 'Done' } },
        { property: 'Status', select: { does_not_equal: 'Archived' } },
      ]
    }),
    notionQuery(DB_AGENDA, {
      property: 'Status', select: { does_not_equal: 'Done' }
    }),
    notionQuery(DB_DECISIONS, {}),
    notionQuery(DB_SETTINGS, {}),
  ]);

  const settings = {};
  (setRes.results || []).forEach(p => {
    const key = prop(p.properties, 'Key');
    const val = prop(p.properties, 'Value');
    if (key) settings[key] = val;
  });

  const actions = (actRes.results || []).map(p => ({
    task: prop(p.properties, 'Action Item'),
    owner: prop(p.properties, 'Owner'),
    status: prop(p.properties, 'Status'),
    priority: prop(p.properties, 'Priority') || 'Normal',
    section: prop(p.properties, 'Source Meeting') || '',
    notes: prop(p.properties, 'Notes'),
    due: prop(p.properties, 'Due Date'),
  })).filter(a => a.task);

  const agenda = (agendaRes.results || []).map(p => ({
    topic: prop(p.properties, 'Topic'),
    presenter: prop(p.properties, 'Presenter'),
    section: prop(p.properties, 'Section') || 'Other',
    duration: p.properties['Duration']?.number || 5,
    notes: prop(p.properties, 'Notes'),
  })).filter(a => a.topic);

  const today = new Date().toISOString().split('T')[0];
  const decisions = (decRes.results || []).map(p => ({
    text: prop(p.properties, 'Decision'),
    section: prop(p.properties, 'Section') || 'Other',
    decisionMaker: prop(p.properties, 'Made By'),
    date: prop(p.properties, 'Date'),
  })).filter(d => d.text && d.date && d.date.startsWith(today));

  console.log(`✓ Loaded: ${actions.length} actions, ${agenda.length} agenda items, ${decisions.length} today's decisions`);
  return { actions, agenda, decisions, settings };
}

// ── 4. Build HTML email ───────────────────────────────────────
function buildEmail(type, data) {
  const { actions, agenda, decisions, settings } = data;
  const meetingDate = settings.meetingDate || '';
  const meetingTime = settings.meetingTime || '08:00';
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowFmt = tomorrow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const todayFmt = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const urgent = actions.filter(a => a.priority === 'Urgent');
  const SECTION_ORDER = ['Operations', 'Owners', 'Team', 'Finance', 'Sales', 'Other'];

  const styles = `
    body { font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif; background: #F4F1FA; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(43,33,71,.1); }
    .header { background: linear-gradient(135deg, #2B2147, #472A66); padding: 24px 28px; }
    .header-brand { font-family: Georgia, serif; font-size: 22px; font-weight: 800; color: #fff; }
    .header-sub { font-size: 10px; color: #5DDFC8; text-transform: uppercase; letter-spacing: 2.5px; font-weight: 700; margin-top: 2px; }
    .header-date { font-size: 13px; color: rgba(255,255,255,.6); margin-top: 8px; }
    .body { padding: 24px 28px; }
    .hub-link { display: inline-block; background: #5DDFC8; color: #2B2147; padding: 10px 20px; border-radius: 8px; font-weight: 700; font-size: 13px; text-decoration: none; margin-bottom: 24px; }
    .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #9B8FB5; margin: 20px 0 8px; border-bottom: 1px solid #E2D9F3; padding-bottom: 6px; }
    .item { padding: 8px 12px; border-left: 3px solid #E2D9F3; margin-bottom: 6px; border-radius: 0 6px 6px 0; background: #F8F6FF; }
    .item.urgent { border-left-color: #dc2626; background: #FEF2F2; }
    .item.high { border-left-color: #B45309; background: #FFFBEB; }
    .item-title { font-size: 13px; font-weight: 600; color: #2B2147; }
    .item-meta { font-size: 11px; color: #9B8FB5; margin-top: 2px; }
    .owner-block { margin-bottom: 16px; }
    .owner-name { font-size: 13px; font-weight: 700; color: #603D91; margin-bottom: 6px; }
    .footer { background: #F8F6FF; padding: 16px 28px; border-top: 1px solid #E2D9F3; font-size: 11px; color: #9B8FB5; text-align: center; }
  `;

  let subject, bodyHtml, previewText;

  if (type === 'reminder') {
    subject = `Turnfairy Weekly Call Tomorrow — ${tomorrowFmt}`;
    previewText = `${urgent.length} urgent items · ${agenda.length} agenda topics · Call at ${meetingTime} NV`;

    let agendaHtml = '';
    SECTION_ORDER.forEach(sec => {
      const items = agenda.filter(i => i.section === sec);
      if (!items.length) return;
      agendaHtml += `<div class="section-title">${sec}</div>`;
      items.forEach(i => {
        agendaHtml += `<div class="item"><div class="item-title">${i.topic}</div><div class="item-meta">${i.presenter ? `👤 ${i.presenter} · ` : ''}${i.duration}min${i.notes ? ' · ' + i.notes.slice(0, 60) : ''}</div></div>`;
      });
    });

    let urgentHtml = '';
    if (urgent.length) {
      urgentHtml = `<div class="section-title">🚨 Urgent — needs attention before the call</div>`;
      urgent.forEach(a => {
        urgentHtml += `<div class="item urgent"><div class="item-title">${a.task}</div><div class="item-meta">👤 ${a.owner || 'Unassigned'}</div></div>`;
      });
    }

    bodyHtml = `
      <p style="font-size:15px;color:#2B2147;font-weight:600;margin:0 0 16px">Tomorrow is our weekly Turnfairy call.</p>
      <p style="font-size:13px;color:#5A4E72;margin:0 0 20px">${tomorrowFmt} · ${meetingTime} NV / ${parseInt(meetingTime) + 9}:00 Spain</p>
      <a href="${HUB_URL}" class="hub-link">Open Turnfairy Hub →</a>
      ${urgentHtml}
      ${agendaHtml || '<p style="font-size:13px;color:#9B8FB5">No dedicated agenda topics yet — add them in the Hub.</p>'}
    `;

  } else if (type === 'agenda') {
    subject = `Turnfairy Weekly Call Today — ${todayFmt}`;
    previewText = `${agenda.length} topics · ${actions.length} open items · ${meetingTime} NV`;

    let agendaHtml = '';
    SECTION_ORDER.forEach(sec => {
      const items = agenda.filter(i => i.section === sec);
      if (!items.length) return;
      agendaHtml += `<div class="section-title">${sec}</div>`;
      items.forEach(i => {
        agendaHtml += `<div class="item"><div class="item-title">${i.topic}</div><div class="item-meta">${i.presenter ? `👤 ${i.presenter} · ` : ''}${i.duration}min</div></div>`;
      });
    });

    bodyHtml = `
      <p style="font-size:15px;color:#2B2147;font-weight:600;margin:0 0 8px">Today's Turnfairy call</p>
      <p style="font-size:13px;color:#5A4E72;margin:0 0 20px">${todayFmt} · ${meetingTime} NV / ${parseInt(meetingTime) + 9}:00 Spain</p>
      <a href="${HUB_URL}" class="hub-link">Open Turnfairy Hub →</a>
      <div class="section-title">Today's Agenda</div>
      ${agendaHtml || '<p style="font-size:13px;color:#9B8FB5">No dedicated agenda topics — action item review is standing first item.</p>'}
      <div class="section-title">Open Items (${actions.length})</div>
      <p style="font-size:12px;color:#9B8FB5;margin:0 0 8px">Full list in the Hub. Urgent items below:</p>
      ${urgent.map(a => `<div class="item urgent"><div class="item-title">${a.task}</div><div class="item-meta">👤 ${a.owner || 'Unassigned'}</div></div>`).join('') || '<p style="font-size:13px;color:#16a34a">No urgent items ✓</p>'}
    `;

  } else if (type === 'summary') {
    subject = `Turnfairy Post-Call Summary — ${todayFmt}`;
    previewText = `${decisions.length} decisions · ${actions.length} open items`;

    let decisionsHtml = '';
    if (decisions.length) {
      decisionsHtml = `<div class="section-title">Today's Decisions (${decisions.length})</div>`;
      decisions.forEach(d => {
        decisionsHtml += `<div class="item"><div class="item-title">${d.text}</div><div class="item-meta">${d.decisionMaker ? `👤 ${d.decisionMaker}` : ''} ${d.section ? `· ${d.section}` : ''}</div></div>`;
      });
    }

    // Group open items by owner
    const owners = ['Greg', 'Andrea', 'Mike', 'Lauren', 'Pennylaine'];
    let actionsHtml = `<div class="section-title">Open Action Items by Owner</div>`;
    owners.forEach(owner => {
      const items = actions.filter(a => a.owner === owner);
      if (!items.length) return;
      actionsHtml += `<div class="owner-block"><div class="owner-name">👤 ${owner} (${items.length})</div>`;
      items.forEach(a => {
        const cls = a.priority === 'Urgent' ? 'urgent' : a.priority === 'High' ? 'high' : '';
        actionsHtml += `<div class="item ${cls}"><div class="item-title">${a.task}</div></div>`;
      });
      actionsHtml += '</div>';
    });

    bodyHtml = `
      <p style="font-size:15px;color:#2B2147;font-weight:600;margin:0 0 8px">Post-call summary</p>
      <p style="font-size:13px;color:#5A4E72;margin:0 0 20px">${todayFmt}</p>
      <a href="${HUB_URL}" class="hub-link">Open Turnfairy Hub →</a>
      ${decisionsHtml}
      ${actionsHtml}
    `;
  }

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title><style>${styles}</style></head><body>
    <div class="container">
      <div class="header">
        <div class="header-brand">Turnfairy</div>
        <div class="header-sub">Manager Hub</div>
        <div class="header-date">${subject}</div>
      </div>
      <div class="body">${bodyHtml}</div>
      <div class="footer">Turnfairy Manager Hub · <a href="${HUB_URL}" style="color:#5DDFC8">${HUB_URL}</a></div>
    </div>
  </body></html>`;

  return { subject, html, previewText };
}

// ── 5. Send via Microsoft Graph ───────────────────────────────
async function sendEmail(token, subject, html, recipients) {
  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: recipients.map(email => ({ emailAddress: { address: email } })),
  };

  const body = JSON.stringify({ message, saveToSentItems: true });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.microsoft.com',
      path: `/v1.0/users/${SENDER_EMAIL}/sendMail`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode === 202) {
          resolve({ success: true });
        } else {
          reject(new Error(`Send failed: ${res.statusCode} ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(`\nTurnfairy Email Agent — type: ${EMAIL_TYPE}`);
  console.log('─'.repeat(40));

  const token = await getToken();
  const data = await fetchNotionData();

  // For agenda type — check if meeting is today
  if (EMAIL_TYPE === 'agenda') {
    const today = new Date().toISOString().split('T')[0];
    if (data.settings.meetingDate && data.settings.meetingDate !== today) {
      console.log(`Meeting date (${data.settings.meetingDate}) is not today (${today}) — skipping.`);
      process.exit(0);
    }
  }

  const { subject, html } = buildEmail(EMAIL_TYPE, data);
  console.log(`Subject: ${subject}`);
  console.log(`Recipients: ${TEAM_EMAILS.join(', ')}`);

  await sendEmail(token, subject, html, TEAM_EMAILS);
  console.log(`✓ Email sent successfully`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
