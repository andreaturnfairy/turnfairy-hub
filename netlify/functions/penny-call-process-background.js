// ─────────────────────────────────────────────────────────────
// penny-call-process-background.js
// Netlify BACKGROUND function — does the actual work for the
// Penny monthly call: finds the Fathom call, analyzes the
// transcript with Claude, pushes items to Notion, sends summary.
//
// Background because the Claude analysis step alone can take
// 50-60+ seconds, exceeding Netlify's hard 60s ceiling for regular
// functions (not configurable via netlify.toml or plan tier).
// See auto-process-call-background.js for full explanation —
// same root cause, same fix, same pattern.
//
// Invoked by penny-call-process.js (the thin trigger), not called
// directly.
// ─────────────────────────────────────────────────────────────

const FATHOM_API_KEY = process.env.FATHOM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ACTIONS = process.env.NOTION_DB_ACTIONS;
const NOTION_DB_DECISIONS = process.env.NOTION_DB_DECISIONS;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'hub@turnfairy.com';
const PENNY_EMAIL = process.env.PENNY_EMAIL || 'vapennylaine@gmail.com';
const TEAM_EMAILS = (process.env.TEAM_EMAILS || 'greg@turnfairy.com,andrea@turnfairy.com,mike@turnfairy.com,lauren@turnfairy.com').split(',');
const HUB_URL = 'https://turnfairy-hub.netlify.app';
const PENNY_PORTAL_URL = 'https://turnfairy-hub.netlify.app/penny';
const { htmlShell, sectionHeader, subHeader, decisionLine, actionLine, bulletList, paragraph, bold } = require('./email-template');

