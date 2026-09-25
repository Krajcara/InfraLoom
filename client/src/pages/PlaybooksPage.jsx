import { useEffect, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { api } from '../api';

export default function PlaybooksPage() {
  const [playbooks, setPlaybooks] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', content: '' });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);

  function load() {
    api.get('/ansible/playbooks').then((d) => setPlaybooks(d.playbooks));
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post('/ansible/playbooks', form);
      setShowCreate(false);
      setForm({ name: '', description: '', content: '' });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(pb) {
    if (!confirm(`Delete playbook "${pb.name}"?`)) return;
    try {
      await api.del(`/ansible/playbooks/${pb.id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function onFileChosen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, content: reader.result, name: f.name || file.name.replace(/\.ya?ml$/, '') }));
    reader.readAsText(file);
  }

  return (
    <div className="page">
      <div className="page-header-row">
        <h1>Playbooks</h1>
        <button onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel' : '+ New playbook'}</button>
      </div>

      {error && <p className="error">{error}</p>}

      {showCreate && (
        <section className="card">
          <h2>New playbook</h2>
          <form onSubmit={create} autoComplete="off">
            <div className="form-row">
              <label>
                Name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </label>
              <label>
                Description
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
              <button type="button" onClick={() => fileInputRef.current?.click()}><Upload size={14} /> Upload .yml</button>
              <input ref={fileInputRef} type="file" accept=".yml,.yaml" style={{ display: 'none' }} onChange={onFileChosen} />
            </div>
            <label>
              Playbook YAML
              <textarea
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                rows={16}
                className="mono"
                placeholder={'---\n- name: My playbook\n  hosts: all\n  become: true\n  tasks:\n    - name: ...\n      apt:\n        name: htop\n        state: present'}
                required
              />
            </label>
            <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save playbook'}</button>
          </form>
        </section>
      )}

      <section className="card">
        <table className="table">
          <thead><tr><th>Name</th><th>Description</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {playbooks.map((pb) => (
              <tr key={pb.id}>
                <td>{pb.name}</td>
                <td className="muted">{pb.description}</td>
                <td className="muted">{pb.is_builtin ? 'Built-in' : `Custom · ${pb.created_by}`}</td>
                <td className="actions">
                  {!pb.is_builtin && (
                    <button className="icon-btn" title="Delete" onClick={() => remove(pb)}><Trash2 size={15} /></button>
                  )}
                </td>
              </tr>
            ))}
            {playbooks.length === 0 && <tr><td colSpan={4} className="muted">No playbooks yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
