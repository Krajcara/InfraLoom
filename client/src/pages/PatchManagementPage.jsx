import { useEffect, useRef, useState, Fragment } from 'react';
import { ChevronRight, RefreshCw, Play, Check, X, Server } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../hooks/useSocket';

const HYPERVISOR_TYPE_LABELS = { proxmox: 'Proxmox VE', hyperv: 'Hyper-V', esxi: 'VMware ESXi' };
const OS_LABELS = { debian: 'Debian / Ubuntu', rhel: 'RHEL / Fedora', alpine: 'Alpine Linux', windows: 'Windows' };

export default function PatchManagementPage() {
  const { user } = useAuth();
  const canRun = ['superadmin', 'admin', 'operator'].includes(user?.role);
  const canApprove = ['superadmin', 'admin'].includes(user?.role);

  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeRun, setActiveRun] = useState(null);
  const [bulk, setBulk] = useState(null); // { batchId, completed, total }

  async function load() {
    setError(null);
    try {
      const d = await api.get('/patch-management/overview');
      setOverview(d.connections);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useSocket({
    'patch:bulk-progress': (data) => {
      setBulk({ batchId: data.batchId, completed: data.completed, total: data.total });
    },
    'patch:bulk-complete': () => {
      setTimeout(() => setBulk(null), 1500);
      load();
    },
  });

  async function checkGuest(connectionId, node, guest) {
    setError(null);
    try {
      const d = await api.post(`/patch-management/connections/${connectionId}/${node}/${guest.type}/${guest.vmid}/dry-run`, { name: guest.name, ip: guest.ip, os: guest.os });
      setActiveRun(d.run);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function checkAll(guestList) {
    if (guestList.length === 0) return;
    setError(null);
    try {
      await api.post('/patch-management/bulk-dry-run', { guests: guestList });
      setBulk({ batchId: 'starting', completed: 0, total: guestList.length });
    } catch (err) {
      setError(err.message);
    }
  }

  function openLastRun(run) {
    api.get(`/patch-management/runs/${run.id}`).then((d) => setActiveRun(d.run));
  }

  return (
    <div className="page">
      <div className="page-header-row">
        <div>
          <h1>Patch Management</h1>
          <p className="muted">Grouped by hypervisor, node, and OS. Status shown is the last known check — use "Check" to refresh it.</p>
        </div>
        <button onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {bulk && (
        <p className="muted patch-bulk-progress">
          Checking guests... {bulk.completed}/{bulk.total}
        </p>
      )}

      {loading && !overview && <p className="muted">Loading...</p>}

      {overview?.length === 0 && <p className="muted">No hypervisor connections yet — add one under Hypervisors first.</p>}

      {overview?.map((conn) => (
        <ConnectionSection
          key={conn.connectionId}
          conn={conn}
          canRun={canRun}
          canApprove={canApprove}
          onCheckGuest={checkGuest}
          onCheckAll={checkAll}
          onOpenRun={openLastRun}
        />
      ))}

      {activeRun && (
        <ActiveRunPanel
          run={activeRun}
          canApprove={canApprove}
          onClose={() => {
            setActiveRun(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function ConnectionSection({ conn, canRun, canApprove, onCheckGuest, onCheckAll, onOpenRun }) {
  const [open, setOpen] = useState(true);

  if (conn.error) {
    return (
      <section className="card">
        <button className="hv-node-header hv-node-header-clickable" onClick={() => setOpen(!open)}>
          <ChevronRight size={16} className={`hv-node-chevron${open ? ' open' : ''}`} />
          <strong>{conn.connectionName}</strong>
          <span className={`hv-type-connection-badge hv-type-connection-${conn.connectionType}`}>{HYPERVISOR_TYPE_LABELS[conn.connectionType] || conn.connectionType}</span>
        </button>
        {open && <p className="error">{conn.error}</p>}
      </section>
    );
  }

  return (
    <section className="card">
      <button className="hv-node-header hv-node-header-clickable" onClick={() => setOpen(!open)}>
        <ChevronRight size={16} className={`hv-node-chevron${open ? ' open' : ''}`} />
        <strong>{conn.connectionName}</strong>
        <span className={`hv-type-connection-badge hv-type-connection-${conn.connectionType}`}>{HYPERVISOR_TYPE_LABELS[conn.connectionType] || conn.connectionType}</span>
      </button>

      {open && !conn.supported && (
        <p className="muted patch-unsupported-note">
          Patch checking isn't implemented yet for {HYPERVISOR_TYPE_LABELS[conn.connectionType] || conn.connectionType} —
          {' '}{conn.nodes.reduce((sum, n) => sum + (n.guestCount || 0), 0)} guest(s) on this connection.
        </p>
      )}

      {open && conn.supported && conn.nodes.map((node) => (
        <NodeSection
          key={node.node}
          conn={conn}
          node={node}
          canRun={canRun}
          canApprove={canApprove}
          onCheckGuest={onCheckGuest}
          onCheckAll={onCheckAll}
          onOpenRun={onOpenRun}
        />
      ))}
    </section>
  );
}

function NodeSection({ conn, node, canRun, onCheckGuest, onCheckAll, onOpenRun }) {
  const [open, setOpen] = useState(true);

  if (!node.online) {
    return (
      <div className="hv-node-block">
        <div className="hv-node-header">
          <Server size={14} /> <strong>{node.node}</strong> <span className="muted">offline</span>
        </div>
      </div>
    );
  }

  // Group this node's guests by last-known OS family.
  const groups = {};
  for (const g of node.guests) {
    const key = g.lastRun?.os_family || 'unchecked';
    groups[key] = groups[key] || [];
    groups[key].push(g);
  }
  const groupKeys = Object.keys(groups).sort((a, b) => (a === 'unchecked' ? 1 : b === 'unchecked' ? -1 : a.localeCompare(b)));

  const allGuestsForBulk = node.guests.map((g) => ({ connectionId: conn.connectionId, node: node.node, type: g.type, vmid: g.vmid, name: g.name, ip: g.ip, os: g.os }));

  return (
    <div className="hv-node-block">
      <button className="hv-node-header hv-node-header-clickable" onClick={() => setOpen(!open)}>
        <ChevronRight size={15} className={`hv-node-chevron${open ? ' open' : ''}`} />
        <Server size={14} />
        <strong>{node.node}</strong>
        <span className="muted hv-node-stats">{node.guests.length} guest(s)</span>
        {canRun && node.guests.length > 0 && (
          <button
            className="btn-link patch-checkall-link"
            onClick={(e) => {
              e.stopPropagation();
              onCheckAll(allGuestsForBulk);
            }}
          >
            Check all on this node
          </button>
        )}
      </button>

      {open && groupKeys.map((osKey) => (
        <OsGroup
          key={osKey}
          osKey={osKey}
          guests={groups[osKey]}
          conn={conn}
          node={node}
          canRun={canRun}
          onCheckGuest={onCheckGuest}
          onCheckAll={onCheckAll}
          onOpenRun={onOpenRun}
        />
      ))}
    </div>
  );
}

function OsGroup({ osKey, guests, conn, node, canRun, onCheckGuest, onCheckAll, onOpenRun }) {
  const label = osKey === 'unchecked' ? 'Not yet checked' : OS_LABELS[osKey] || osKey;
  const guestList = guests.map((g) => ({ connectionId: conn.connectionId, node: node.node, type: g.type, vmid: g.vmid, name: g.name, ip: g.ip, os: g.os }));
  const [credGuest, setCredGuest] = useState(null);

  return (
    <div className="patch-os-group">
      <div className="patch-os-group-header">
        <span className="muted">{label}</span>
        {canRun && osKey !== 'unchecked' && (
          <button className="btn-link" onClick={() => onCheckAll(guestList)}>Check all</button>
        )}
      </div>
      <table className="table">
        <tbody>
          {guests.map((g) => (
            <Fragment key={`${g.type}-${g.vmid}`}>
              <tr>
                <td>
                  <span className={`hv-type-badge hv-type-${g.type}`}>{g.type === 'lxc' ? 'LXC' : 'VM'}</span>{' '}
                  {g.name} <span className="muted">#{g.vmid}</span>
                </td>
                <td><GuestStatusBadge lastRun={g.lastRun} /></td>
                <td className="actions">
                  {g.lastRun ? (
                    <button className="btn-link" onClick={() => onOpenRun(g.lastRun)}>View</button>
                  ) : null}
                  {canRun && (g.type === 'vm' || g.type === 'qemu') && (
                    <button className="btn-link" onClick={() => setCredGuest(credGuest === g.vmid ? null : g.vmid)}>
                      {credGuest === g.vmid ? 'Cancel' : 'Credentials'}
                    </button>
                  )}
                  {canRun && (
                    <button className="icon-btn" title="Check for updates" onClick={() => onCheckGuest(conn.connectionId, node.node, g)}>
                      <Play size={13} />
                    </button>
                  )}
                </td>
              </tr>
              {credGuest === g.vmid && (
                <tr>
                  <td colSpan={3}>
                    <GuestCredentialsForm connectionId={conn.connectionId} guest={g} onSaved={() => setCredGuest(null)} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GuestCredentialsForm({ connectionId, guest, onSaved }) {
  const knownOs = (guest.os || '').toLowerCase();
  const osKnown = knownOs.length > 0;
  const [credType, setCredType] = useState(knownOs.includes('windows') ? 'winrm' : 'ssh');
  const isWindows = credType === 'winrm';
  const [form, setForm] = useState({ host: guest.ip || '', username: '', password: '', port: isWindows ? 5985 : 22 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [pushingKey, setPushingKey] = useState(false);
  const [pushMessage, setPushMessage] = useState(null);

  useEffect(() => {
    const path = isWindows
      ? `/hypervisors/connections/${connectionId}/vms/${guest.vmid}/winrm-credentials`
      : `/hypervisors/connections/${connectionId}/vms/${guest.vmid}/ssh-credentials`;
    api.get(path).then((d) => {
      if (d.saved) setForm((f) => ({ ...f, host: d.host || f.host, username: d.username || '', port: d.port || (isWindows ? 5985 : 22) }));
      else setForm((f) => ({ ...f, port: isWindows ? 5985 : 22 }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credType]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const path = isWindows
        ? `/hypervisors/connections/${connectionId}/vms/${guest.vmid}/winrm-credentials`
        : `/hypervisors/connections/${connectionId}/vms/${guest.vmid}/ssh-credentials`;
      await api.put(path, form);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function pushKey() {
    setPushingKey(true);
    setError(null);
    setPushMessage(null);
    try {
      await api.post(`/hypervisors/connections/${connectionId}/vms/${guest.vmid}/ssh-credentials/push-key`);
      setPushMessage('Key installed — this guest now uses it instead of the saved password.');
    } catch (err) {
      setError(err.message);
    } finally {
      setPushingKey(false);
    }
  }

  return (
    <div className="patch-cred-form">
      <p className="muted">
        {isWindows ? 'WinRM' : 'SSH'} credentials for connecting directly to this guest — needed for Hyper-V VMs
        always, and for Windows VMs on Proxmox (Windows Update behaves more reliably run as a real admin account
        than via the guest agent's SYSTEM context).
      </p>
      {!osKnown && (
        <div className="form-row patch-cred-type-toggle">
          <label>
            <input type="radio" checked={!isWindows} onChange={() => setCredType('ssh')} /> Linux (SSH)
          </label>
          <label>
            <input type="radio" checked={isWindows} onChange={() => setCredType('winrm')} /> Windows (WinRM)
          </label>
        </div>
      )}
      <form onSubmit={save} autoComplete="off">
        {error && <p className="error">{error}</p>}
        <div className="form-row">
          <label>
            {isWindows ? 'WinRM host' : 'SSH host'}
            <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder={guest.ip || 'Guest IP'} />
          </label>
          <label>
            Username
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" name={`guest_cred_user_${guest.vmid}`} />
          </label>
          <label>
            Password
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" name={`guest_cred_pass_${guest.vmid}`} placeholder="unchanged" />
          </label>
          <label>
            Port
            <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
          </label>
          <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          {!isWindows && form.password && (
            <button type="button" onClick={pushKey} disabled={pushingKey}>
              {pushingKey ? 'Installing...' : 'Install management key'}
            </button>
          )}
        </div>
        {pushMessage && <p className="success">{pushMessage}</p>}
      </form>
    </div>
  );
}

function GuestStatusBadge({ lastRun }) {
  if (!lastRun) return <span className="status-badge">Not checked</span>;
  const map = {
    up_to_date: ['status-up', 'Up to date'],
    awaiting_approval: ['status-degraded', `${lastRun.packages} update(s) pending`],
    running: ['status-degraded', 'Checking/applying...'],
    completed: ['status-up', `Patched (${lastRun.packages})`],
    failed: ['status-down', 'Failed'],
    cancelled: ['', 'Cancelled'],
  };
  const [cls, label] = map[lastRun.status] || ['', lastRun.status];
  return <span className={`status-badge ${cls}`}>{label}</span>;
}

function ActiveRunPanel({ run: initialRun, canApprove, onClose }) {
  const [run, setRun] = useState(initialRun);
  const [output, setOutput] = useState(run.apply_output || '');
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState(null);
  const outputRef = useRef(null);

  useEffect(() => {
    setRun(initialRun);
    setOutput(initialRun.apply_output || '');
  }, [initialRun]);

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
        // transient — next tick retries
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
          {run.vm_name || `#${run.vmid}`} — <GuestStatusBadge lastRun={{ status: run.status, packages: run.packages_affected?.length || 0 }} />
        </h2>
        <button className="icon-btn" onClick={onClose}><X size={16} /></button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted">OS family: {run.os_family} · {run.packages_affected?.length || 0} package(s) would be updated</p>

      {(run.status === 'awaiting_approval' || run.status === 'up_to_date') && (
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
            <p className="success">No packages need updating — system is up to date.</p>
          )}
          {canApprove && run.status === 'awaiting_approval' && run.packages_affected?.length > 0 && (
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
