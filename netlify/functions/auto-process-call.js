// ─────────────────────────────────────────────────────────────
// auto-process-call.js
// Netlify scheduled function — runs every Sunday at 11:00 AM PT
// Finds the most recent Fathom call, analyzes it with Claude,
// and pushes action items + decisions to Notion automatically.
// ─────────────────────────────────────────────────────────────

const FATHOM_API_KEY = process.env.FATHOM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ACTIONS = process.env.NOTION_DB_ACTIONS;
const NOTION_DB_DECISIONS = process.env.NOTION_DB_DECISIONS;

// ── Helpers ──────────────────────────────────────────────────
async function fathomGet(path) {
  const res = await fetch(`https://api.fathom.ai/v1${path}`, {
    headers: { 'Authorization': `Bearer ${FATHOM_API_KEY}` }
  });
  if (!res.ok) throw new Error(`Fathom ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function notionCreate(dbId, props) {
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ parent: { database_id: dbId }, properties: props })
  });
  if (!res.ok) throw new Error(`Notion create: ${res.status} ${await res.text()}`);
  return res.json();
}

function ttl(text) { return { title: [{ text: { content: String(text || '').slice(0, 2000) } }] }; }
function sel(val) { return val ? { select: { name: String(val) } } : undefined; }
function txt(val) { return val ? { rich_text: [{ text: { content: String(val).slice(0, 2000) } }] } : undefined; }
function dt(val) { return val ? { date: { start: val } } : undefined; }

function classifySection(text) {
  const t = text || '';
  if (/invoice|payment|fee|insurance|pricing|revenue|cost|billing|stripe|zelle|quickbooks|p&l|profit/i.test(t)) return 'Finance';
  if (/lead|pipeline|prospect|new property|new client|josephine|priscilla|ivan|biz dev/i.test(t)) return 'Sales';
  if (/owner|kathy|rachel|stacy|roberto|jennifer|nick\b|proposal|onboard/i.test(t)) return 'Owners';
  if (/penny|pennylaine|sop|\bva\b|hire|interview|staff|training|policy/i.test(t)) return 'Team';
  if (/clean|linen|breezeway|hostaway|airbnb|vrbo|vendor|lock|mainten|repair|inspect|cleaner|ronaldo/i.test(t)) return 'Operations';
  return 'Other';
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async (event) => {
  const isScheduled = event.source === 'aws.events' || event.triggerSource === 'scheduled';
  const isManual = event.httpMethod === 'POST';

  if (!isScheduled && !isManual) {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    console.log('auto-process-call: starting');

    // ── 1. Find most recent Fathom call from last 48 hours ────
    const calls = await fathomGet('/calls?limit=10');
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const recent = (calls.data || []).find(c => c.created_at > cutoff);

    if (!recent) {
      console.log('No recent Turnfairy call found');
      return { statusCode: 200, body: JSON.stringify({ message: 'No recent call found' }) };
    }

    console.log('Found call:', recent.title, recent.id);

    // ── 2. Get transcript ─────────────────────────────────────
    const transcriptData = await fathomGet(`/calls/${recent.id}/transcript`);
    const transcript = (transcriptData.transcript || [])
      .map(s => `${s.speaker}: ${s.text}`)
      .join('\n');

    if (!transcript || transcript.length < 100) {
      return { statusCode: 200, body: JSON.stringify({ message: 'Transcript too short or not ready' }) };
    }

    // ── 3. Analyze with Claude ────────────────────────────────
    const prompt = `You are analyzing a Turnfairy STR co-hosting company weekly management call transcript.

Extract ALL action items and decisions. Be thorough — capture everything, even small tasks.

SECTION RULES:
- Operations: cleaning, maintenance, vendors, Breezeway, Hostaway, lock codes, Ronaldo, linen, check-in/out, cleaners
- Owners: owner names (Rachel, Kathy, Roberto, Nick, Stacey, Josephine etc), property decisions, owner invoices, proposals
- Team: Penny/VA, SOPs, staff, hiring, internal process, Andrea/Greg/Mike/Lauren roles
- Finance: invoices, payments, fees, insurance, QuickBooks, pricing, revenue, P&L, Stripe, Zelle
- Sales: leads, pipeline, new properties, proposals, business development, prospects
- Other: anything else

PEOPLE: Greg (co-founder, finance/bizdev), Andrea (co-founder, automation/platform), Mike (operations manager, Reno), Lauren (guest/owner satisfaction, Reno), Penny/Pennylaine (VA, remote).

Return ONLY valid JSON, no other text:
{
  "actionItems": [
    { "task": "specific actionable task", "owner": "first name only", "section": "section", "priority": "Urgent|High|Normal", "notes": "context if needed" }
  ],
  "decisions": [
    { "text": "what was decided", "section": "section", "decisionMaker": "first name or empty string", "context": "why this was decided" }
  ]
}

TRANSCRIPT:
${transcript.slice(0, 30000)}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) throw new Error(`Claude API: ${claudeRes.status}`);
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';

    // Parse JSON — strip any markdown fences
    const jsonStr = rawText.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    const today = new Date().toISOString().split('T')[0];
    const sourceMeeting = `Weekly Call — ${today}`;

    // ── 4. Push action items to Notion ────────────────────────
    let actionCount = 0;
    for (const item of (parsed.actionItems || [])) {
      const section = item.section && item.section !== 'Other' ? item.section : classifySection(item.task);
      await notionCreate(NOTION_DB_ACTIONS, {
        'Action Item': ttl(item.task),
        'Owner': sel(item.owner),
        'Status': sel('In Progress'),
        'Priority': sel(item.priority || 'Normal'),
        'Notes': txt(item.notes),
        'Source Meeting': txt(sourceMeeting),
      });
      actionCount++;
    }

    // ── 5. Push decisions to Notion ───────────────────────────
    let decisionCount = 0;
    for (const d of (parsed.decisions || [])) {
      const section = d.section && d.section !== 'Other' ? d.section : classifySection(d.text);
      await notionCreate(NOTION_DB_DECISIONS, {
        'Decision': ttl(d.text),
        'Section': sel(section),
        'Made By': sel(d.decisionMaker || ''),
        'Context': txt(d.context),
        'Source Meeting': txt(sourceMeeting),
        'Date': dt(today),
        'From Transcript': { checkbox: true },
      });
      decisionCount++;
    }

    console.log(`Done: ${actionCount} actions, ${decisionCount} decisions`);

    // ── 6. Send post-call summary email via Resend ────────────
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.FROM_EMAIL || 'hub@turnfairy.com';
    const TEAM_EMAILS = (process.env.TEAM_EMAILS || 'greg@turnfairy.com,andrea@turnfairy.com,mike@turnfairy.com,lauren@turnfairy.com').split(',');
    const HUB_URL = 'https://turnfairy-hub.netlify.app';

    let emailSent = false;
    if (RESEND_KEY && (actionCount > 0 || decisionCount > 0)) {
      try {
        // Fetch open action items from Notion for the summary
        const actRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ACTIONS}/query`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${NOTION_TOKEN}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify({
            filter: { and: [
              { property: 'Status', select: { does_not_equal: 'Done' } },
              { property: 'Status', select: { does_not_equal: 'Archived' } },
            ]},
            sorts: [{ timestamp: 'created_time', direction: 'ascending' }]
          })
        });
        const actData = await actRes.json();
        const openItems = (actData.results || []).map(p => ({
          task: p.properties['Action Item']?.title?.[0]?.plain_text || '',
          owner: p.properties['Owner']?.select?.name || 'Unassigned',
          priority: p.properties['Priority']?.select?.name || 'Normal',
        })).filter(a => a.task);

        // Build email body
        const callDateFmt = new Date(today + 'T12:00:00').toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric'
        });

        let body = `Hi team,\n\nPost-call summary from the Turnfairy call on ${callDateFmt}.\n\n`;

        body += `TRANSCRIPT PROCESSED\n`;
        body += `  • ${actionCount} new action items added to Notion\n`;
        body += `  • ${decisionCount} decisions logged\n\n`;

        if (openItems.length) {
          const owners = [...new Set(openItems.map(a => a.owner))].sort();
          body += `OPEN ACTION ITEMS BY OWNER (${openItems.length} total)\n`;
          owners.forEach(owner => {
            const items = openItems.filter(a => a.owner === owner);
            body += `\n${owner} (${items.length}):\n`;
            items.forEach(a => {
              const flag = a.priority === 'Urgent' ? ' 🚨' : '';
              body += `  ☐ ${a.task}${flag}\n`;
            });
          });
          body += '\n';
        }

        body += `──────────────────────────────\nView and update in the Hub: ${HUB_URL}`;

        const subject = `Turnfairy Post-Call Summary — ${callDateFmt}`;

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM_EMAIL, to: TEAM_EMAILS, subject, text: body })
        });

        if (emailRes.ok) {
          emailSent = true;
          console.log('✓ Post-call summary email sent');
        } else {
          console.error('Email send failed:', await emailRes.text());
        }
      } catch (emailErr) {
        console.error('Email error:', emailErr.message);
      }
    } else if (!RESEND_KEY) {
      console.log('No RESEND_API_KEY — skipping email');
    } else {
      console.log('No new items processed — skipping email');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        call: recent.title,
        actionItems: actionCount,
        decisions: decisionCount,
        emailSent,
      })
    };

  } catch (err) {
    console.error('auto-process-call error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
