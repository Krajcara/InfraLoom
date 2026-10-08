'use strict';

// Starts a real InfraLoom server on a throw-away encrypted database and gives tests a small HTTP client.
// Nothing here touches the real data directory or .env.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

const hex = () => crypto.randomBytes(32).toString('hex');

/** Environment for a disposable instance (also used by tests that load the database module in-process). */
function tempEnv(dir) {
  return { ...process.env, NODE_ENV: 'test', DB_PATH: path.join(dir, 'infraloom.db'), DB_ENCRYPTION_KEY: hex(), APP_SECRET: hex(), BACKUP_ENCRYPTION_PASSWORD: hex() };
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infraloom-test-'));
  const env = tempEnv(dir);
  const port = await freePort();
  env.APP_PORT = String(port);
  const seed = spawnSync('node', ['src/db/seed.js'], { cwd: SERVER_DIR, env, encoding: 'utf8' });
  const password = /Password\s*:\s*(\S+)/.exec(seed.stdout || '')?.[1];
  if (!password) throw new Error(`could not seed a test database:\n${seed.stdout}\n${seed.stderr}`);
  const child = spawn('node', ['src/index.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
    if (i === 79) { child.kill(); throw new Error(`server did not start:\n${log}`); }
  }
  const stop = () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { base, password, stop, dir };
}

/** A tiny cookie-keeping client: await c.get('/api/...'), c.post(path, body) ... returns { status, body }. */
class Client {
  constructor(base, headers = {}) { this.base = base; this.cookie = ''; this.headers = headers; }
  async request(method, url, body) {
    const res = await fetch(this.base + url, { method, headers: { 'Content-Type': 'application/json', ...this.headers, ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    let data = null; try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: data };
  }
  get(u) { return this.request('GET', u); }
  post(u, b) { return this.request('POST', u, b ?? {}); }
  put(u, b) { return this.request('PUT', u, b ?? {}); }
  del(u) { return this.request('DELETE', u); }
  async login(username, password) { const r = await this.post('/api/auth/login', { username, password }); if (r.status !== 200) throw new Error(`login failed for ${username}: ${r.status}`); return this; }
}

/** An admin client plus one client per role, created through the real user API. */
async function clientsFor(srv) {
  const admin = await new Client(srv.base).login('admin', srv.password);
  const out = { admin };
  for (const role of ['operator', 'viewer']) {
    const u = await admin.post('/api/users', { username: `t_${role}`, full_name: role, email: `${role}@test.rs`, role });
    out[role] = await new Client(srv.base).login(`t_${role}`, u.body.temporaryPassword);
  }
  out.anon = new Client(srv.base);
  return out;
}

module.exports = { startServer, tempEnv, Client, clientsFor, SERVER_DIR };
