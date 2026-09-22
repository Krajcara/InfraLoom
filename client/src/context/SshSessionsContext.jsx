import { createContext, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { io } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';

const SshSessionsContext = createContext(null);

export function useSshSessions() {
  return useContext(SshSessionsContext);
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function SshSessionsProvider({ children }) {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [dockNode, setDockNode] = useState(null);
  const fallbackRef = useRef(null);
  const closersRef = useRef(new Map()); // sessionId -> cleanup fn, set by each pane

  function addSession(opts) {
    const id = newId();
    setSessions((prev) => [...prev, { id, ...opts }]);
    setActiveId(id);
    return id;
  }

  function closeSession(id) {
    closersRef.current.get(id)?.();
    closersRef.current.delete(id);
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setActiveId((current) => (current === id ? next[next.length - 1]?.id ?? null : current));
      return next;
    });
  }

  function registerCloser(id, fn) {
    closersRef.current.set(id, fn);
  }

  const target = dockNode || fallbackRef.current;

  return (
    <SshSessionsContext.Provider value={{ sessions, activeId, setActiveId, addSession, closeSession, registerDock: setDockNode }}>
      {children}
      {/* Always-mounted fallback so the portal target is never null even before the SSH page has ever registered a dock. */}
      <div ref={fallbackRef} className="ssh-hidden-holder" />
      {target &&
        createPortal(
          <div className="ssh-panes">
            {sessions.map((s) => (
              <SshSessionPane key={s.id} session={s} active={activeId === s.id} registerCloser={registerCloser} />
            ))}
          </div>,
          target
        )}
    </SshSessionsContext.Provider>
  );
}

function SshSessionPane({ session, active, registerCloser }) {
  const { connectionId, vmid, host, port: defaultPort, label } = session;
  const [phase, setPhase] = useState('loading'); // loading | form | connecting | connected | error
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState({ port: defaultPort || 22, username: '', password: '', remember: false });
  const [error, setError] = useState(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const containerRef = useRef(null);
  const socketRef = useRef(null);
  const initedRef = useRef(false);

  if (!initedRef.current) {
    initedRef.current = true;
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
    registerCloser(session.id, () => {
      socketRef.current?.disconnect();
      termRef.current?.dispose();
    });
  }

  // Re-fit whenever this pane becomes the visible one — covers both switching
  // tabs within the SSH page and returning to the SSH page after navigating
  // away (the portal target re-registers, but this pane never unmounted).
  if (active && fitRef.current && termRef.current) {
    requestAnimationFrame(() => {
      fitRef.current.fit();
      socketRef.current?.emit('resize', { rows: termRef.current.rows, cols: termRef.current.cols });
    });
  }

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
