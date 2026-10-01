import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

function nodeLabels(controlPlaneCount, workerCount) {
  const labels = [];
  for (let i = 0; i < controlPlaneCount; i++) labels.push(`Control-plane ${i + 1}`);
  for (let i = 0; i < workerCount; i++) labels.push(`Worker ${i + 1}`);
  return labels;
}

function bumpIp(cidr, n) {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return '';
  const [, a, b, c, d, prefix] = m;
  const last = parseInt(d, 10) + n;
  if (last > 254) return '';
  return `${a}.${b}.${c}.${last}/${prefix}`;
}

export default function NewK8sClusterPage() {
  const [connections, setConnections] = useState([]);
  const [connId, setConnId] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [node, setNode] = useState('');
  const [templates, setTemplates] = useState(null);
  const [form, setForm] = useState({
    name: '', templateVmid: '', storage: '',
    cores: 2, memoryMb: 4096, diskGb: 20,
    startingAddress: '', gateway: '', dns: '1.1.1.1',
    controlPlaneCount: 1, workerCount: 2,
    nodeIps: [], // one CIDR string per node, control-planes first then workers — index matches nodeLabels()
    nodeVmids: [], // one optional VMID string per node, same index/order as nodeIps — blank entries auto-assign
    nodeNames: [], // one optional name per node, same index/order — blank entries fall back to "{cluster}-cp-N" / "{cluster}-worker-N"
    nodeSshUsernames: [], // one optional username per node — blank entries default to "infraloom"
    nodeSshPasswords: [], // one optional password per node — InfraLoom's own management SSH key is always added too, this is in addition to it
  });
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/hypervisors/connections').then((d) => {
      const proxmoxConns = d.connections.filter((c) => c.type === 'proxmox');
      setConnections(proxmoxConns);
      if (proxmoxConns.length) setConnId(proxmoxConns[0].id);
    });
  }, []);

  useEffect(() => {
    if (!connId) return;
    api.get(`/hypervisors/connections/${connId}/nodes`).then((d) => {
      setNodes(d.nodes || []);
      if (d.nodes?.length) setNode(d.nodes[0].node);
    }).catch(() => setNodes([]));
  }, [connId]);

  useEffect(() => {
    if (!connId || !node) return;
    setTemplates(null);
    api.get(`/automation/connections/${connId}/templates?node=${node}`).then(setTemplates).catch((err) => setError(err.message));
  }, [connId, node]);

  useEffect(() => {
    const total = (parseInt(form.controlPlaneCount, 10) || 0) + (parseInt(form.workerCount, 10) || 0);
    setForm((f) => {
      const nextIps = f.nodeIps.slice(0, total);
      while (nextIps.length < total) nextIps.push('');
      const nextVmids = f.nodeVmids.slice(0, total);
      while (nextVmids.length < total) nextVmids.push('');
      const nextNames = f.nodeNames.slice(0, total);
      while (nextNames.length < total) nextNames.push('');
      const nextSshUsers = f.nodeSshUsernames.slice(0, total);
      while (nextSshUsers.length < total) nextSshUsers.push('');
      const nextSshPasswords = f.nodeSshPasswords.slice(0, total);
      while (nextSshPasswords.length < total) nextSshPasswords.push('');
      return { ...f, nodeIps: nextIps, nodeVmids: nextVmids, nodeNames: nextNames, nodeSshUsernames: nextSshUsers, nodeSshPasswords: nextSshPasswords };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.controlPlaneCount, form.workerCount]);

  function autoFillIps() {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(form.startingAddress)) {
      setError('Enter a valid starting IP/CIDR first, e.g. 10.1.0.50/24.');
      return;
    }
    setError(null);
    const total = form.nodeIps.length;
    setForm((f) => ({ ...f, nodeIps: Array.from({ length: total }, (_, i) => bumpIp(f.startingAddress, i)) }));
  }

  function setNodeIp(index, value) {
    setForm((f) => {
      const next = [...f.nodeIps];
      next[index] = value;
      return { ...f, nodeIps: next };
    });
  }

  function setNodeVmid(index, value) {
    setForm((f) => {
      const next = [...f.nodeVmids];
      next[index] = value;
      return { ...f, nodeVmids: next };
    });
  }

  function setNodeName(index, value) {
    setForm((f) => {
      const next = [...f.nodeNames];
      next[index] = value;
      return { ...f, nodeNames: next };
    });
  }

  function setNodeSshUsername(index, value) {
    setForm((f) => {
      const next = [...f.nodeSshUsernames];
      next[index] = value;
      return { ...f, nodeSshUsernames: next };
    });
  }

  function setNodeSshPassword(index, value) {
    setForm((f) => {
      const next = [...f.nodeSshPasswords];
      next[index] = value;
      return { ...f, nodeSshPasswords: next };
    });
  }

  async function start(e) {
    e.preventDefault();
    const cidrPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
    const badIp = form.nodeIps.find((ip) => !cidrPattern.test(ip));
    if (badIp !== undefined) {
      setError('Every node needs a valid IP/CIDR, e.g. 10.1.0.50/24 — one is missing or invalid.');
      return;
    }
    const usedVmids = templates?.usedVmids || [];
    const enteredVmids = form.nodeVmids.filter(Boolean).map((v) => parseInt(v, 10));
    const collision = enteredVmids.find((v) => usedVmids.includes(v));
    if (collision !== undefined) {
      setError(`VMID ${collision} is already in use on this node — choose another or leave it blank to auto-assign.`);
      return;
    }
    const dupe = enteredVmids.find((v, i) => enteredVmids.indexOf(v) !== i);
    if (dupe !== undefined) {
      setError(`VMID ${dupe} is entered for more than one node — each node needs a unique VMID.`);
      return;
    }
    const enteredNames = form.nodeNames.filter(Boolean);
    const dupeName = enteredNames.find((n, i) => enteredNames.indexOf(n) !== i);
    if (dupeName) {
      setError(`Name "${dupeName}" is entered for more than one node — each node needs a unique name.`);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const d = await api.post('/kubernetes/clusters', {
        name: form.name, connectionId: connId, node, storage: form.storage, templateVmid: parseInt(form.templateVmid, 10),
        cores: form.cores, memoryMb: form.memoryMb, diskGb: form.diskGb,
        network: { gateway: form.gateway, dns: form.dns.split(',').map((s) => s.trim()).filter(Boolean) },
        nodeIps: form.nodeIps,
        nodeVmids: form.nodeVmids.map((v) => (v ? parseInt(v, 10) : null)),
        nodeNames: form.nodeNames.map((n) => n.trim() || null),
        nodeSshUsernames: form.nodeSshUsernames.map((u) => u.trim() || null),
        nodeSshPasswords: form.nodeSshPasswords.map((p) => p || null),
        controlPlaneCount: form.controlPlaneCount, workerCount: form.workerCount,
      });
      navigate(`/kubernetes/clusters/${d.clusterId}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  const totalNodes = (parseInt(form.controlPlaneCount, 10) || 0) + (parseInt(form.workerCount, 10) || 0);

  return (
    <div className="page">
      <h1>New Kubernetes Cluster</h1>
      <p className="muted">
        Creates control-plane and worker VMs via the same OpenTofu flow used for single VMs, installs k3s over SSH,
        joins the workers, and registers the cluster for monitoring automatically. Static IPs are required — each
        node gets the starting IP address, incremented by one per node (control-plane nodes first, then workers).
      </p>

      {error && <p className="error">{error}</p>}

      <form onSubmit={start} autoComplete="off">
        <section className="card">
          <h2>Where</h2>
          <div className="form-row">
            <label>
              Proxmox connection
              <select value={connId || ''} onChange={(e) => setConnId(parseInt(e.target.value, 10))}>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>
              Node
              <select value={node} onChange={(e) => setNode(e.target.value)}>
                {nodes.map((n) => <option key={n.node} value={n.node}>{n.node}</option>)}
              </select>
            </label>
            <label>
              Storage
              <select value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })}>
                <option value="">Select...</option>
                {templates?.storages.map((s) => (
                  <option key={s.storage} value={s.storage}>{s.storage} — {s.avail_gb} GB free</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Base template (cloud image)
            <select value={form.templateVmid} onChange={(e) => setForm({ ...form, templateVmid: e.target.value })}>
              <option value="">Select...</option>
              {templates?.vmTemplates.map((t) => <option key={t.vmid} value={t.vmid}>{t.name} (#{t.vmid})</option>)}
            </select>
          </label>
        </section>

        <section className="card">
          <h2>Cluster shape</h2>
          <label>
            Cluster name (used as a prefix for each node's VM name)
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="prod-k8s" required />
          </label>
          <div className="form-row">
            <label>
              Control-plane nodes
              <input type="number" min="1" value={form.controlPlaneCount} onChange={(e) => setForm({ ...form, controlPlaneCount: parseInt(e.target.value, 10) || 1 })} />
            </label>
            <label>
              Worker nodes
              <input type="number" min="0" value={form.workerCount} onChange={(e) => setForm({ ...form, workerCount: parseInt(e.target.value, 10) || 0 })} />
            </label>
          </div>
          <p className="muted">{totalNodes} VM{totalNodes !== 1 ? 's' : ''} will be created.</p>
        </section>

        <section className="card">
          <h2>Per-node resources (applied to every node)</h2>
          <div className="form-row">
            <label>CPU cores<input type="number" value={form.cores} onChange={(e) => setForm({ ...form, cores: parseInt(e.target.value, 10) })} /></label>
            <label>Memory (MB)<input type="number" value={form.memoryMb} onChange={(e) => setForm({ ...form, memoryMb: parseInt(e.target.value, 10) })} /></label>
            <label>Disk (GB)<input type="number" value={form.diskGb} onChange={(e) => setForm({ ...form, diskGb: parseInt(e.target.value, 10) })} /></label>
          </div>
        </section>

        <section className="card">
          <h2>Network (static IPs required)</h2>
          <div className="form-row">
            <label>
              Gateway
              <input value={form.gateway} onChange={(e) => setForm({ ...form, gateway: e.target.value })} placeholder="10.1.0.1" required />
            </label>
            <label>
              DNS (comma-separated)
              <input value={form.dns} onChange={(e) => setForm({ ...form, dns: e.target.value })} />
            </label>
          </div>

          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <label>
              Starting IP / CIDR (optional — fills the fields below sequentially)
              <input value={form.startingAddress} onChange={(e) => setForm({ ...form, startingAddress: e.target.value })} placeholder="10.1.0.50/24" />
            </label>
            <button type="button" onClick={autoFillIps}>Auto-fill IPs below</button>
          </div>

          <p className="muted">
            Each node's name, IP address, VMID, and SSH login. InfraLoom's own management SSH key is always added
            regardless (used for provisioning) — the username/password here are for your own direct access.
          </p>
          {nodeLabels(form.controlPlaneCount, form.workerCount).map((label, i) => (
            <div key={i}>
              <div className="form-row">
                <label>
                  {label} — Name
                  <input
                    value={form.nodeNames[i] || ''}
                    onChange={(e) => setNodeName(i, e.target.value)}
                    placeholder={`${form.name || 'cluster'}-${label.toLowerCase().replace(' ', '-')}`}
                  />
                </label>
                <label>
                  {label} — IP
                  <input value={form.nodeIps[i] || ''} onChange={(e) => setNodeIp(i, e.target.value)} placeholder="10.1.0.50/24" required />
                </label>
                <label>
                  {label} — VMID
                  <input
                    type="number" min="100"
                    value={form.nodeVmids[i] || ''}
                    onChange={(e) => setNodeVmid(i, e.target.value)}
                    placeholder="auto-assign"
                  />
                  {form.nodeVmids[i] && templates?.usedVmids.includes(parseInt(form.nodeVmids[i], 10)) && (
                    <span className="error">Already in use on this node</span>
                  )}
                </label>
              </div>
              <div className="form-row">
                <label>
                  {label} — SSH username
                  <input
                    value={form.nodeSshUsernames[i] || ''}
                    onChange={(e) => setNodeSshUsername(i, e.target.value)}
                    placeholder="infraloom"
                  />
                </label>
                <label>
                  {label} — SSH password (optional)
                  <input
                    type="password"
                    value={form.nodeSshPasswords[i] || ''}
                    onChange={(e) => setNodeSshPassword(i, e.target.value)}
                    placeholder="leave blank for key-only"
                    autoComplete="new-password"
                  />
                </label>
              </div>
            </div>
          ))}
        </section>

        <button type="submit" disabled={starting}>{starting ? 'Starting...' : `Create cluster (${totalNodes} nodes)`}</button>
      </form>
    </div>
  );
}


