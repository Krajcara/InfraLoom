import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';

export default function SshTerminalPage() {
  const [params] = useSearchParams();
  const connectionId = params.get('connectionId');
  const vmid = params.get('vmid');
  const host = params.get('host');
  const label = params.get('label') || host;
  const defaultPort = parseInt(params.get('port'), 10) || 22;

  const [phase, setPhase] = useState('loading'); // loading | form | connecting | connected | error
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState({ port: defaultPort, username: '', password: '', remember: false });
  const [error, setError] = useState(null);
  const termRef = useRef(null);
  const containerRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    document.title = `SSH — ${label}`;
  }, [label]);

  useEffect(() => {
    if (!connectionId || !vmid || !host) {
      setError('Missing connection details.');
      setPhase('error');
      return;
    }
    api
      .get(`/hypervisors/connections/${connectionId}/vms/${vmid}/ssh-credentials`)
      .then((data) => {
        setSaved(data.saved ? data : null);
        if (data.saved) setForm((f) => ({ ...f, port: data.port, username: data.username }));
        setPhase('form');
      })
      .catch(() => setPhase('form'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      socket.emit('connect-ssh', { host, port: creds.port, username: creds.username, password: creds.password, privateKey: creds.privateKey, passphrase: creds.passphrase, label });
    });

    socket.on('ssh:ready', () => {
      setPhase('connected');
      setTimeout(() => {
        const term = new Terminal({ cursorBlink: true, fontSize: 14, theme: { background: '#0f1115' } });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current);
        fit.fit();
        termRef.current = term;

        term.onData((data) => socket.emit('input', data));
        function handleResize() {
          fit.fit();
          socket.emit('resize', { rows: term.rows, cols: term.cols });
        }
        window.addEventListener('resize', handleResize);
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
      termRef.current?.write('\r\n\r\n[Session closed — you can close this tab]\r\n');
    });

    socket.on('connect_error', (err) => {
      setError(err.message === 'unauthorized' ? 'Not authorized to open a terminal.' : err.message);
      setPhase('form');
    });
  }

  return (
    <div className="ssh-page">
      <div className="ssh-page-header">
        <strong>SSH — {label}</strong>
        {phase === 'connected' && <span className="status-badge status-up">connected</span>}
      </div>

      {phase === 'loading' && <p className="muted ssh-page-message">Loading...</p>}
      {error && phase !== 'connected' && <p className="error ssh-page-message">{error}</p>}

      {phase === 'form' && (
        <div className="ssh-page-form-wrap">
          {saved && (
            <div className="card ssh-saved-block">
              <p className="muted">Saved credentials for user <strong>{saved.username}</strong></p>
              <button onClick={connectWithSaved}>Connect with saved credentials</button>
            </div>
          )}
          <section className="card">
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
              <button type="submit">Connect</button>
            </form>
          </section>
        </div>
      )}

      {phase === 'connecting' && <p className="muted ssh-page-message">Connecting...</p>}

      <div ref={containerRef} className={`ssh-page-terminal${phase === 'connected' ? ' visible' : ''}`} />
    </div>
  );
}
