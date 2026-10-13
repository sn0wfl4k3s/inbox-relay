// relay/server.js — mailbox HTTP relay (Render Hobby free)
// linguagem: Node.js 18+, zero dependências. arquivo: relay/server.js
// *agent (phone) faz POST polling; operator (bridge local) faz GET polling*
// *fila em RAM — free tier não tem disco persistente; reinício zera caixas*
const http = require('http');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.RELAY_TOKEN || 'change-me';
const MAX_BODY = 25 * 1024 * 1024;      // file transfer via base64 no JSON
const MAX_INBOX = 500;                  // fila operator→agent por device
const MAX_OUTBOX = 4000;                // fila agent→operator global

const agents = new Map();               // id -> { lastSeen, inbox: [] }
let opOut = [];                         // [{ agent, line }]

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authed(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer (.+)$/);
  return m && m[1] === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true });
  if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

  try {
    // ---- agent (phone) ----
    if (req.method === 'POST' && url === '/api/agent/poll') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.id) return json(res, 400, { error: 'id required' });

      let agent = agents.get(body.id);
      if (!agent) { agent = { lastSeen: 0, inbox: [] }; agents.set(body.id, agent); }
      agent.lastSeen = Date.now();

      // outbox do agent → caixa do operator (bridge)
      if (Array.isArray(body.out) && body.out.length) {
        for (const line of body.out) opOut.push({ agent: body.id, line: String(line) });
        if (opOut.length > MAX_OUTBOX) opOut.splice(0, opOut.length - MAX_OUTBOX);
      }

      // caixa do operator → agent (drena)
      const inbox = agent.inbox;
      agent.inbox = [];
      return json(res, 200, { in: inbox });
    }

    // ---- operator (bridge local) ----
    if (req.method === 'GET' && url === '/api/op/poll') {
      const out = opOut;
      opOut = [];
      const list = [];
      for (const [id, a] of agents) list.push({ id, lastSeen: a.lastSeen, queued: a.inbox.length });
      return json(res, 200, { agents: list, out });
    }

    if (req.method === 'POST' && url === '/api/op/send') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.line) return json(res, 400, { error: 'line required' });
      const line = String(body.line);
      if (body.target === '*') {
        for (const a of agents.values()) {
          a.inbox.push(line);
          if (a.inbox.length > MAX_INBOX) a.inbox.splice(0, a.inbox.length - MAX_INBOX);
        }
      } else {
        const a = agents.get(body.target);
        if (!a) return json(res, 404, { error: 'unknown agent' });
        a.inbox.push(line);
        if (a.inbox.length > MAX_INBOX) a.inbox.splice(0, a.inbox.length - MAX_INBOX);
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log('relay listening on :' + PORT));
