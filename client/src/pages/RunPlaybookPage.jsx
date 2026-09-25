import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useSocket } from '../hooks/useSocket';

export default function RunPlaybookPage() {
  const [playbooks, setPlaybooks] = useState([]);
  const [selectedPlaybooks, setSelectedPlaybooks] = useState(new Set());
  const [targets, setTargets] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.get('/ansible/playbooks').then((d) => setPlaybooks(d.playbooks));
    api.get('/ansible/targets').then((d) => setTargets(d.targets));
  }, []);

  function togglePlaybook(id) {
    setSelectedPlaybooks((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggle(t) {
    const key = `${t.connectionId}:${t.vmid}`;
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function check(e) {
    e.preventDefault();
    if (selectedPlaybooks.size === 0 || selected.size === 0) {
      setError('Choose at least one playbook and at least one target.');
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const guests = targets.filter((t) => selected.has(`${t.connectionId}:${t.vmid}`));
      const d = await api.post('/ansible/runs', { playbookIds: [...selectedPlaybooks], guests });
      setRun(d.run);
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  if (run) {
    return <RunPanel run={run} onClose={() => setRun(null)} />;
  }

  return (
    <div className="page">
      <h1>Run Playbook</h1>
      <p className="muted">
        Runs in <code>--check --diff</code> mode first (Ansible's own dry-run — nothing on the targets changes),
        then you approve before it runs for real. Targets need SSH credentials already saved (the same ones used
        for SSH Terminal / Patch Management) — this works for any running VM/LXC, not just ones InfraLoom created.
      </p>

      {error && <p className="error">{error}</p>}

      <form onSubmit={check} autoComplete="off">
        <section className="card">
          <h2>Playbooks ({selectedPlaybooks.size} selected — runs in the order listed below)</h2>
          <table className="table">
            <thead><tr><th></th><th>Name</th><th>Description</th></tr></thead>
            <tbody>
              {playbooks.map((pb) => (
                <tr key={pb.id}>
                  <td><input type="checkbox" checked={selectedPlaybooks.has(pb.id)} onChange={() => togglePlaybook(pb.id)} /></td>
                  <td>{pb.name}{pb.is_builtin ? ' (built-in)' : ''}</td>
                  <td className="muted">{pb.description}</td>
                </tr>
              ))}
              {playbooks.length === 0 && <tr><td colSpan={3} className="muted">No playbooks yet.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Targets ({selected.size} selected)</h2>
          <table className="table">
            <thead><tr><th></th><th>Name</th><th>Type</th><th>Node</th><th>Connection</th></tr></thead>
            <tbody>
              {targets.map((t) => {
                const key = `${t.connectionId}:${t.vmid}`;
                return (
                  <tr key={key}>
                    <td><input type="checkbox" checked={selected.has(key)} onChange={() => toggle(t)} /></td>
                    <td>{t.name}</td>
                    <td className="muted">{t.type === 'lxc' ? 'LXC' : 'VM'}</td>
                    <td className="muted">{t.node}</td>
                    <td className="muted">{t.connectionName}</td>
                  </tr>
                );
              })}
              {targets.length === 0 && <tr><td colSpan={5} className="muted">No running guests found.</td></tr>}
            </tbody>
          </table>
        </section>

        <button type="submit" disabled={checking}>{checking ? 'Checking...' : 'Check (dry-run)'}</button>
      </form>
    </div>
  );
}

function RunPanel({ run: initial, onClose }) {
  const [run, setRun] = useState(initial);
  const [output, setOutput] = useState(initial.apply_output || '');
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState(null);
  const outputRef = useRef(null);

  useSocket({
    'ansible:started': (data) => {
      if (data.runId === run.id) setRun((r) => ({ ...r, status: 'applying' }));
    },
    'ansible:output': (data) => {
      if (data.runId === run.id) {
        setOutput((prev) => prev + data.chunk);
        setTimeout(() => outputRef.current?.scrollTo(0, outputRef.current.scrollHeight), 0);
      }
    },
    'ansible:complete': (data) => {
      if (data.runId === run.id) setRun((r) => ({ ...r, status: data.status }));
    },
  });

  useEffect(() => {
    if (run.status !== 'applying') return;
    const interval = setInterval(async () => {
      const d = await api.get(`/ansible/runs/${run.id}`).catch(() => null);
      if (d) {
        setRun(d.run);
        if (d.run.apply_output && d.run.apply_output.length > output.length) setOutput(d.run.apply_output);
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, run.id]);

  async function approve() {
    setApproving(true);
    setError(null);
    try {
      await api.post(`/ansible/runs/${run.id}/approve`);
      setRun((r) => ({ ...r, status: 'applying' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setApproving(false);
    }
  }

  async function cancel() {
    try {
      await api.post(`/ansible/runs/${run.id}/cancel`);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>{run.playbook_name}</h1>
        <button onClick={onClose}>Back</button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted">Status: <strong>{run.status}</strong> · {run.target_guests.length} target(s)</p>

      {run.status === 'awaiting_approval' && (
        <>
          <section className="card">
            <h2>Check output (--check --diff, nothing changed yet)</h2>
            <div className="patch-output-console"><pre>{run.check_output}</pre></div>
          </section>
          <div className="form-row">
            <button onClick={approve} disabled={approving}>{approving ? 'Starting...' : 'Approve & run'}</button>
            <button onClick={cancel}>Cancel</button>
          </div>
        </>
      )}

      {(run.status === 'applying' || run.status === 'completed' || run.status === 'failed') && (
        <section className="card">
          <h2>Apply output</h2>
          <div ref={outputRef} className="patch-output-console"><pre>{output || 'Waiting for output...'}</pre></div>
          {run.status === 'failed' && run.error && <p className="error">{run.error}</p>}
        </section>
      )}
    </div>
  );
}