// ── Helpers ──────────────────────────────────────────────────
// Fathom's real API base is /external/v1 — see note in
// auto-process-call.js for full explanation of the fix.
async function fathomGet(path) {
  const res = await fetch(`https://api.fathom.ai/external/v1${path}`, {
    headers: { 'X-Api-Key': FATHOM_API_KEY }
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

// Similarity check — same logic as auto-process-call.js, used for
// duplicate prevention against existing open items
function isSimilar(a, b) {
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
  return (overlap / Math.min(wordsA.size, wordsB.size)) >= 0.6;
}

// ── Main handler ─────────────────────────────────────────────
// Background functions don't have a real caller waiting on the
// response — no need to validate event.httpMethod.
exports.handler = async (event) => {
  try {
    console.log('penny-call-process-background: starting');

    // ── 1. Find most recent Penny call from last 48 hours ─────
    // Matches Fathom meeting titles like "Pennylaine & Turnfairy"
    const cutoffIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const meetingsRes = await fathomGet(`/meetings?created_after=${encodeURIComponent(cutoffIso)}&include_transcript=true`);
    const meetings = meetingsRes.items || meetingsRes.data || [];
    const recent = meetings.find(m => /penny|pennylaine/i.test(m.title || ''));

    if (!recent) {
      console.log('No recent Penny call found');
      return { statusCode: 200, body: JSON.stringify({ message: 'No recent Penny call found' }) };
    }

    console.log('Found call:', recent.title, recent.recording_id);

    // ── 2. Build transcript from the meeting's transcript field ──
    const transcript = (recent.transcript || [])
      .map(s => `${s.speaker}: ${s.text}`)
      .join('\n');

    if (!transcript || transcript.length < 100) {
      return { statusCode: 200, body: JSON.stringify({ message: 'Transcript too short or not ready' }) };
    }

    // ── 3. Analyze with Claude ────────────────────────────────
    const prompt = `You are analyzing a Turnfairy STR co-hosting company monthly call between management (Mike, Lauren, and sometimes Greg/Andrea) and Pennylaine ("Penny"), their remote VA.

This call is specifically about Penny's tasks, operations, and dashboard. Extract ALL action items and decisions discussed. Be thorough — capture everything, even small tasks. Most action items will be assigned TO Penny, but some may be assigned to managers (e.g. "Mike to follow up with Penny on X").

SECTION RULES:
- Operations: cleaning, maintenance, vendors, Breezeway, Hostaway, lock codes, Ronaldo, linen, check-in/out, cleaners
- Owners: owner names (Rachel, Kathy, Roberto, Nick, Stacey, Josephine etc), property decisions, owner invoices
- Team: Penny's own workflow, SOPs, dashboard/portal feedback, training
- Finance: invoices, payments, fees
- Other: anything else

PEOPLE: Greg, Andrea, Mike, Lauren (managers), Pennylaine (VA, the call's primary subject — she is sometimes called "Penny" in conversation, but you must always write her name as "Pennylaine" in the owner field, never "Penny").

Return ONLY valid JSON, no other text:
{
  "actionItems": [
    { "task": "specific actionable task", "owner": "Pennylaine, or Mike/Lauren/Greg/Andrea first name", "section": "section", "priority": "Urgent|High|Normal", "notes": "context if needed" }
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

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error('Claude API error body:', errBody);
      throw new Error(`Claude API: ${claudeRes.status} — ${errBody.slice(0, 500)}`);
    }
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';
    const jsonStr = rawText.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    // Use the actual call date from Fathom, not server "today"
    // Date field name on the /meetings response wasn't confirmed in the
    // API spec lookup — try the most likely candidates and log clearly
    // if none are found, rather than silently failing or guessing wrong.
    const rawDate = recent.created_at || recent.scheduled_start_time || recent.start_time || recent.recorded_at;
    if (!rawDate) {
      console.error('WARNING: could not find a date field on the meeting object. Keys present:', Object.keys(recent).join(', '));
    }
    const callDate = (rawDate || new Date().toISOString()).split('T')[0];
    const sourceMeeting = `Penny Call — ${callDate}`;

    // ── 4. Fetch existing open items for duplicate check ──────
    const existingActRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ACTIONS}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        filter: { and: [
          { property: 'Status', select: { does_not_equal: 'Done' } },
          { property: 'Status', select: { does_not_equal: 'Archived' } },
        ]},
        page_size: 100
      })
    });
    const existingActData = await existingActRes.json();
    const existingTasks = (existingActData.results || []).map(p =>
      (p.properties['Action Item']?.title?.[0]?.plain_text || '').toLowerCase().trim()
    ).filter(Boolean);

    const existingDecRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_DECISIONS}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { property: 'Date', date: { equals: callDate } }, page_size: 100 })
    });
    const existingDecData = await existingDecRes.json();
    const existingDecisions = (existingDecData.results || []).map(p =>
      (p.properties['Decision']?.title?.[0]?.plain_text || '').toLowerCase().trim()
    ).filter(Boolean);

    function isDuplicateTask(task) { return existingTasks.some(e => isSimilar(task, e)); }
    function isDuplicateDecision(text) { return existingDecisions.some(e => isSimilar(text, e)); }

    // ── 5. Push action items to Notion ────────────────────────
    let actionCount = 0, actionSkipped = 0;
    for (const item of (parsed.actionItems || [])) {
      if (isDuplicateTask(item.task)) { actionSkipped++; continue; }
      await notionCreate(NOTION_DB_ACTIONS, {
        'Action Item': ttl(item.task),
        'Owner': sel(item.owner),
        'Status': sel('In Progress'),
        'Priority': sel(item.priority || 'Normal'),
        'Notes': txt(item.notes),
        'Source Meeting': txt(sourceMeeting),
      });
      actionCount++;
      existingTasks.push(item.task.toLowerCase().trim());
    }
    console.log(`Actions: ${actionCount} created, ${actionSkipped} skipped as duplicates`);

    // ── 6. Push decisions to Notion ───────────────────────────
    let decisionCount = 0, decisionSkipped = 0;
    for (const d of (parsed.decisions || [])) {
      if (isDuplicateDecision(d.text)) { decisionSkipped++; continue; }
      await notionCreate(NOTION_DB_DECISIONS, {
        'Decision': ttl(d.text),
        'Section': sel(d.section || 'Team'),
        'Made By': sel(d.decisionMaker || ''),
        'Context': txt(d.context),
        'Source Meeting': txt(sourceMeeting),
        'Date': dt(callDate),
        'From Transcript': { checkbox: true },
      });
      decisionCount++;
      existingDecisions.push(d.text.toLowerCase().trim());
    }
    console.log(`Decisions: ${decisionCount} created, ${decisionSkipped} skipped as duplicates`);

    // ── 7. Send post-call summary email ───────────────────────
    let emailSent = false;
    if (RESEND_API_KEY && (actionCount > 0 || decisionCount > 0)) {
      try {
        const callDateFmt = new Date(callDate + 'T12:00:00').toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric'
        });

        // Fetch Penny's current full open task list for the summary
        const pennyActRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ACTIONS}/query`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
          body: JSON.stringify({
            filter: { and: [
              { property: 'Owner', select: { equals: 'Pennylaine' } },
              { property: 'Status', select: { does_not_equal: 'Done' } },
              { property: 'Status', select: { does_not_equal: 'Archived' } },
            ]}
          })
        });
        const pennyActData = await pennyActRes.json();
        const pennyOpenItems = (pennyActData.results || []).map(p => ({
          task: p.properties['Action Item']?.title?.[0]?.plain_text || '',
          priority: p.properties['Priority']?.select?.name || 'Normal',
        })).filter(a => a.task);

        // New items from this call, grouped by owner (Penny vs managers)
        const newActRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ACTIONS}/query`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
          body: JSON.stringify({ filter: { property: 'Source Meeting', rich_text: { contains: callDate } } })
        });
        const newActData = await newActRes.json();
        const newItems = (newActData.results || []).map(p => ({
          task: p.properties['Action Item']?.title?.[0]?.plain_text || '',
          owner: p.properties['Owner']?.select?.name || 'Unassigned',
          priority: p.properties['Priority']?.select?.name || 'Normal',
        })).filter(a => a.task);

        const decRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_DECISIONS}/query`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
          body: JSON.stringify({ filter: { property: 'Date', date: { equals: callDate } } })
        });
        const decData = await decRes.json();
        const callDecisions = (decData.results || []).map(p => ({
          text: p.properties['Decision']?.title?.[0]?.plain_text || '',
          decisionMaker: p.properties['Made By']?.select?.name || '',
        })).filter(d => d.text);

        let html = paragraph(
          `Hi team,<br><br>` +
          bold(`Here is the summary from the Penny call on **${callDateFmt}**.`)
        );

        html += paragraph(
          `<span style="color:#6B5B8A; font-size:13px;">${actionCount} new action items · ${decisionCount} decisions logged</span>`
        );

        // New action items first — operational content people re-scan.
        if (newItems.length) {
          html += sectionHeader('New Action Items From This Call');
          const owners = [...new Set(newItems.map(a => a.owner))].sort();
          owners.forEach(owner => {
            html += subHeader(owner);
            html += bulletList(newItems.filter(a => a.owner === owner).map(a => actionLine({ text: a.task, priority: a.priority })));
          });
        }

        // Penny's full open list — single-person list, no owner sub-grouping needed.
        if (pennyOpenItems.length) {
          html += sectionHeader(`Pennylaine's Open Items (${pennyOpenItems.length})`);
          html += bulletList(pennyOpenItems.map(a => actionLine({ text: a.task, priority: a.priority })));
        }

        // Decisions last — closing record, not something to act on.
        if (callDecisions.length) {
          html += sectionHeader('Decisions Made');
          html += bulletList(callDecisions.map(d => decisionLine({ text: d.text, decisionMaker: d.decisionMaker })));
        }

        const subject = `Penny Call Summary — ${callDateFmt}`;

        const htmlBody = htmlShell(html, { linkLabel: "Penny's Dashboard", linkUrl: PENNY_PORTAL_URL });
        const plainTextFallback = html.replace(/<[^>]+>/g, '').replace(/\n\s*\n/g, '\n').trim();

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [...TEAM_EMAILS, PENNY_EMAIL],
            subject,
            text: plainTextFallback,
            html: htmlBody
          })
        });

        if (emailRes.ok) {
          emailSent = true;
          console.log('✓ Penny call summary email sent');
        } else {
          console.error('Email send failed:', await emailRes.text());
        }
      } catch (emailErr) {
        console.error('Penny call email error:', emailErr.message);
      }
    } else if (!RESEND_API_KEY) {
      console.log('No RESEND_API_KEY — skipping email');
    } else {
      console.log('No new items processed — skipping summary email');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        call: recent.title,
        callDate,
        actionItems: actionCount,
        decisions: decisionCount,
        emailSent,
      })
    };

  } catch (err) {
    console.error('penny-call-process-background error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};






