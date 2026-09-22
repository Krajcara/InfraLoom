import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server, Plus, RefreshCw, Play, Square, RotateCw, Power, ChevronRight, TerminalSquare, MonitorSmartphone } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

const emptyForm = { type: 'proxmox', name: '', url: '', username: 'root@pam', token_id: '', api_token: '', password: '', port: '' };

const HYPERVISOR_TYPE_LABELS = { proxmox: 'Proxmox VE', hyperv: 'Hyper-V', esxi: 'VMware ESXi' };

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
    setForm({ id: c.id, type: c.type, name: c.name, url: c.url, username: c.username, token_id: c.token_id || '', api_token: '', password: '', port: c.port || '' });
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
      <p className="muted">Proxmox VE, Hyper-V, and VMware ESXi.</p>
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
                Type
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} disabled={!!form.id}>
                  <option value="proxmox">Proxmox VE</option>
                  <option value="esxi">VMware ESXi</option>
                  <option value="hyperv">Hyper-V</option>
                </select>
              </label>
              <label>
                Name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Main Cluster" required />
              </label>
              <label>
                {form.type === 'hyperv' ? 'Host / IP' : 'URL'}
                <input
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder={form.type === 'proxmox' ? 'https://proxmox.local:8006' : form.type === 'esxi' ? 'https://esxi.local' : '192.168.1.50'}
                  required
                />
              </label>
            </div>
            {form.type === 'proxmox' ? (
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
            ) : (
              <div className="form-row">
                <label>
                  Username
                  <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder={form.type === 'hyperv' ? 'Administrator' : 'root'} autoComplete="off" name="hv_user_field" required />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder={form.id ? 'unchanged' : ''}
                    autoComplete="new-password"
                    name="hv_pass_field"
                    required={!form.id}
                  />
                </label>
                <label>
                  Port (optional)
                  <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder={form.type === 'hyperv' ? '5985' : '443'} />
                </label>
              </div>
            )}
            {form.type === 'proxmox' && (
              <p className="muted">
                Create a token in Proxmox under <strong>Datacenter → Permissions → API Tokens</strong> (uncheck
                "Privilege Separation" or grant it PVEAdmin/PVEVMAdmin as needed).
              </p>
            )}
            {form.type === 'hyperv' && (
              <p className="muted">
                Requires WinRM enabled on the host (<code>winrm quickconfig</code>) and the user must be a local
                administrator. Uses HTTP port 5985 by default.
              </p>
            )}
            {form.type === 'esxi' && (
              <p className="muted">
                Requires ESXi 7.0+ for the REST API used here. Standard root/administrative credentials.
              </p>
            )}
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

function downloadRdp(host, username) {
  const lines = [`full address:s:${host}:3389`];
  if (username) lines.push(`username:s:${username}`);
  lines.push('prompt for credentials:i:1', 'authentication level:i:0');
  const blob = new Blob([lines.join('\n')], { type: 'application/rdp' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${host}.rdp`;
  a.click();
  URL.revokeObjectURL(url);
}

function ConnectionBrowser({ conn, canEdit, onEdit, onDelete }) {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [expandedNode, setExpandedNode] = useState(null);
  const [nodeDetail, setNodeDetail] = useState({}); // { [nodeName]: { vms, lxc, storages } | 'loading' | error string }

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

  async function loadNodeDetail(nodeName) {
    setNodeDetail((prev) => ({ ...prev, [nodeName]: 'loading' }));
    try {
      const data = await api.get(`/hypervisors/connections/${conn.id}/nodes/${nodeName}`);
      setNodeDetail((prev) => ({ ...prev, [nodeName]: data }));
    } catch (err) {
      setNodeDetail((prev) => ({ ...prev, [nodeName]: { error: err.message } }));
    }
  }

  function toggleNode(nodeName) {
    if (expandedNode === nodeName) {
      setExpandedNode(null);
      return;
    }
    setExpandedNode(nodeName);
    if (!nodeDetail[nodeName] || nodeDetail[nodeName]?.error) {
      loadNodeDetail(nodeName);
    }
  }

  async function doAction(node, type, vmid, action) {
    setBusy(`${vmid}-${action}`);
    try {
      await api.post(`/hypervisors/connections/${conn.id}/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmid)}/${action}`);
      setTimeout(() => loadNodeDetail(node), 1500);
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
          <h2>
            {conn.name} <span className={`hv-type-connection-badge hv-type-connection-${conn.type}`}>{HYPERVISOR_TYPE_LABELS[conn.type] || conn.type}</span>
          </h2>
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
        const detail = nodeDetail[node.node];
        const detailLoading = detail === 'loading';
        const detailError = detail && typeof detail === 'object' && detail.error;
        const guests = detail && typeof detail === 'object' && !detail.error ? [...(detail.vms || []), ...(detail.lxc || [])] : [];
        return (
          <div key={node.node} className="hv-node-block">
            <button
              className="hv-node-header hv-node-header-clickable"
              onClick={() => toggleNode(node.node)}
            >
              <ChevronRight size={16} className={`hv-node-chevron${isOpen ? ' open' : ''}`} />
              <Server size={16} />
              <strong>{node.node}</strong>
              <span className={`status-badge ${node.status === 'online' ? 'status-up' : 'status-down'}`}>{node.status}</span>
              {node.status === 'online' && (
                <span className="muted hv-node-stats">
                  {node.cpu_usage != null && <>CPU {node.cpu_usage}% · </>}
                  {node.mem_max_gb != null && <>RAM {node.mem_used_gb}/{node.mem_max_gb} GB ({node.mem_usage}%) · </>}
                  {node.disk_usage != null && <>Disk {node.disk_usage}% · </>}
                  {node.vm_count} VM, {node.lxc_count} LXC
                </span>
              )}
            </button>

            {isOpen && detailLoading && <p className="muted hv-node-detail-loading">Loading VMs and containers...</p>}
            {isOpen && detailError && <p className="error hv-node-detail-loading">{detailError}</p>}

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
                      <td className="hv-usage-cell">{vm.status === 'running' && vm.cpu_usage != null ? <UsageBar pct={vm.cpu_usage} /> : <span className="muted">—</span>}</td>
                      <td className="hv-usage-cell">
                        {vm.status === 'running' && vm.mem_usage != null ? (
                          <>
                            <UsageBar pct={vm.mem_usage} />
                            <span className="muted hv-usage-detail">{vm.mem_used_gb}/{vm.mem_max_gb} GB</span>
                          </>
                        ) : vm.mem_max_gb ? (
                          <span className="muted hv-usage-detail">{vm.mem_used_gb ?? '?'}/{vm.mem_max_gb} GB</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="hv-usage-cell">
                        {vm.disk_used_gb && vm.disk_usage != null ? (
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
                        {canEdit && vm.status === 'running' && vm.ip && (
                          <>
                            {(vm.os || '').toLowerCase().includes('windows') ? (
                              <button className="icon-btn" title="Connect via RDP (downloads .rdp file)" onClick={() => downloadRdp(vm.ip)}>
                                <MonitorSmartphone size={14} />
                              </button>
                            ) : (
                              <button className="icon-btn" title="Open SSH session" onClick={() => navigate(`/ssh?${new URLSearchParams({ connectionId: conn.id, vmid: vm.vmid, host: vm.ip, label: `${vm.name} (${vm.ip})` }).toString()}`)}>
                                <TerminalSquare size={14} />
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

            {isOpen && detail?.storages?.length > 0 && (
              <div className="hv-storage-row">
                {detail.storages.map((s) => (
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
