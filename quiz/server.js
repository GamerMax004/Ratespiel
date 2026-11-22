// Quiz-App ohne Abhängigkeiten: node server.js  (Port 3000, ADMIN_PASSWORD per Umgebungsvariable)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, ADMIN_PW = (process.env.ADMIN_PASSWORD || 'admin').trim();
const DB = path.join(process.env.DATA_DIR || __dirname, 'data.json');
let S = { groups: [], rounds: [], live: { phase: 'idle', roundId: null, answers: {}, results: {} } };
try { S = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DB, JSON.stringify(S, null, 1));
const tokens = new Set(), clients = new Set();
const norm = s => String(s || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const round = () => S.rounds.find(r => r.id === S.live.roundId);
const ranking = () => [...S.groups].sort((a, b) => b.points - a.points).map((g, i, a) => ({ ...g, rank: i && a[i - 1].points === g.points ? a[i - 1].rank : i + 1 }));
function view(c) {
  const r = round(), live = S.live, open = live.phase === 'open';
  const pub = { phase: live.phase, round: r ? r.name : null, questions: r && live.phase !== 'idle' ? r.questions.map(q => q.q) : [] };
  const rk = ranking().map(g => ({ id: g.id, name: g.name, points: g.points, rank: g.rank, gained: live.results[g.id] ?? null }));
  if (c.admin) return { ...pub, ranking: rk, groups: S.groups.map(g => ({ ...g, answered: !!live.answers[g.id] })), rounds: S.rounds, roundId: live.roundId,
    solutions: r && !open ? r.questions.map(q => q.a) : null };
  const g = S.groups.find(x => x.id === c.g); if (!g) return { gone: true };
  const me = rk.find(x => x.id === g.id);
  return { ...pub, name: g.name, answered: !!live.answers[g.id], me, total: S.groups.length };
}
const push = () => clients.forEach(c => c.res.write(`data: ${JSON.stringify(view(c))}\n\n`));
function close() {
  const r = round(); if (S.live.phase !== 'open' || !r) return;
  S.live.results = {};
  for (const g of S.groups) {
    const a = S.live.answers[g.id] || [];
    const n = r.questions.filter((q, i) => String(q.a).split('|').some(x => norm(x) && norm(x) === norm(a[i]))).length;
    S.live.results[g.id] = n; g.points += n;
  }
  S.live.phase = 'closed'; save(); push();
}
const act = {
  addGroup: b => { const name = String(b.name || '').trim().slice(0, 40); if (!name) return;
    let code; do code = String(Math.floor(1000 + Math.random() * 9000)); while (S.groups.some(g => g.code === code));
    S.groups.push({ id: crypto.randomUUID(), name, code, points: 0 }); },
  delGroup: b => { S.groups = S.groups.filter(g => g.id !== b.id); },
  resetPoints: () => { S.groups.forEach(g => g.points = 0); S.live = { phase: 'idle', roundId: null, answers: {}, results: {} }; },
  saveRound: b => { const r = { id: b.id || crypto.randomUUID(), name: String(b.name || 'Runde').slice(0, 60),
      questions: (b.questions || []).slice(0, 10).map(q => ({ q: String(q.q || '').slice(0, 300), a: String(q.a || '').slice(0, 200) })).filter(q => q.q) };
    const i = S.rounds.findIndex(x => x.id === r.id); i < 0 ? S.rounds.push(r) : S.rounds[i] = r; },
  delRound: b => { S.rounds = S.rounds.filter(r => r.id !== b.id); },
  start: b => { if (S.live.phase === 'open' || !S.rounds.some(r => r.id === b.id)) return; S.live = { phase: 'open', roundId: b.id, answers: {}, results: {} }; },
  close: () => close(), idle: () => { if (S.live.phase !== 'open') S.live = { phase: 'idle', roundId: null, answers: {}, results: {} }; }
};
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d)); } catch { r({}); } }); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/events') {
    const c = { res, admin: tokens.has(u.searchParams.get('t')), g: u.searchParams.get('g') };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(c); req.on('close', () => clients.delete(c)); return res.write(`data: ${JSON.stringify(view(c))}\n\n`);
  }
  if (req.method === 'POST') {
    const b = await body(req);
    if (u.pathname === '/api/login') {
      if (String(b.code || '').trim() === ADMIN_PW) { const t = crypto.randomUUID(); tokens.add(t); return json(res, { role: 'admin', token: t }); }
      const g = S.groups.find(x => x.code === String(b.code).trim()); return g ? json(res, { role: 'group', g: g.id }) : json(res, { error: 'Code unbekannt' }, 404);
    }
    if (u.pathname === '/api/answer') {
      const g = S.groups.find(x => x.id === b.g);
      if (g && S.live.phase === 'open' && !S.live.answers[g.id]) {
        S.live.answers[g.id] = (b.answers || []).slice(0, 10).map(x => String(x).slice(0, 200));
        if (S.groups.every(x => S.live.answers[x.id])) close(); else { save(); push(); }
      }
      return json(res, { ok: true });
    }
    if (u.pathname === '/api/admin' && tokens.has(b.token) && act[b.action]) { act[b.action](b); save(); push(); return json(res, { ok: true }); }
    return json(res, { error: 'Nicht erlaubt' }, 403);
  }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); });
}).listen(PORT, () => console.log(`Quiz läuft auf http://localhost:${PORT}  (Admin-Passwort: ${ADMIN_PW})`));
