import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useSocket } from '../hooks/useSocket';

export default function TemplatesPage() {
  const [connections, setConnections] = useState([]);
  const [connId, setConnId] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [node, setNode] = useState('');
  const [templates, setTemplates] = useState(null);
  const [images, setImages] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', imageKey: '', storage: '', cores: 2, memoryMb: 2048, bridge: 'vmbr0' });
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.get('/hypervisors/connections').then((d) => {
      const proxmoxConns = d.connections.filter((c) => c.type === 'proxmox');
      setConnections(proxmoxConns);
      if (proxmoxConns.length) setConnId(proxmoxConns[0].id);
    });
    api.get('/automation/cloud-images').then((d) => setImages(d.images));
  }, []);

  useEffect(() => {
    if (!connId) return;
    api.get(`/hypervisors/connections/${connId}/nodes`).then((d) => {
      setNodes(d.nodes || []);
      if (d.nodes?.length) setNode(d.nodes[0].node);
    }).catch(() => setNodes([]));
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  useEffect(() => {
    if (!connId || !node) return;
    setTemplates(null);
    api.get(`/automation/connections/${connId}/templates?node=${node}`).then(setTemplates).catch((err) => setError(err.message));
  }, [connId, node]);

  function loadJobs() {
    api.get(`/automation/template-jobs?connection_id=${connId}`).then((d) => setJobs(d.jobs));
  }

  async function createTemplate(e) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post(`/automation/connections/${connId}/templates`, { node, ...form });
      setShowCreate(false);
      setTimeout(loadJobs, 1000);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  useSocket({
    'template:complete': () => loadJobs(),
  });

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>Templates</h1>
        <div className="form-row">
          <button onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel' : '+ Create template from cloud image'}</button>
          <button onClick={loadJobs}><RefreshCw size={14} /></button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="filters">
        <select value={connId || ''} onChange={(e) => setConnId(parseInt(e.target.value, 10))}>
          {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={node} onChange={(e) => setNode(e.target.value)}>
          {nodes.map((n) => <option key={n.node} value={n.node}>{n.node}</option>)}
        </select>
      </div>

      {showCreate && (
        <section className="card">
          <h2>Create VM template from cloud image</h2>
          <p className="muted">
            Downloads the image to the Proxmox host, creates a VM from it, and converts it to a template — the
            same steps as doing this manually. Requires the host-level SSH credentials configured under this
            connection's "Patch Management (LXC)" settings (this reuses that same access).
          </p>
          <form onSubmit={createTemplate} autoComplete="off">
            <div className="form-row">
              <label>
                Template name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ubuntu-22.04-template" required />
              </label>
              <label>
                Cloud image
                <select value={form.imageKey} onChange={(e) => setForm({ ...form, imageKey: e.target.value })} required>
                  <option value="">Select...</option>
                  {images.map((img) => <option key={img.key} value={img.key}>{img.label}</option>)}
                </select>
              </label>
              <label>
                Storage
                <select value={form.storage} onChange={(e) => setForm({ ...form, storage: e.target.value })} required>
                  <option value="">Select...</option>
                  {templates?.storages.map((s) => (
                    <option key={s.storage} value={s.storage}>
                      {s.storage}{s.avail_gb ? ` — ${s.avail_gb} GB free` : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
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
                Network bridge
                <input value={form.bridge} onChange={(e) => setForm({ ...form, bridge: e.target.value })} />
              </label>
              <button type="submit" disabled={creating}>{creating ? 'Starting...' : 'Create'}</button>
            </div>
          </form>
        </section>
      )}

      <section className="card">
        <h2>Existing VM templates on {node}</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>VMID</th></tr></thead>
          <tbody>
            {templates?.vmTemplates.map((t) => (
              <tr key={t.vmid}><td>{t.name}</td><td className="muted">#{t.vmid}</td></tr>
            ))}
            {templates && templates.vmTemplates.length === 0 && <tr><td colSpan={2} className="muted">No templates yet on this node.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Template creation jobs</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>VMID</th><th>Status</th><th>Started</th><th></th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.name}</td>
                <td className="muted">#{j.vmid}</td>
                <td><span className="status-badge">{j.status}</span></td>
                <td className="muted">{j.created_at}</td>
                <td className="actions"><button className="btn-link" onClick={() => setActiveJob(j)}>View</button></td>
              </tr>
            ))}
            {jobs.length === 0 && <tr><td colSpan={5} className="muted">No jobs yet.</td></tr>}
          </tbody>
        </table>
      </section>

      {activeJob && <JobOutputPanel job={activeJob} onClose={() => setActiveJob(null)} />}
    </div>
  );
}

function JobOutputPanel({ job: initial, onClose }) {
  const [job, setJob] = useState(initial);
  const [output, setOutput] = useState(initial.output || '');
  const outputRef = useRef(null);

  useSocket({
    'template:output': (data) => {
      if (data.jobId === job.id) {
        setOutput((prev) => prev + data.chunk);
        setTimeout(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight), 0);
      }
    },
    'template:complete': (data) => {
      if (data.jobId === job.id) setJob((j) => ({ ...j, status: data.status }));
    },
  });

  useEffect(() => {
    if (job.status !== 'running') return;
    const interval = setInterval(async () => {
      const d = await api.get(`/automation/template-jobs/${job.id}`).catch(() => null);
      if (d) {
        setJob(d.job);
        if (d.job.output && d.job.output.length > output.length) setOutput(d.job.output);
      }
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.status, job.id]);

  return (
    <section className="card">
      <div className="page-header-row">
        <h2>{job.name} — <span className="status-badge">{job.status}</span></h2>
        <button className="icon-btn" onClick={onClose}>×</button>
      </div>
      <div ref={outputRef} className="patch-output-console"><pre>{output || 'Waiting for output...'}</pre></div>
    </section>
  );
}
