import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';

export default function SshTerminalModal({ connectionId, vmid, host, defaultPort, label, onClose }) {
  const [phase, setPhase] = useState('loading'); // loading | form | connecting | connected | error
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState({ port: defaultPort || 22, username: '', password: '', remember: false });
  const [error, setError] = useState(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const containerRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    api
      .get(`/hypervisors/connections/${connectionId}/vms/${vmid}/ssh-credentials`)
      .then((data) => {
        setSaved(data.saved ? data : null);
        if (data.saved) setForm((f) => ({ ...f, port: data.port, username: data.username }));
        setPhase('form');
      })
      .catch(() => setPhase('form'));
  }, [connectionId, vmid]);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      termRef.current?.dispose();
    };
  }, []);

  async function connectWithSaved() {
    setError(null);
    setPhase('connecting');
    try {
      const creds = await api.post(`/hypervisors/connections/${connectionId}/vms/${vmid}/ssh-credentials/reveal`);
      startSession({ port: creds.port, username: creds.username, password: creds.password, privateKey: creds.private_key, passphrase: creds.passphrase });
    } catch (err) {
      setError(err.message);
      setPhase('form');
    }
  }

  async function connectManual(e) {
    e.preventDefault();
    setError(null);
    if (form.remember) {
      try {
        await api.put(`/hypervisors/connections/${connectionId}/vms/${vmid}/ssh-credentials`, {
          port: form.port, username: form.username, password: form.password,
        });
      } catch (err) {
        setError(err.message);
        return;
      }
    }
    setPhase('connecting');
    startSession({ port: form.port, username: form.username, password: form.password });
  }

  function startSession(creds) {
    const socket = io('/terminal', { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('connect-ssh', { host, port: creds.port, username: creds.username, password: creds.password, privateKey: creds.privateKey, passphrase: creds.passphrase, label: label || `${creds.username}@${host}` });
    });

    socket.on('ssh:ready', () => {
      setPhase('connected');
      setTimeout(() => {
        const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: '#0f1115' } });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current);
        fit.fit();
        termRef.current = term;
        fitRef.current = fit;

        term.onData((data) => socket.emit('input', data));
        window.addEventListener('resize', handleResize);
        function handleResize() {
          fit.fit();
          socket.emit('resize', { rows: term.rows, cols: term.cols });
        }
        socket.emit('resize', { rows: term.rows, cols: term.cols });
      }, 0);
    });

    socket.on('ssh:data', (data) => termRef.current?.write(data));

    socket.on('ssh:error', (msg) => {
      setError(msg);
      setPhase('form');
      socket.disconnect();
    });

    socket.on('ssh:closed', () => {
      termRef.current?.write('\r\n\r\n[Session closed]\r\n');
    });

    socket.on('connect_error', (err) => {
      setError(err.message === 'unauthorized' ? 'Not authorized to open a terminal.' : err.message);
      setPhase('form');
    });
  }

  function handleClose() {
    socketRef.current?.disconnect();
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <div className="modal-box ssh-modal-box" onClick={(e) => e.stopPropagation()}>
        <h2>SSH — {label || host}</h2>

        {phase === 'loading' && <p className="muted">Loading...</p>}
        {error && <p className="error">{error}</p>}

        {phase === 'form' && (
          <>
            {saved && (
              <div className="card ssh-saved-block">
                <p className="muted">Saved credentials for user <strong>{saved.username}</strong></p>
                <button onClick={connectWithSaved}>Connect with saved credentials</button>
              </div>
            )}
            <form onSubmit={connectManual} autoComplete="off">
              <p className="muted">{saved ? 'Or connect with different credentials:' : 'Enter SSH credentials:'}</p>
              <div className="form-row">
                <label>
                  Username
                  <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" name="ssh_user_field" required />
                </label>
                <label>
                  Password
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" name="ssh_pass_field" required />
                </label>
                <label>
                  Port
                  <input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
                </label>
              </div>
              <label className="checkbox-label">
                <input type="checkbox" checked={form.remember} onChange={(e) => setForm({ ...form, remember: e.target.checked })} />
                Save as default for this VM
              </label>
              <div className="form-row">
                <button type="submit">Connect</button>
                <button type="button" onClick={handleClose}>Cancel</button>
              </div>
            </form>
          </>
        )}

        {phase === 'connecting' && <p className="muted">Connecting...</p>}

        <div ref={containerRef} className={`ssh-terminal-container${phase === 'connected' ? ' visible' : ''}`} />

        {phase === 'connected' && (
          <div className="form-row ssh-modal-footer">
            <button onClick={handleClose}>Close terminal</button>
          </div>
        )}
      </div>
    </div>
  );
}
