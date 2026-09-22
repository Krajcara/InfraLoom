import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { X, Plus } from 'lucide-react';
import { useSshSessions } from '../context/SshSessionsContext';

export default function SshPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { sessions, activeId, setActiveId, addSession, closeSession, registerDock } = useSshSessions();
  const [showAddForm, setShowAddForm] = useState(false);
  const dockRef = useRef(null);

  // Dock the persistent panes into this page while it's mounted; on unmount
  // (navigating elsewhere) the provider falls back to its hidden holder —
  // the sessions themselves keep running, they just aren't visible.
  useEffect(() => {
    registerDock(dockRef.current);
    return () => registerDock(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      {showAddForm && (
        <AddSessionForm
          onAdd={(opts) => {
            addSession(opts);
            setShowAddForm(false);
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {sessions.length === 0 && !showAddForm && (
        <p className="muted">No SSH sessions yet. Open one from a VM in Hypervisors, or click "+ New" above.</p>
      )}

      <div ref={dockRef} className="ssh-dock" />
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
