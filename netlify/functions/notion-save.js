const https = require('https');

const NOTION_KEY = process.env.NOTION_TOKEN;
const DB = {
  actions:   process.env.NOTION_DB_ACTIONS,
  agenda:    process.env.NOTION_DB_AGENDA,
  decisions: process.env.NOTION_DB_DECISIONS,
};

function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.notion.com', path, method,
      headers: {
        'Authorization': `Bearer ${NOTION_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error(raw)); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function ttl(v) { return { title:     [{ text: { content: v || '' } }] }; }
function txt(v) { return { rich_text: [{ text: { content: v || '' } }] }; }
function sel(v) { return v ? { select: { name: v } } : { select: null }; }
function dt(v)  { return v ? { date: { start: v } } : { date: null }; }
function num(v) { return { number: v || 5 }; }
function chk(v) { return { checkbox: !!v }; }

function buildProps(type, data) {
  if (type === 'actions') {
    const props = {};
    if (data.task       !== undefined) props['Action Item']   = ttl(data.task);
    if (data.owner      !== undefined) props['Owner']         = sel(data.owner);
    if (data.status     !== undefined) props['Status']        = sel(data.status);
    if (data.priority   !== undefined) props['Priority']      = sel(data.priority);
    if (data.due        !== undefined) props['Due Date']      = dt(data.due);
    if (data.notes      !== undefined) props['Notes']         = txt(data.notes);
    if (data.resolution !== undefined) props['Resolution']    = txt(data.resolution);
    return props;
  }
  if (type === 'agenda') {
    const props = {};
    if (data.topic     !== undefined) props['Topic']     = ttl(data.topic);
    if (data.presenter !== undefined) props['Presenter'] = sel(data.presenter);
    if (data.section   !== undefined) props['Section']   = sel(data.section);
    if (data.duration  !== undefined) props['Duration']  = num(data.duration);
    if (data.notes     !== undefined) props['Notes']     = txt(data.notes);
    if (data.weekOf    !== undefined) props['Week of']   = dt(data.weekOf);
    if (data.status    !== undefined) props['Status']    = sel(data.status);
    if (data.source    !== undefined) props['Source']    = sel(data.source);
    return props;
  }
  if (type === 'decisions') {
    const props = {};
    if (data.text           !== undefined) props['Decision']        = ttl(data.text);
    if (data.section        !== undefined) props['Section']         = sel(data.section);
    if (data.date           !== undefined) props['Date']            = dt(data.date);
    if (data.fromTranscript  !== undefined) props['From Transcript']  = chk(data.fromTranscript);
    if (data.decisionMaker   !== undefined) props['Made By']          = sel(data.decisionMaker);
    if (data.notes           !== undefined) props['Notes']            = txt(data.notes);
    return props;
  }
  if (type === 'pipeline') {
    const props = {};
    if (data.name        !== undefined) props['Lead Name']      = ttl(data.name);
    if (data.stage       !== undefined) props['Stage']          = sel(data.stage);
    if (data.owner       !== undefined) props['Owner']          = sel(data.owner);
    if (data.address     !== undefined) props['Address']        = txt(data.address);
    if (data.platforms   !== undefined) props['Platforms']      = sel(data.platforms);
    if (data.notes       !== undefined) props['Notes']          = txt(data.notes);
    if (data.source      !== undefined) props['Source']         = txt(data.source);
    if (data.followUpDate !== undefined) props['Follow Up Date'] = dt(data.followUpDate);
    if (data.lastContact  !== undefined) props['Last Contact']   = dt(data.lastContact);
    return props;
  }
  return {};
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { type, id, data } = JSON.parse(event.body);

    // Settings: simple key/value update by page ID
    if (type === 'settings') {
      const props = { 'Value': { rich_text: [{ text: { content: String(data.value || '') } }] } };
      const result = await notionRequest('PATCH', `/v1/pages/${id}`, { properties: props });
      if (result.object === 'error') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: result.message, code: result.code }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ id: result.id, success: true }) };
    }

    const properties = buildProps(type, data);

    const result = id
      ? await notionRequest('PATCH', `/v1/pages/${id}`, { properties })
      : await notionRequest('POST', '/v1/pages', {
          parent: { database_id: DB[type] },
          properties,
        });

    if (result.object === 'error') {
      return { 
        statusCode: 400, headers, 
        body: JSON.stringify({ 
          error: result.message, 
          code: result.code,
          debug: { type, id: id || null, properties: JSON.stringify(properties).slice(0, 500) }
        }) 
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ id: result.id, success: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
