import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Play, Check, X, Clock } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';

export default function PatchManagementPage() {
  const { user } = useAuth();
  const canRun = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const canApprove = ['superadmin', 'admin'].includes(user?.role);

  const [connections, setConnections] = useState([]);
  const [connId, setConnId] = useState(null);
  const [guests, setGuests] = useState([]);
  const [loadingGuests, setLoadingGuests] = useState(false);
  const [error, setError] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [checkingKey, setCheckingKey] = useState(null);

  useEffect(() => {
    api.get('/hypervisors/connections').then((d) => {
      const proxmoxConns = d.connections.filter((c) => c.type === 'proxmox');
      setConnections(proxmoxConns);
      if (proxmoxConns.length) setConnId(proxmoxConns[0].id);
    });
  }, []);

  useEffect(() => {
    if (!connId) return;
    loadGuests();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  async function loadGuests() {
    setLoadingGuests(true);
    setError(null);
    try {
      const d = await api.get(`/patch-management/connections/${connId}/guests`);
      setGuests(d.guests);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingGuests(false);
    }
  }

  async function loadHistory() {
    try {
      const d = await api.get(`/patch-management/runs?connection_id=${connId}`);
      setHistory(d.runs);
    } catch {
      // history is non-critical — leave the previous list showing on failure
    }
  }

  async function startDryRun(guest) {
    setError(null);
    const key = `${guest.type}-${guest.vmid}`;
    setCheckingKey(key);
    try {
      const d = await api.post(`/patch-management/connections/${connId}/${guest.node}/${guest.type}/${guest.vmid}/dry-run`, { name: guest.name });
      setActiveRun(d.run);
    } catch (err) {
      setError(err.message);
    } finally {
      setCheckingKey(null);
    }
  }

  return (
    <div className="page">
      <h1>Patch Management</h1>
      <p className="muted">Dry-run → approve → apply, for Linux VMs and LXC containers on Proxmox.</p>

      {connections.length === 0 ? (
        <p className="muted">No Proxmox connections configured yet — add one under Hypervisors first.</p>
      ) : (
        <>
          <div className="filters">
            {connections.length > 1 && (
              <select value={connId || ''} onChange={(e) => setConnId(parseInt(e.target.value, 10))}>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
            <button onClick={loadGuests} disabled={loadingGuests}>
              <RefreshCw size={14} className={loadingGuests ? 'spin' : ''} /> Refresh guests
            </button>
          </div>

          {error && <p className="error">{error}</p>}

          <section className="card">
            <h2>Running guests</h2>
            <table className="table">
              <thead><tr><th>Name</th><th>Type</th><th>Node</th><th>IP</th><th></th></tr></thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={`${g.type}-${g.vmid}`}>
                    <td>{g.name} <span className="muted">#{g.vmid}</span></td>
                    <td><span className={`hv-type-badge hv-type-${g.type}`}>{g.type === 'lxc' ? 'LXC' : 'VM'}</span></td>
                    <td className="muted">{g.node}</td>
                    <td className="mono">{g.ip || '—'}</td>
                    <td className="actions">
                      {canRun && (
                        <button onClick={() => startDryRun(g)} disabled={checkingKey === `${g.type}-${g.vmid}`}>
                          <Play size={13} /> {checkingKey === `${g.type}-${g.vmid}` ? 'Checking... (this can take up to a minute)' : 'Check for updates'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {guests.length === 0 && !loadingGuests && (
                  <tr><td colSpan={5} className="muted">No running guests found on this connection.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          {activeRun && (
            <ActiveRunPanel
              run={activeRun}
              canApprove={canApprove}
              onClose={() => {
                setActiveRun(null);
                loadHistory();
              }}
            />
          )}

          <HistorySection history={history} onOpen={setActiveRun} onRefresh={loadHistory} />
        </>
      )}
    </div>
  );
}

function ActiveRunPanel({ run: initialRun, canApprove, onClose }) {
  const [run, setRun] = useState(initialRun);
  const [output, setOutput] = useState(run.apply_output || '');
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState(null);
  const outputRef = useRef(null);

  useSocket({
    'patch:started': (data) => {
      if (data.runId === run.id) setRun((r) => ({ ...r, status: 'running' }));
    },
    'patch:output': (data) => {
      if (data.runId === run.id) {
        setOutput((prev) => prev + data.chunk);
        setTimeout(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight), 0);
      }
    },
    'patch:complete': (data) => {
      if (data.runId === run.id) setRun((r) => ({ ...r, status: data.status }));
    },
  });

  useEffect(() => {
    if (run.status !== 'running') return;
    const interval = setInterval(async () => {
      try {
        const d = await api.get(`/patch-management/runs/${run.id}`);
        setRun((r) => ({ ...r, status: d.run.status }));
        if (d.run.apply_output && d.run.apply_output.length > output.length) {
          setOutput(d.run.apply_output);
          setTimeout(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight), 0);
        }
      } catch {
        // transient — the next tick will retry
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, run.id]);

  async function approve() {
    setApproving(true);
    setError(null);
    try {
      await api.post(`/patch-management/runs/${run.id}/approve`);
      setRun((r) => ({ ...r, status: 'running' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setApproving(false);
    }
  }

  async function cancel() {
    try {
      await api.post(`/patch-management/runs/${run.id}/cancel`);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card patch-active-panel">
      <div className="page-header-row">
        <h2>
          {run.vm_name || `#${run.vmid}`} — <StatusChip status={run.status} />
        </h2>
        <button className="icon-btn" onClick={onClose}><X size={16} /></button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted">OS family: {run.os_family} · {run.packages_affected?.length || 0} package(s) would be updated</p>

      {run.status === 'awaiting_approval' && (
        <>
          {run.packages_affected?.length > 0 ? (
            <table className="table">
              <thead><tr><th>Package</th><th>Current</th><th>New</th></tr></thead>
              <tbody>
                {run.packages_affected.map((p, i) => (
                  <tr key={i}>
                    <td>{p.name}</td>
                    <td className="muted mono">{p.current_version || '—'}</td>
                    <td className="mono">{p.new_version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No packages need updating — system is up to date.</p>
          )}
          {canApprove && run.packages_affected?.length > 0 && (
            <div className="form-row">
              <button onClick={approve} disabled={approving}><Check size={14} /> {approving ? 'Starting...' : 'Approve & apply'}</button>
              <button onClick={cancel}>Cancel</button>
            </div>
          )}
        </>
      )}

      {(run.status === 'running' || run.status === 'completed' || run.status === 'failed') && (
        <div ref={outputRef} className="patch-output-console">
          <pre>{output || 'Waiting for output...'}</pre>
        </div>
      )}
    </section>
  );
}

function StatusChip({ status }) {
  const map = {
    awaiting_approval: ['status-degraded', 'Awaiting approval'],
    running: ['status-degraded', 'Running'],
    completed: ['status-up', 'Completed'],
    failed: ['status-down', 'Failed'],
    cancelled: ['', 'Cancelled'],
  };
  const [cls, label] = map[status] || ['', status];
  return <span className={`status-badge ${cls}`}>{label}</span>;
}

function HistorySection({ history, onOpen, onRefresh }) {
  return (
    <section className="card">
      <div className="page-header-row">
        <h2>History</h2>
        <button className="icon-btn" onClick={onRefresh}><RefreshCw size={14} /></button>
      </div>
      <table className="table">
        <thead><tr><th>Guest</th><th>OS</th><th>Status</th><th>Packages</th><th>Triggered by</th><th>Started</th><th></th></tr></thead>
        <tbody>
          {history.map((r) => (
            <tr key={r.id}>
              <td>{r.vm_name || `#${r.vmid}`}</td>
              <td className="muted">{r.os_family}</td>
              <td><StatusChip status={r.status} /></td>
              <td>{r.packages_affected?.length || 0}</td>
              <td className="muted">{r.triggered_by}</td>
              <td className="muted"><Clock size={11} /> {r.created_at}</td>
              <td className="actions">
                <button className="btn-link" onClick={() => onOpen(r)}>View</button>
              </td>
            </tr>
          ))}
          {history.length === 0 && <tr><td colSpan={7} className="muted">No patch runs yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
