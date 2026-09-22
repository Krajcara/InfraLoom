'use strict';

const { Client: SSHClient } = require('ssh2');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const db = require('../db/database');
const { writeAuditLog } = require('../middleware/audit');

const APP_SECRET = process.env.APP_SECRET;
const COOKIE_NAME = 'infraloom_token';
const ALLOWED_ROLES = ['superadmin', 'admin'];

function authenticateSocket(socket) {
  const raw = socket.handshake.headers.cookie;
  if (!raw) return null;
  const cookies = cookie.parse(raw);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  try {
    const payload = jwt.verify(token, APP_SECRET);
    if (payload.stage !== 'full') return null;
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(payload.sid);
    if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) return null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user || !user.is_active) return null;
    if (!ALLOWED_ROLES.includes(user.role)) return null;
    return { id: user.id, username: user.username, role: user.role };
  } catch {
    return null;
  }
}

function initSshTerminal(io) {
  const nsp = io.of('/terminal');

  nsp.use((socket, next) => {
    const user = authenticateSocket(socket);
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
  });

  nsp.on('connection', (socket) => {
    let sshClient = null;
    let sshStream = null;
    let sessionLabel = null;

    socket.on('connect-ssh', (opts) => {
      const { host, port, username, password, privateKey, passphrase, label } = opts || {};
      if (!host || !username) {
        socket.emit('ssh:error', 'host and username are required');
        return;
      }
      if (!password && !privateKey) {
        socket.emit('ssh:error', 'password or private key is required');
        return;
      }

      sessionLabel = label || `${username}@${host}`;
      sshClient = new SSHClient();

      sshClient
        .on('ready', () => {
          socket.emit('ssh:ready');
          writeAuditLog({
            user_id: socket.user.id, username: socket.user.username, action: 'hypervisor.ssh_session_open',
            module: 'hypervisors', details: { target: sessionLabel }, ip_address: socket.handshake.address,
          });

          sshClient.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (err) {
              socket.emit('ssh:error', err.message);
              return;
            }
            sshStream = stream;
            stream.on('data', (data) => socket.emit('ssh:data', data.toString('utf8')));
            stream.on('close', () => {
              socket.emit('ssh:closed');
              sshClient.end();
            });
            stream.stderr.on('data', (data) => socket.emit('ssh:data', data.toString('utf8')));
          });
        })
        .on('error', (err) => {
          socket.emit('ssh:error', err.message);
        })
        .on('close', () => {
          writeAuditLog({
            user_id: socket.user.id, username: socket.user.username, action: 'hypervisor.ssh_session_close',
            module: 'hypervisors', details: { target: sessionLabel }, ip_address: socket.handshake.address,
          });
        })
        .connect({
          host, port: port || 22, username,
          password: password || undefined,
          privateKey: privateKey || undefined,
          passphrase: passphrase || undefined,
          readyTimeout: 15000,
          tryKeyboard: true,
        });
    });

    socket.on('input', (data) => {
      if (sshStream) sshStream.write(data);
    });

    socket.on('resize', ({ rows, cols }) => {
      if (sshStream && rows && cols) sshStream.setWindow(rows, cols);
    });

    socket.on('disconnect', () => {
      if (sshClient) sshClient.end();
    });
  });

  return nsp;
}

module.exports = { initSshTerminal };
