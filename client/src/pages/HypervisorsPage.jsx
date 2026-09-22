import { useEffect, useState } from 'react';
import { Server, Plus, RefreshCw, Play, Square, RotateCw, Power, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

const emptyForm = { type: 'proxmox', name: '', url: '', username: 'root@pam', token_id: '', api_token: '' };

export default function HypervisorsPage() {
  const { user } = useAuth();
  const canEdit = ['superadmin', 'admin'].includes(user?.role);

  const [connections, setConnections] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  async function load() {
    try {
      const data = await api.get('/hypervisors/connections');
      setConnections(data.connections);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function flash(msg) {
    setMessage(msg);
    setError(null);
    setTimeout(() => setMessage(null), 4000);
  }

  function openCreate() {
    setForm({ ...emptyForm });
  }

  function openEdit(c) {
    setForm({ id: c.id, type: c.type, name: c.name, url: c.url, username: c.username, token_id: c.token_id || '', api_token: '' });
  }

  async function save(e) {
    e.preventDefault();
    try {
      if (form.id) {
        await api.put(`/hypervisors/connections/${form.id}`, form);
      } else {
        await api.post('/hypervisors/connections', form);
      }
      setForm(null);
      flash('Saved.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(c) {
    if (!confirm(`Remove connection "${c.name}"?`)) return;
    try {
      await api.del(`/hypervisors/connections/${c.id}`);
      flash('Removed.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <h1>Hypervisors</h1>
      <p className="muted">Proxmox VE — more hypervisor types arrive in later phases.</p>
      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}

      {canEdit && !form && (
        <div className="filters">
          <button onClick={openCreate}><Plus size={14} /> New connection</button>
        </div>
      )}

      {form && (
        <section className="card">
          <h2>{form.id ? 'Edit' : 'New'} connection</h2>
          <form onSubmit={save} autoComplete="off">
            <div className="form-row">
              <label>
                Name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Main Cluster" required />
              </label>
              <label>
                URL
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://proxmox.local:8006" required />
              </label>
            </div>
            <div className="form-row">
              <label>
                Username
                <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="root@pam" autoComplete="off" name="pve_user_field" />
              </label>
              <label>
                API Token ID
                <input value={form.token_id} onChange={(e) => setForm({ ...form, token_id: e.target.value })} placeholder="infraloom" autoComplete="off" name="pve_tokenid_field" />
              </label>
              <label>
                API Token Secret
                <input
                  type="password"
                  value={form.api_token}
                  onChange={(e) => setForm({ ...form, api_token: e.target.value })}
                  placeholder={form.id ? 'unchanged' : ''}
                  autoComplete="new-password"
                  name="pve_secret_field"
                />
              </label>
            </div>
            <p className="muted">
              Create a token in Proxmox under <strong>Datacenter → Permissions → API Tokens</strong> (uncheck
              "Privilege Separation" or grant it PVEAdmin/PVEVMAdmin as needed).
            </p>
            <div className="form-row">
              <button type="submit">Save</button>
              <button type="button" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {connections.length === 0 && !form && (
        <p className="muted">No hypervisor connections yet — add one above.</p>
      )}

      {connections.map((c) => (
        <ConnectionBrowser key={c.id} conn={c} canEdit={canEdit} onEdit={() => openEdit(c)} onDelete={() => remove(c)} />
      ))}
    </div>
  );
}

function UsageBar({ pct }) {
  const v = Math.min(Math.max(pct || 0, 0), 100);
  const colorClass = v > 90 ? 'usage-bar-red' : v > 75 ? 'usage-bar-yellow' : 'usage-bar-blue';
  return (
    <div className="usage-bar-row">
      <div className="usage-bar-track">
        <div className={`usage-bar-fill ${colorClass}`} style={{ width: `${v}%` }} />
      </div>
      <span className="mono muted usage-bar-pct">{v}%</span>
    </div>
  );
}

function ConnectionBrowser({ conn, canEdit, onEdit, onDelete }) {
  const [nodes, setNodes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [expandedNode, setExpandedNode] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(`/hypervisors/connections/${conn.id}/nodes`);
      setNodes(data.nodes);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id]);

  async function doAction(node, type, vmid, action) {
    setBusy(`${vmid}-${action}`);
    try {
      await api.post(`/hypervisors/connections/${conn.id}/${node}/${type}/${vmid}/${action}`);
      setTimeout(load, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card hv-connection-card">
      <div className="hv-connection-header">
        <div>
          <h2>{conn.name}</h2>
          <p className="muted mono">{conn.url}</p>
        </div>
        <div className="form-row">
          <button className="icon-btn" onClick={load} disabled={loading} title="Refresh">
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
          {canEdit && <button className="btn-link" onClick={onEdit}>Edit</button>}
          {canEdit && <button className="btn-link danger" onClick={onDelete}>Remove</button>}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {loading && !nodes && <p className="muted">Connecting...</p>}

      {nodes?.map((node) => {
        const isOpen = expandedNode === node.node;
        const guests = [...(node.vms || []), ...(node.lxc || [])];
        return (
          <div key={node.node} className="hv-node-block">
            <button
              className="hv-node-header hv-node-header-clickable"
              onClick={() => setExpandedNode(isOpen ? null : node.node)}
            >
              <ChevronRight size={16} className={`hv-node-chevron${isOpen ? ' open' : ''}`} />
              <Server size={16} />
              <strong>{node.node}</strong>
              <span className={`status-badge ${node.status === 'online' ? 'status-up' : 'status-down'}`}>{node.status}</span>
              {node.status === 'online' && (
                <span className="muted hv-node-stats">
                  CPU {node.cpu_usage}% · RAM {node.mem_used_gb}/{node.mem_max_gb} GB ({node.mem_usage}%) ·
                  Disk {node.disk_usage}% · {node.vm_count} VM, {node.lxc_count} LXC
                </span>
              )}
            </button>

            {isOpen && guests.length > 0 && (
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Type</th><th>Status</th><th>CPU</th><th>RAM</th><th>Disk</th><th>IP</th><th>OS</th><th></th></tr>
              </thead>
              <tbody>
                {guests
                  .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                  .map((vm) => (
                    <tr key={`${vm.type}-${vm.vmid}`}>
                      <td>
                        <span className={`hv-status-dot hv-status-dot-${vm.status}`} />
                        {vm.name} <span className="muted">#{vm.vmid}</span>
                      </td>
                      <td><span className={`hv-type-badge hv-type-${vm.type}`}>{vm.type === 'lxc' ? 'LXC' : 'VM'}</span></td>
                      <td><span className={`status-badge ${vm.status === 'running' ? 'status-up' : 'status-down'}`}>{vm.status}</span></td>
                      <td className="hv-usage-cell">{vm.status === 'running' ? <UsageBar pct={vm.cpu_usage} /> : <span className="muted">—</span>}</td>
                      <td className="hv-usage-cell">
                        {vm.status === 'running' ? (
                          <>
                            <UsageBar pct={vm.mem_usage} />
                            <span className="muted hv-usage-detail">{vm.mem_used_gb}/{vm.mem_max_gb} GB</span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="hv-usage-cell">
                        {vm.disk_used_gb ? (
                          <>
                            <UsageBar pct={vm.disk_usage} />
                            <span className="muted hv-usage-detail">{vm.disk_used_gb}/{vm.disk_max_gb} GB</span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="mono">{vm.ip || '—'}</td>
                      <td className="muted">{vm.os || '—'}</td>
                      <td className="actions">
                        {canEdit && (
                          <>
                            {vm.status === 'running' ? (
                              <>
                                <button className="icon-btn" title="Shutdown" disabled={busy === `${vm.vmid}-shutdown`} onClick={() => doAction(node.node, vm.type, vm.vmid, 'shutdown')}>
                                  <Power size={14} />
                                </button>
                                <button className="icon-btn" title="Reboot" disabled={busy === `${vm.vmid}-reboot`} onClick={() => doAction(node.node, vm.type, vm.vmid, 'reboot')}>
                                  <RotateCw size={14} />
                                </button>
                                <button className="icon-btn" title="Force stop" disabled={busy === `${vm.vmid}-stop`} onClick={() => doAction(node.node, vm.type, vm.vmid, 'stop')}>
                                  <Square size={14} />
                                </button>
                              </>
                            ) : (
                              <button className="icon-btn" title="Start" disabled={busy === `${vm.vmid}-start`} onClick={() => doAction(node.node, vm.type, vm.vmid, 'start')}>
                                <Play size={14} />
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            )}

            {isOpen && node.storages?.length > 0 && (
              <div className="hv-storage-row">
                {node.storages.map((s) => (
                  <span key={s.storage} className="hv-storage-chip">
                    {s.storage}: {s.used_gb || '0'}/{s.total_gb || '?'} GB {s.usage_pct != null && `(${s.usage_pct}%)`}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
