import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { X, Plus } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export default function SshPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Arriving from Hypervisors with ?host=... adds one session, then clears the URL.
  useEffect(() => {
    const host = params.get('host');
    if (host) {
      addSession({
        connectionId: params.get('connectionId'),
        vmid: params.get('vmid'),
        host,
        port: parseInt(params.get('port'), 10) || 22,
        label: params.get('label') || host,
      });
      navigate('/ssh', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addSession(opts) {
    const id = newId();
    setSessions((prev) => [...prev, { id, ...opts }]);
    setActiveId(id);
    setShowAddForm(false);
  }

  function closeSession(id) {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setActiveId((current) => (current === id ? next[next.length - 1]?.id ?? null : current));
      return next;
    });
  }

  return (
    <div className="page ssh-manager-page">
      <h1>SSH Sessions</h1>

      <div className="ssh-tab-strip">
        {sessions.map((s) => (
          <button key={s.id} className={`ssh-tab${activeId === s.id ? ' active' : ''}`} onClick={() => setActiveId(s.id)}>
            {s.label}
            <span
              className="ssh-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
            >
              <X size={12} />
            </span>
          </button>
        ))}
        <button className="ssh-tab-add" onClick={() => setShowAddForm(true)}>
          <Plus size={13} /> New
        </button>
      </div>

      {showAddForm && <AddSessionForm onAdd={addSession} onCancel={() => setShowAddForm(false)} />}

      {sessions.length === 0 && !showAddForm && (
        <p className="muted">No SSH sessions yet. Open one from a VM in Hypervisors, or click "+ New" above.</p>
      )}

      <div className="ssh-panes">
        {sessions.map((s) => (
          <SshSessionPane key={s.id} session={s} active={activeId === s.id} />
        ))}
      </div>
    </div>
  );
}

function AddSessionForm({ onAdd, onCancel }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [label, setLabel] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!host.trim()) return;
    onAdd({ host: host.trim(), port: parseInt(port, 10) || 22, label: label.trim() || host.trim() });
  }

  return (
    <section className="card">
      <form onSubmit={submit} className="form-row" autoComplete="off">
        <label>
          Host
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5" required />
        </label>
        <label>
          Port
          <input type="number" value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <label>
          Label (optional)
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My server" />
        </label>
        <button type="submit">Add session</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </form>
    </section>
  );
}

function SshSessionPane({ session, active }) {
  const { connectionId, vmid, host, port: defaultPort, label } = session;
  const [phase, setPhase] = useState('loading'); // loading | form | connecting | connected | error
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState({ port: defaultPort || 22, username: '', password: '', remember: false });
  const [error, setError] = useState(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const containerRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    if (connectionId && vmid) {
      api
        .get(`/hypervisors/connections/${connectionId}/vms/${vmid}/ssh-credentials`)
        .then((data) => {
          setSaved(data.saved ? data : null);
          if (data.saved) setForm((f) => ({ ...f, port: data.port, username: data.username }));
          setPhase('form');
        })
        .catch(() => setPhase('form'));
    } else {
      setPhase('form');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      termRef.current?.dispose();
    };
  }, []);

  // Re-fit when this pane becomes the visible one (dimensions may have drifted while hidden).
  useEffect(() => {
    if (active && fitRef.current && termRef.current) {
      requestAnimationFrame(() => {
        fitRef.current.fit();
        socketRef.current?.emit('resize', { rows: termRef.current.rows, cols: termRef.current.cols });
      });
    }
  }, [active]);

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
    if (form.remember && connectionId && vmid) {
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
        fitRef.current = fit;

        term.onData((data) => socket.emit('input', data));
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

  return (
    <div className={`ssh-pane${active ? ' active' : ''}`}>
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
              <p className="muted">{saved ? 'Or connect with different credentials:' : `Enter SSH credentials for ${host}:`}</p>
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
              {connectionId && vmid && (
                <label className="checkbox-label">
                  <input type="checkbox" checked={form.remember} onChange={(e) => setForm({ ...form, remember: e.target.checked })} />
                  Save as default for this VM
                </label>
              )}
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
