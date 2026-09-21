'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');

const db = require('./db/database'); // eslint-disable-line no-unused-vars -- ensures schema exists on boot

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true, credentials: true } });

const APP_PORT = process.env.APP_PORT || 3000;

// ── Security & core middleware ──────────────────────────────────────────
// This app is served over plain HTTP in this phase (no TLS termination yet).
// helmet()'s defaults include a CSP `upgrade-insecure-requests` directive and
// HSTS, both of which tell the browser to force HTTPS — that breaks asset
// loading here (ERR_SSL_PROTOCOL_ERROR), since there's no HTTPS to upgrade to.
// Revisit this once a reverse proxy with TLS is in front of the app.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        upgradeInsecureRequests: null,
      },
    },
    hsts: false,
    originAgentCluster: false,
  })
);
app.use(cors({ origin: true, credentials: true }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('short'));

app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ── Health check — used by installer/update scripts and monitoring ─────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'InfraLoom', phase: 0 });
});

// Feature API routes (auth, users, settings, modules...) are mounted here
// starting from Phase 1 onward. Phase 0 intentionally ships no business
// logic beyond the encrypted DB, base schema, and this health check.

// ── Serve built frontend in production ──────────────────────────────────
const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('InfraLoom server is running. Build the client with `npm run build` to serve the UI.');
  });
}

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

server.listen(APP_PORT, () => {
  console.log(`InfraLoom server listening on port ${APP_PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
