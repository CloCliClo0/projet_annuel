// Poste dans Discord chaque nouvel écran d'un projet Stitch.
// Modes : "inspect" (affiche les outils et la forme des réponses, ne poste rien)
//         "run"     (détecte les nouveaux écrans et les poste).
// Secrets attendus en variables d'environnement : STITCH_API_KEY, DISCORD_WEBHOOK_URL.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ENDPOINT = 'https://stitch.googleapis.com/mcp';
const KEY = process.env.STITCH_API_KEY;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const PROJECT = process.env.STITCH_PROJECT_ID || '';           // ex. "projects/123456"
const PROJECT_URL = process.env.STITCH_PROJECT_URL || '';      // lien optionnel vers le projet
const MODE = process.env.MODE || 'run';
const STATE_FILE = process.env.STATE_FILE || '.state/seen.json';
const MAX_POSTS = 10;

if (!KEY) fail('STITCH_API_KEY manquant');
if (MODE === 'run' && !WEBHOOK) fail('DISCORD_WEBHOOK_URL manquant');
if (WEBHOOK && /\/github\/?$/.test(WEBHOOK)) fail("L'URL du webhook Discord ne doit PAS finir par /github ici");

function fail(msg) { console.error('Erreur : ' + msg); process.exit(1); }
const cut = (v, n = 3000) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2)).slice(0, n);

// --- Client MCP minimal (HTTP, JSON ou SSE) ---
let sessionId;
let nextId = 1;

function parseReply(text, id) {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  for (const line of t.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    const msg = JSON.parse(data);
    if (msg.id === id) return msg;
  }
  throw new Error('Réponse MCP illisible');
}

async function rpc(method, params, notify = false) {
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
  if (!notify) body.id = nextId++;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'X-Goog-Api-Key': KEY,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${method} : ${text.slice(0, 300)}`);
  if (notify) return null;
  const msg = parseReply(text, body.id);
  if (msg.error) throw new Error(`Erreur MCP sur ${method} : ${cut(msg.error, 300)}`);
  return msg.result;
}

async function connect() {
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'stitch-to-discord', version: '1.0.0' },
  });
  await rpc('notifications/initialized', undefined, true);
}

async function callTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result?.isError) throw new Error(`L'outil ${name} a renvoyé une erreur : ${cut(result.content, 300)}`);
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch { return text || result; }
}

// --- Extraction tolérante (les schémas exacts ne sont pas documentés) ---
function findScreens(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.screens)) return data.screens;
    for (const v of Object.values(data)) { const r = findScreens(v); if (r.length) return r; }
  }
  return [];
}
const screenId = s => (typeof s === 'string' ? s : s?.name ?? s?.id ?? s?.screenId ?? null);

function findImageUrl(obj) {
  let best = null;
  (function walk(v, key = '') {
    if (best?.score === 2) return;
    if (typeof v === 'string' && /^https:\/\//.test(v)) {
      const score = /screenshot/i.test(key) ? 2 : (/image|thumbnail|preview/i.test(key) || /\.(png|jpe?g|webp)(\?|$)/i.test(v)) ? 1 : 0;
      if (score && (!best || score > best.score)) best = { url: v, score };
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  })(obj);
  return best?.url ?? null;
}

async function post(payload) {
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord a répondu ${res.status} : ${(await res.text()).slice(0, 200)}`);
}

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return null; }
}
async function saveState(seen) {
  await mkdir(STATE_FILE.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ seen }, null, 2));
}

// --- Programme ---
const listArgs = process.env.STITCH_LIST_ARGS_JSON
  ? JSON.parse(process.env.STITCH_LIST_ARGS_JSON)
  : { projectId: PROJECT };

await connect();

if (MODE === 'inspect') {
  const tools = await rpc('tools/list');
  console.log('=== Outils disponibles ===');
  for (const t of tools.tools || []) console.log(`- ${t.name}\n  ${cut(t.inputSchema ?? {}, 600).replace(/\n/g, '\n  ')}`);
  console.log('\n=== list_projects ===');
  try { console.log(cut(await callTool('list_projects'), 3000)); } catch (e) { console.log(e.message); }
  if (PROJECT) {
    console.log('\n=== list_screens ===');
    try { console.log(cut(await callTool('list_screens', listArgs), 3000)); } catch (e) { console.log(e.message); }
  }
  console.log('\nInspection terminée (rien envoyé à Discord).');
  process.exit(0);
}

if (!PROJECT && !process.env.STITCH_LIST_ARGS_JSON) fail('STITCH_PROJECT_ID manquant');

const screens = findScreens(await callTool('list_screens', listArgs));
const ids = screens.map(screenId).filter(Boolean);
const state = await loadState();

if (!state) {
  // Premier passage : on mémorise l'existant sans le poster.
  await saveState(ids);
  await post({ content: `✅ Suivi Stitch activé : ${ids.length} écran(s) existant(s) mémorisé(s). Les nouveaux seront annoncés ici.` });
  console.log(`Initialisé avec ${ids.length} écran(s).`);
  process.exit(0);
}

const seen = new Set(state.seen);
const fresh = screens.filter(s => { const id = screenId(s); return id && !seen.has(id); });
console.log(`${fresh.length} nouvel(s) écran(s).`);

let posted = 0;
for (const s of fresh) {
  const id = screenId(s);
  if (posted >= MAX_POSTS) break;                       // le reste sera posté au prochain passage
  let detail = s;
  try { detail = await callTool('get_screen', { ...listArgs, screenId: id, name: id }); } catch (e) { console.log('get_screen : ' + e.message); }
  const title = (typeof s === 'object' && (s.title || s.displayName)) || String(id).split('/').pop();
  const image = findImageUrl(detail) || findImageUrl(s);
  await post({
    embeds: [{
      title: `🆕 Nouvel écran Stitch : ${title}`,
      ...(PROJECT_URL ? { url: PROJECT_URL } : {}),
      ...(image ? { image: { url: image } } : {}),
      color: 0x1e3a8a,
      timestamp: new Date().toISOString(),
    }],
  });
  seen.add(id);
  posted++;
  await new Promise(r => setTimeout(r, 1200));          // respecte la limite de débit du webhook
}
await saveState([...seen]);
console.log(`${posted} message(s) envoyé(s).`);
