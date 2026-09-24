import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useSocket } from '../hooks/useSocket';

export default function NewDeploymentPage() {
  const [connections, setConnections] = useState([]);
  const [connId, setConnId] = useState(null);
  const [guestType, setGuestType] = useState('vm');
  const [nodes, setNodes] = useState([]);
  const [node, setNode] = useState('');
  const [templates, setTemplates] = useState(null);
  const [form, setForm] = useState({
    name: '', templateVmid: '', templateFileId: '', storage: '',
    cores: 2, memoryMb: 2048, diskGb: 20,
    networkMode: 'dhcp', address: '', gateway: '', dns: '1.1.1.1',
  });
  const [deployment, setDeployment] = useState(null);
  const [error, setError] = useState(null);
  const [planning, setPlanning] = useState(false);

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

  async function plan(e) {
    e.preventDefault();
    setPlanning(true);
    setError(null);
    try {
      const vars = {
        node, name: form.name, cores: form.cores, memoryMb: form.memoryMb, diskGb: form.diskGb, storage: form.storage,
        network: form.networkMode === 'dhcp'
          ? { mode: 'dhcp' }
          : { mode: 'static', address: form.address, gateway: form.gateway, dns: form.dns.split(',').map((s) => s.trim()).filter(Boolean) },
      };
      if (guestType === 'vm') vars.templateVmid = form.templateVmid;
      else vars.templateFileId = form.templateFileId;

      const d = await api.post('/automation/deployments', { name: form.name, guestType, connectionId: connId, vars });
      setDeployment(d.deployment);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlanning(false);
    }
  }

  if (deployment) {
    return <DeploymentPanel deployment={deployment} onClose={() => setDeployment(null)} />;
  }

  return (
    <div className="page">
      <h1>New VM / LXC</h1>
      <p className="muted">
        Provisioned via OpenTofu against the Proxmox API — a plan is generated first (nothing changes on Proxmox
        yet), then you approve before anything is actually created.
      </p>

      {error && <p className="error">{error}</p>}

      <form onSubmit={plan} autoComplete="off">
        <section className="card">
          <h2>Target</h2>
          <div className="form-row">
            <label>
              Connection
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
              Type
              <select value={guestType} onChange={(e) => setGuestType(e.target.value)}>
                <option value="vm">VM (cloned from template)</option>
                <option value="lxc">LXC container</option>
              </select>
            </label>
          </div>
        </section>

        <section className="card">
          <h2>{guestType === 'vm' ? 'VM' : 'Container'} details</h2>
          <div className="form-row">
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="my-new-vm" required />
            </label>
            {guestType === 'vm' ? (
              <label>
                Template
                <select value={form.templateVmid} onChange={(e) => setForm({ ...form, templateVmid: e.target.value })} required>
                  <option value="">Select a template...</option>
                  {templates?.vmTemplates.map((t) => <option key={t.vmid} value={t.vmid}>{t.name} (#{t.vmid})</option>)}
                </select>
              </label>
            ) : (
              <label>
                Container template
                <select value={form.templateFileId} onChange={(e) => setForm({ ...form, templateFileId: e.target.value })} required>
                  <option value="">Select a template...</option>
                  {templates && Object.entries(templates.lxcTemplatesByStorage).flatMap(([storage, tmpls]) =>
                    tmpls.map((t) => <option key={t.volid} value={t.volid}>{t.volid.split('/').pop()}</option>)
                  )}
                </select>
              </label>
            )}
          </div>
          {guestType === 'lxc' && templates && Object.values(templates.lxcTemplatesByStorage).every((t) => t.length === 0) && (
            <p className="muted">
              No LXC templates downloaded on this node yet — download one via Proxmox (Node → local (storage) →
              CT Templates → Templates) before creating a container here.
            </p>
          )}
          <div className="form-row">
            <label>
              CPU cores
              <input type="number" min="1" value={form.cores} onChange={(e) => setForm({ ...form, cores: e.target.value })} />
            </label>
            <label>
              Memory (MB)
              <input type="number" min="128" step="128" value={form.memoryMb} onChange={(e) => setForm({ ...form, memoryMb: e.target.value })} />
            </label>
            <label>
              Disk (GB)
              <input type="number" min="1" value={form.diskGb} onChange={(e) => setForm({ ...form, diskGb: e.target.value })} />
            </label>
            <label>
              Storage
              <select value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })} required>
                <option value="">Select storage...</option>
                {templates?.storages.map((s) => <option key={s.storage} value={s.storage}>{s.storage}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="card">
          <h2>Network</h2>
          <div className="form-row">
            <label>
              <input type="radio" checked={form.networkMode === 'dhcp'} onChange={() => setForm({ ...form, networkMode: 'dhcp' })} /> DHCP
            </label>
            <label>
              <input type="radio" checked={form.networkMode === 'static'} onChange={() => setForm({ ...form, networkMode: 'static' })} /> Static
            </label>
          </div>
          {form.networkMode === 'static' && (
            <div className="form-row">
              <label>
                IP address / CIDR
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="192.168.1.50/24" required />
              </label>
              <label>
                Gateway
                <input value={form.gateway} onChange={(e) => setForm({ ...form, gateway: e.target.value })} placeholder="192.168.1.1" required />
              </label>
              <label>
                DNS (comma-separated)
                <input value={form.dns} onChange={(e) => setForm({ ...form, dns: e.target.value })} placeholder="1.1.1.1, 8.8.8.8" />
              </label>
            </div>
          )}
        </section>

        <button type="submit" disabled={planning}>{planning ? 'Planning...' : 'Plan deployment'}</button>
      </form>
    </div>
  );
}

function DeploymentPanel({ deployment: initial, onClose }) {
  const [deployment, setDeployment] = useState(initial);
  const [output, setOutput] = useState(initial.apply_output || '');
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState(null);
  const outputRef = useRef(null);

  useSocket({
    'iac:started': (data) => {
      if (data.deploymentId === deployment.id) setDeployment((d) => ({ ...d, status: 'applying' }));
    },
    'iac:output': (data) => {
      if (data.deploymentId === deployment.id) {
        setOutput((prev) => prev + data.chunk);
        setTimeout(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight), 0);
      }
    },
    'iac:complete': (data) => {
      if (data.deploymentId === deployment.id) setDeployment((d) => ({ ...d, status: data.status, result_vmid: data.vmid }));
    },
  });

  useEffect(() => {
    if (deployment.status !== 'applying') return;
    const interval = setInterval(async () => {
      try {
        const d = await api.get(`/automation/deployments/${deployment.id}`);
        setDeployment(d.deployment);
        if (d.deployment.apply_output && d.deployment.apply_output.length > output.length) setOutput(d.deployment.apply_output);
      } catch {
        // transient — next tick retries
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployment.status, deployment.id]);

  async function approve() {
    setApproving(true);
    setError(null);
    try {
      await api.post(`/automation/deployments/${deployment.id}/approve`);
      setDeployment((d) => ({ ...d, status: 'applying' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setApproving(false);
    }
  }

  async function cancel() {
    try {
      await api.post(`/automation/deployments/${deployment.id}/cancel`);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>{deployment.name}</h1>
        <button onClick={onClose}>Back</button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted">Status: <strong>{deployment.status}</strong></p>

      {deployment.status === 'awaiting_approval' && (
        <>
          <section className="card">
            <h2>Plan output</h2>
            <div className="patch-output-console"><pre>{deployment.plan_output}</pre></div>
          </section>
          <div className="form-row">
            <button onClick={approve} disabled={approving}>{approving ? 'Starting...' : 'Approve & create'}</button>
            <button onClick={cancel}>Cancel</button>
          </div>
        </>
      )}

      {(deployment.status === 'applying' || deployment.status === 'completed' || deployment.status === 'failed') && (
        <section className="card">
          <h2>Apply output</h2>
          <div ref={outputRef} className="patch-output-console"><pre>{output || 'Waiting for output...'}</pre></div>
          {deployment.result_vmid && <p className="success">Created — vmid {deployment.result_vmid}</p>}
          {deployment.status === 'failed' && <p className="error">{deployment.error}</p>}
        </section>
      )}
    </div>
  );
}
