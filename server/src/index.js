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
// Trusts exactly one hop in front of Node (a reverse proxy / load balancer,
// if one is present) so express-rate-limit and req.ip read the real client
// IP from X-Forwarded-For instead of logging a warning on every request.
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true, credentials: true } });
global.io = io; // accessible to routes/services that need to push events (update, later monitors etc.)
require('./services/sshTerminal').initSshTerminal(io);

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
  res.json({ ok: true, app: 'InfraLoom', phase: 1 });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/update', require('./routes/update'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/audit-log', require('./routes/audit'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/licences', require('./routes/licences'));
app.use('/api/entra-apps', require('./routes/entraApps'));
app.use('/api/monitors', require('./routes/monitors'));
app.use('/api/status', require('./routes/status'));
{
  const { createDeviceRouter } = require('./routes/networkDeviceFactory');
  app.use('/api/routers', createDeviceRouter('routers', 'routers'));
  app.use('/api/switches', createDeviceRouter('switches', 'switches'));
  app.use('/api/access-points', createDeviceRouter('access_points', 'access-points'));
}
app.use('/api/dns', require('./routes/dns'));
app.use('/api/dns-analytics', require('./routes/dnsAnalytics'));
app.use('/api/netspeed', require('./routes/netspeed'));
app.use('/api/myip', require('./routes/myip'));
app.use('/api/hypervisors', require('./routes/hypervisors'));
app.use('/api/network-scanner', require('./routes/networkScanner'));
app.use('/api/patch-management', require('./routes/patchManagement'));

// ── Serve built frontend in production ──────────────────────────────────
const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      // client/dist is briefly missing mid-rebuild during an update — that's
      // expected, not a real error; avoid printing a raw ENOENT stack trace.
      if (err && !res.headersSent) {
        res.status(503).send('InfraLoom is updating — this page will be back in a moment.');
      }
    });
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

// Daily 03:00 — licence & Entra ID secret expiry digest notification.
const cron = require('node-cron');
cron.schedule('0 3 * * *', () => require('./services/expiryChecker').checkExpiries());

// Uptime Monitor: start the scheduler for all enabled monitors, and run a
// daily 02:00 SSL certificate expiry check across https-capable monitors —
// plus once immediately at startup, so a fresh install doesn't show an
// empty SSL column for up to 24h before the first scheduled run.
require('./services/monitorWorker').initMonitorWorker();
cron.schedule('0 2 * * *', () => require('./services/sslChecker').checkAllSSL());
require('./services/netspeedService').initScheduler();
require('./services/networkScanService').initScheduler();
setTimeout(() => require('./services/sslChecker').checkAllSSL(false), 5000);

process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down...');

  // socket.io keeps WebSocket connections open indefinitely by design; a
  // connected browser tab won't close its end just because the server is
  // stopping, so server.close()'s callback could otherwise wait for the
  // client to notice and disconnect on its own (tens of seconds). Force
  // every socket closed immediately so shutdown isn't held hostage by it.
  io.close();

  server.close(() => process.exit(0));

  // Failsafe: exit anyway if something else keeps an HTTP connection open
  // past a reasonable grace period, so `systemctl restart` (and therefore
  // the in-app update flow) never has to wait out systemd's full timeout.
  setTimeout(() => process.exit(0), 3000).unref();
});
