const https = require('https');

const NOTION_KEY = process.env.NOTION_TOKEN;
const DB = {
  actions:   process.env.NOTION_DB_ACTIONS,
  agenda:    process.env.NOTION_DB_AGENDA,
  decisions: process.env.NOTION_DB_DECISIONS,
};

function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com', path, method,
      headers: {
        'Authorization': `Bearer ${NOTION_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw)); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function prop(page, name) {
  const p = page.properties?.[name];
  if (!p) return null;
  switch (p.type) {
    case 'title':     return p.title?.[0]?.plain_text || '';
    case 'rich_text': return p.rich_text?.[0]?.plain_text || '';
    case 'select':    return p.select?.name || '';
    case 'date':      return p.date?.start || '';
    case 'checkbox':  return p.checkbox || false;
    case 'number':    return p.number ?? null;
    default:          return null;
  }
}

exports.handler = async (event) => {
  // Fast path: ?type=settings only returns settings (used for PIN loading)
  if (event.queryStringParameters?.type === 'settings') {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const setRes = await notionRequest('POST', `/v1/databases/${process.env.NOTION_DB_SETTINGS}/query`, {});
      const settings = [];
      (setRes?.results || []).forEach(p => {
        const key = p.properties['Key']?.title?.[0]?.plain_text;
        const val = p.properties['Value']?.rich_text?.[0]?.plain_text;
        if (key) settings.push({ key, value: val });
      });
      return { statusCode: 200, headers, body: JSON.stringify({ settings }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    // Actions and Agenda items load ALL non-archived items — they persist until deleted
    // Only decisions are capped at 50 most recent

    const [actRes, agRes, decRes, setRes, pipelineRes] = await Promise.all([
      notionRequest('POST', `/v1/databases/${DB.actions}/query`,
        { filter: { and: [{ property: 'Status', select: { does_not_equal: 'Done' } }, { property: 'Status', select: { does_not_equal: 'Archived' } }] }, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] }),
      notionRequest('POST', `/v1/databases/${DB.agenda}/query`,
        { filter: { property: 'Status', select: { does_not_equal: 'Done' } }, sorts: [{ property: 'Section', direction: 'ascending' }, { timestamp: 'created_time', direction: 'ascending' }] }),
      notionRequest('POST', `/v1/databases/${DB.decisions}/query`,
        { sorts: [{ property: 'Date', direction: 'descending' }] }),
      notionRequest('POST', `/v1/databases/${process.env.NOTION_DB_SETTINGS}/query`, {}),
      DB.pipeline ? notionRequest('POST', `/v1/databases/${DB.pipeline}/query`, {
        sorts: [{ property: 'Stage', direction: 'ascending' }]
      }) : Promise.resolve({ results: [] }),
    ]);

    // Parse settings
    const settings = {};
    const settingsIds = {};
    if (setRes?.results) {
      setRes.results.forEach(p => {
        const key = p.properties['Key']?.title?.[0]?.plain_text;
        const val = p.properties['Value']?.rich_text?.[0]?.plain_text;
        if (key) { settings[key] = val; settingsIds[key] = p.id; }
      });
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        settings,
        settingsIds,
        pipeline: (pipelineRes.results || []).map(p => ({
          id: p.id,
          notionId: p.id,
          name: prop(p, 'Lead Name'),
          stage: prop(p, 'Stage') || 'New',
          owner: prop(p, 'Owner') || '',
          address: prop(p, 'Address') || '',
          platforms: prop(p, 'Platforms') || '',
          notes: prop(p, 'Notes') || '',
          source: prop(p, 'Source') || '',
          followUpDate: p.properties['Follow Up Date']?.date?.start || '',
          lastContact: p.properties['Last Contact']?.date?.start || '',
        })),
        actions: (actRes.results || []).map(p => ({
          id:       p.id,
          notionId: p.id,
          created:  p.created_time?.split('T')[0],
          task:     prop(p, 'Action Item'),
          owner:    prop(p, 'Owner'),
          status:   prop(p, 'Status'),
          priority: prop(p, 'Priority'),
          section:  prop(p, 'Source Meeting'),
          due:      prop(p, 'Due Date'),
          notes:    prop(p, 'Notes'),
          resolution: prop(p, 'Resolution'),
        })),
        agenda: (agRes.results || []).map(p => ({
          id:        p.id,
          notionId:  p.id,
          created:   p.created_time?.split('T')[0],
          topic:     prop(p, 'Topic'),
          presenter: prop(p, 'Presenter'),
          section:   prop(p, 'Section'),
          duration:  prop(p, 'Duration') || 5,
          notes:     prop(p, 'Notes'),
          weekOf:    prop(p, 'Week of'),
          status:    prop(p, 'Status') || 'Active',
          source:    prop(p, 'Source') || 'Manual',
        })),
        decisions: (decRes.results || []).map(p => ({
          id:             p.id,
          notionId:       p.id,
          created:        p.created_time?.split('T')[0],
          text:           prop(p, 'Decision'),
          section:        prop(p, 'Section'),
          date:           prop(p, 'Date'),
          fromTranscript:  prop(p, 'From Transcript'),
          decisionMaker:   prop(p, 'Made By'),
          notes:           prop(p, 'Notes'),
        })),
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
