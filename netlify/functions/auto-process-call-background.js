// ─────────────────────────────────────────────────────────────
// auto-process-call-background.js
// Netlify BACKGROUND function — does the actual work of finding
// the most recent Fathom call, analyzing it with Claude, pushing
// action items + decisions to Notion, advancing the meeting date,
// marking discussed agenda items Done, and sending the post-call
// summary email.
//
// Why background: the Claude transcript-analysis call alone often
// takes 50-60+ seconds for a full weekly call transcript, which
// exceeds Netlify's hard 60-second ceiling for regular (synchronous)
// functions — a ceiling that does NOT change with plan tier or
// netlify.toml config, unlike the per-function timeout setting.
// Background functions get up to 15 minutes and run independently
// of the HTTP request that triggered them.
//
// This file is invoked by auto-process-call.js (the thin trigger),
// not called directly. Netlify recognizes any file ending in
// "-background.js" in netlify/functions and runs it as a true
// async background function automatically — no extra config needed.
//
// This same background-function pattern should be used for every
// future AI agent (Aria, Rex, Maya, etc.) that calls Claude for
// analysis — it's the template, not a one-off fix.
// ─────────────────────────────────────────────────────────────

const FATHOM_API_KEY = process.env.FATHOM_API_KEY;
const NOTION_DB_PIPELINE = process.env.NOTION_DB_PIPELINE;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ACTIONS = process.env.NOTION_DB_ACTIONS;
const NOTION_DB_DECISIONS = process.env.NOTION_DB_DECISIONS;
const { buildHtmlEmail } = require('./email-template');

// ── Helpers ──────────────────────────────────────────────────
// Fathom's real API base is /external/v1 — NOT /v1. The previous
// version called /v1/calls and /v1/calls/{id}/transcript, neither
// of which exist on Fathom's side (confirmed via their official
// OpenAPI spec at developers.fathom.ai). Correct endpoints are
// /meetings (list, with include_transcript/include_summary/
// include_action_items as boolean query params) and
// /recordings/{recording_id}/transcript for standalone fetches.
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
// Background functions don't have a real caller waiting on the
// response — Netlify invokes this asynchronously and discards
// whatever this returns. No need to validate event.httpMethod.
exports.handler = async (event) => {
  try {
    console.log('auto-process-call-background: starting');

    // ── 1. Find most recent Turnfairy call from last 48 hours ─
    // Single call to /meetings with include_transcript=true avoids
    // a second round-trip to fetch the transcript separately.
    const cutoffIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const meetingsRes = await fathomGet(`/meetings?created_after=${encodeURIComponent(cutoffIso)}&include_transcript=true`);
    const meetings = meetingsRes.items || meetingsRes.data || [];
    const recent = meetings.find(m => !/penny|pennylaine/i.test(m.title || ''));

    if (!recent) {
      console.log('No recent Turnfairy call found');
      return { statusCode: 200, body: JSON.stringify({ message: 'No recent call found' }) };
    }

    console.log('Found call:', recent.title, recent.recording_id);

    // ── 2. Build transcript text from the meeting's transcript field ──
    const transcript = (recent.transcript || [])
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

PEOPLE: Greg (co-founder, finance/bizdev), Andrea (co-founder, automation/platform), Mike (operations manager, Reno), Lauren (guest/owner satisfaction, Reno), Pennylaine (VA, remote — she is sometimes called "Penny" in conversation, but you must always write her name as "Pennylaine" in the owner field, never "Penny").

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

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error('Claude API error body:', errBody);
      throw new Error(`Claude API: ${claudeRes.status} — ${errBody.slice(0, 500)}`);
    }
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';

    // Parse JSON — strip any markdown fences
    const jsonStr = rawText.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    // Use the actual call date from Fathom, not server "today" —
    // ensures correctness even if this function runs a day late
    // Date field name on the /meetings response wasn't confirmed in the
    // API spec lookup — try the most likely candidates and log clearly
    // if none are found, rather than silently failing or guessing wrong.
    const rawDate = recent.created_at || recent.scheduled_start_time || recent.start_time || recent.recorded_at;
    if (!rawDate) {
      console.error('WARNING: could not find a date field on the meeting object. Keys present:', Object.keys(recent).join(', '));
    }
    const callDate = (rawDate || new Date().toISOString()).split('T')[0];
    const today = new Date().toISOString().split('T')[0]; // still used for "Last Contact" etc. on pipeline updates
    const sourceMeeting = `Weekly Call — ${callDate}`;

    // ── 4. Fetch existing open action items for duplicate check ─
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

    // Fetch existing decisions for duplicate check
    const existingDecRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_DECISIONS}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { property: 'Date', date: { equals: callDate } }, page_size: 100 })
    });
    const existingDecData = await existingDecRes.json();
    const existingDecisions = (existingDecData.results || []).map(p =>
      (p.properties['Decision']?.title?.[0]?.plain_text || '').toLowerCase().trim()
    ).filter(Boolean);

    // Similarity check — returns true if two strings are similar enough to be duplicates
    function isSimilar(a, b) {
      a = a.toLowerCase().trim();
      b = b.toLowerCase().trim();
      if (a === b) return true;
      // Check if one contains the other (handles shortened versions)
      if (a.includes(b) || b.includes(a)) return true;
      // Check word overlap — if >60% of words match, consider duplicate
      const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 3));
      const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 3));
      if (wordsA.size === 0 || wordsB.size === 0) return false;
      const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
      const similarity = overlap / Math.min(wordsA.size, wordsB.size);
      return similarity >= 0.6;
    }

    function isDuplicateTask(task) {
      return existingTasks.some(existing => isSimilar(task, existing));
    }

    function isDuplicateDecision(text) {
      return existingDecisions.some(existing => isSimilar(text, existing));
    }

    // ── 5. Push action items to Notion (with duplicate prevention) ─
    // Duplicate filtering must stay sequential (each new item is checked
    // against both existing Notion items AND items already accepted in
    // this same batch). Once the list of unique items to create is known,
    // fire all the actual Notion writes in parallel — this is the main
    // latency fix, since 10+ sequential Notion round-trips was a large
    // contributor to the function exceeding Netlify's timeout.
    const actionItemsToCreate = [];
    let actionSkipped = 0;
    for (const item of (parsed.actionItems || [])) {
      if (isDuplicateTask(item.task)) {
        console.log(`  SKIP duplicate action: ${item.task.slice(0, 60)}`);
        actionSkipped++;
        continue;
      }
      actionItemsToCreate.push(item);
      existingTasks.push(item.task.toLowerCase().trim());
    }

    const actionResults = await Promise.allSettled(actionItemsToCreate.map(item => {
      const section = item.section && item.section !== 'Other' ? item.section : classifySection(item.task);
      return notionCreate(NOTION_DB_ACTIONS, {
        'Action Item': ttl(item.task),
        'Owner': sel(item.owner),
        'Status': sel('In Progress'),
        'Priority': sel(item.priority || 'Normal'),
        'Notes': txt(item.notes),
        'Source Meeting': txt(sourceMeeting),
      });
    }));
    const actionCount = actionResults.filter(r => r.status === 'fulfilled').length;
    actionResults.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`  FAILED to create action item "${actionItemsToCreate[i].task.slice(0,60)}":`, r.reason.message);
    });
    console.log(`Actions: ${actionCount} created, ${actionSkipped} skipped as duplicates`);

    // ── 6b. Update pipeline from transcript ───────────────────
    let pipelineCount = 0;
    if (NOTION_DB_PIPELINE && parsed.pipelineUpdates?.length) {
      // Fetch existing pipeline leads
      const pipelineRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_PIPELINE}/query`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
        body: JSON.stringify({ page_size: 100 })
      });
      const pipelineData = await pipelineRes.json();
      const existingLeads = (pipelineData.results || []).map(p => ({
        id: p.id,
        name: (p.properties['Lead Name']?.title?.[0]?.plain_text || '').toLowerCase(),
      }));

      const pipelineWriteResults = await Promise.allSettled(parsed.pipelineUpdates.map(update => {
        const nameLower = (update.name || '').toLowerCase();
        const existing = existingLeads.find(l => l.name.includes(nameLower) || nameLower.includes(l.name));

        if (existing) {
          const props = {};
          if (update.stage) props['Stage'] = { select: { name: update.stage } };
          if (update.notes) props['Notes'] = { rich_text: [{ text: { content: `[${today}] ${update.notes}` } }] };
          if (update.followUpDate) props['Follow Up Date'] = { date: { start: update.followUpDate } };
          props['Last Contact'] = { date: { start: today } };

          return fetch(`https://api.notion.com/v1/pages/${existing.id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({ properties: props })
          }).then(() => console.log(`  Pipeline updated: ${update.name} → ${update.stage}`));
        } else {
          return notionCreate(NOTION_DB_PIPELINE, {
            'Lead Name': { title: [{ text: { content: update.name } }] },
            'Stage': { select: { name: update.stage || 'New' } },
            'Owner': update.owner ? { select: { name: update.owner } } : undefined,
            'Notes': update.notes ? { rich_text: [{ text: { content: `[${today}] ${update.notes}` } }] } : undefined,
            'Follow Up Date': update.followUpDate ? { date: { start: update.followUpDate } } : undefined,
            'Last Contact': { date: { start: today } },
            'Source': { rich_text: [{ text: { content: 'Transcript' } }] },
          }).then(() => console.log(`  Pipeline created: ${update.name} (${update.stage || 'New'})`));
        }
      }));
      pipelineWriteResults.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`  FAILED pipeline update for "${parsed.pipelineUpdates[i].name}":`, r.reason.message);
      });
      pipelineCount = pipelineWriteResults.filter(r => r.status === 'fulfilled').length;
    }
    console.log(`Pipeline: ${pipelineCount} leads updated`);

    // ── 6. Push decisions to Notion (with duplicate prevention) ──
    const decisionsToCreate = [];
    let decisionSkipped = 0;
    for (const d of (parsed.decisions || [])) {
      if (isDuplicateDecision(d.text)) {
        console.log(`  SKIP duplicate decision: ${d.text.slice(0, 60)}`);
        decisionSkipped++;
        continue;
      }
      decisionsToCreate.push(d);
      existingDecisions.push(d.text.toLowerCase().trim());
    }

    const decisionResults = await Promise.allSettled(decisionsToCreate.map(d => {
      const section = d.section && d.section !== 'Other' ? d.section : classifySection(d.text);
      return notionCreate(NOTION_DB_DECISIONS, {
        'Decision': ttl(d.text),
        'Section': sel(section),
        'Made By': sel(d.decisionMaker || ''),
        'Context': txt(d.context),
        'Source Meeting': txt(sourceMeeting),
        'Date': dt(callDate),
        'From Transcript': { checkbox: true },
      });
    }));
    const decisionCount = decisionResults.filter(r => r.status === 'fulfilled').length;
    decisionResults.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`  FAILED to create decision "${decisionsToCreate[i].text.slice(0,60)}":`, r.reason.message);
    });
    console.log(`Decisions: ${decisionCount} created, ${decisionSkipped} skipped as duplicates`);

    console.log(`Done: ${actionCount} actions, ${decisionCount} decisions`);

    // ── 6c. Advance meeting date + mark discussed agenda items Done ──
    const NOTION_DB_SETTINGS = process.env.NOTION_DB_SETTINGS;
    const NOTION_DB_AGENDA = process.env.NOTION_DB_AGENDA;
    let agendaMarkedDone = 0;
    let nextMeetingDate = null;

    if (NOTION_DB_SETTINGS) {
      try {
        // Compute next Sunday after the call date that was just processed
        const callDateObj = new Date(callDate + 'T12:00:00');
        const next = new Date(callDateObj);
        next.setDate(next.getDate() + 7);
        nextMeetingDate = next.toISOString().split('T')[0];

        // Find the Settings row for meetingDate
        const settingsRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_SETTINGS}/query`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
          body: JSON.stringify({ filter: { property: 'Key', title: { equals: 'meetingDate' } } })
        });
        const settingsData = await settingsRes.json();
        const settingsRow = (settingsData.results || [])[0];

        if (settingsRow) {
          await fetch(`https://api.notion.com/v1/pages/${settingsRow.id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({ properties: { 'Value': { rich_text: [{ text: { content: nextMeetingDate } }] } } })
          });
          console.log(`Meeting date advanced: ${callDate} → ${nextMeetingDate}`);
        } else {
          console.log('WARNING: no meetingDate row found in Settings — could not advance');
        }
      } catch (settingsErr) {
        console.error('Meeting date advance error:', settingsErr.message);
      }
    }

    // Mark agenda items discussed on this call as Done.
    // We treat any Active agenda item whose topic text overlaps with a decision
    // or action item logged from this call as "discussed" — same similarity
    // check used for duplicate detection above.
    if (NOTION_DB_AGENDA) {
      try {
        const agendaRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_AGENDA}/query`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
          body: JSON.stringify({ filter: { property: 'Status', select: { equals: 'Active' } }, page_size: 100 })
        });
        const agendaData = await agendaRes.json();
        const agendaRows = (agendaData.results || []).map(p => ({
          id: p.id,
          topic: p.properties['Topic']?.title?.[0]?.plain_text || '',
        })).filter(a => a.topic);

        const discussedText = [
          ...(parsed.decisions || []).map(d => d.text),
          ...(parsed.actionItems || []).map(a => a.task),
        ].join(' ').toLowerCase();

        const rowsToMarkDone = agendaRows.filter(row => {
          const topicWords = row.topic.toLowerCase().split(/\s+/).filter(w => w.length > 4);
          if (!topicWords.length) return false;
          const matchedWords = topicWords.filter(w => discussedText.includes(w));
          return (matchedWords.length / topicWords.length) >= 0.5;
        });

        const agendaResults = await Promise.allSettled(rowsToMarkDone.map(row =>
          fetch(`https://api.notion.com/v1/pages/${row.id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({ properties: { 'Status': { select: { name: 'Done' } } } })
          })
        ));
        agendaMarkedDone = agendaResults.filter(r => r.status === 'fulfilled').length;
        rowsToMarkDone.forEach((row, i) => {
          if (agendaResults[i].status === 'fulfilled') console.log(`  Agenda marked Done: ${row.topic.slice(0, 60)}`);
          else console.error(`  FAILED to mark agenda Done "${row.topic.slice(0,60)}":`, agendaResults[i].reason.message);
        });
        console.log(`Agenda: ${agendaMarkedDone} items marked Done`);
      } catch (agendaErr) {
        console.error('Agenda update error:', agendaErr.message);
      }
    }

    // ── 6. Send post-call summary email via Resend ────────────
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.FROM_EMAIL || 'hub@turnfairy.com';
    const TEAM_EMAILS = (process.env.TEAM_EMAILS || 'greg@turnfairy.com,andrea@turnfairy.com,mike@turnfairy.com,lauren@turnfairy.com').split(',');
    const HUB_URL = 'https://turnfairy-hub.netlify.app';

    let emailSent = false;
    if (RESEND_KEY && (actionCount > 0 || decisionCount > 0)) {
      try {
        const callDateFmt = new Date(callDate + 'T12:00:00').toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric'
        });

        // Fetch this call's decisions, new action items, and all open
        // items in parallel — these three reads are independent of each
        // other, and were previously sequential, adding to the already
        // long execution time right before the function's 60s ceiling.
        const [decRes, newActRes, openActRes] = await Promise.all([
          fetch(`https://api.notion.com/v1/databases/${NOTION_DB_DECISIONS}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({ filter: { property: 'Date', date: { equals: callDate } } })
          }),
          fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ACTIONS}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({ filter: { property: 'Source Meeting', rich_text: { contains: callDate } } })
          }),
          fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ACTIONS}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({
              filter: { and: [
                { property: 'Status', select: { does_not_equal: 'Done' } },
                { property: 'Status', select: { does_not_equal: 'Archived' } },
              ]}
            })
          }),
        ]);

        const decData = await decRes.json();
        const todaysDecisions = (decData.results || []).map(p => ({
          text: p.properties['Decision']?.title?.[0]?.plain_text || '',
          decisionMaker: p.properties['Made By']?.select?.name || '',
          section: p.properties['Section']?.select?.name || '',
        })).filter(d => d.text);

        const newActData = await newActRes.json();
        const newItems = (newActData.results || []).map(p => ({
          task: p.properties['Action Item']?.title?.[0]?.plain_text || '',
          owner: p.properties['Owner']?.select?.name || 'Unassigned',
          priority: p.properties['Priority']?.select?.name || 'Normal',
        })).filter(a => a.task);

        const openActData = await openActRes.json();
        const openItems = (openActData.results || []).map(p => ({
          task: p.properties['Action Item']?.title?.[0]?.plain_text || '',
          owner: p.properties['Owner']?.select?.name || 'Unassigned',
          priority: p.properties['Priority']?.select?.name || 'Normal',
        })).filter(a => a.task);

        // Build post-call summary email
        let body = `Hi team,\n\nHere's your post-call summary from the Turnfairy call on ${callDateFmt}.\n\n`;
        body += `────────────────────────────────\n`;
        body += `TRANSCRIPT ANALYZED\n`;
        body += `  ${actionCount} new action items · ${decisionCount} decisions logged${pipelineCount > 0 ? ` · ${pipelineCount} pipeline leads updated` : ''}${agendaMarkedDone > 0 ? ` · ${agendaMarkedDone} agenda topics marked discussed` : ''}\n`;
        if (nextMeetingDate) {
          const nextFmt = new Date(nextMeetingDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
          body += `  Next meeting advanced to: ${nextFmt}\n`;
        }
        body += `\n`;

        // Decisions from today
        if (todaysDecisions.length) {
          body += `DECISIONS MADE TODAY\n`;
          const sections = ['Finance', 'Operations', 'Owners', 'Sales', 'Team', 'Other'];
          sections.forEach(sec => {
            const items = todaysDecisions.filter(d => d.section === sec);
            if (!items.length) return;
            body += `\n${sec.toUpperCase()}\n`;
            items.forEach(d => {
              body += `  • ${d.text}${d.decisionMaker ? ` (${d.decisionMaker})` : ''}\n`;
            });
          });
          body += '\n';
        }

        // New action items from today
        if (newItems.length) {
          body += `NEW ACTION ITEMS FROM TODAY'S CALL\n`;
          const owners = [...new Set(newItems.map(a => a.owner))].sort();
          owners.forEach(owner => {
            const items = newItems.filter(a => a.owner === owner);
            body += `\n${owner}:\n`;
            items.forEach(a => {
              const flag = a.priority === 'Urgent' ? ' 🚨' : a.priority === 'High' ? ' 🟠' : '';
              body += `  ☐ ${a.task}${flag}\n`;
            });
          });
          body += '\n';
        }

        // Full open items by owner
        if (openItems.length) {
          body += `────────────────────────────────\n`;
          body += `ALL OPEN ITEMS BY OWNER (${openItems.length} total)\n`;
          const owners = [...new Set(openItems.map(a => a.owner))].sort();
          owners.forEach(owner => {
            const items = openItems.filter(a => a.owner === owner);
            body += `\n${owner} (${items.length} open):\n`;
            items.forEach(a => {
              const flag = a.priority === 'Urgent' ? ' 🚨' : '';
              body += `  ☐ ${a.task}${flag}\n`;
            });
          });
          body += '\n';
        }

        body += `────────────────────────────────\nFull details and updates in the Manager Hub above.`;

        const subject = `Turnfairy Post-Call Summary — ${callDateFmt}`;

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM_EMAIL, to: TEAM_EMAILS, subject, text: body, html: buildHtmlEmail(body) })
        });

        if (emailRes.ok) {
          emailSent = true;
          console.log('✓ Post-call summary email sent');
        } else {
          console.error('Email send failed:', await emailRes.text());
        }
      } catch (emailErr) {
        console.error('Post-call email error:', emailErr.message);
      }
    } else if (!RESEND_KEY) {
      console.log('No RESEND_API_KEY — skipping email');
    } else {
      console.log('No new items processed — skipping post-call email');
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        call: recent.title,
        callDate,
        actionItems: actionCount,
        decisions: decisionCount,
        agendaMarkedDone,
        nextMeetingDate,
        emailSent,
      })
    };

  } catch (err) {
    console.error('auto-process-call-background error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};





