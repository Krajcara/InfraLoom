import { useEffect, useRef, useState } from 'react';
import { Trash2, Upload, Pencil } from 'lucide-react';
import { api } from '../api';

const emptyForm = { name: '', description: '', content: '', port: '' };

export default function PlaybooksPage() {
  const [playbooks, setPlaybooks] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);

  function load() {
    api.get('/ansible/playbooks').then((d) => setPlaybooks(d.playbooks));
  }

  useEffect(() => {
    load();
  }, []);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
    setError(null);
  }

  async function openEdit(pb) {
    setError(null);
    try {
      const d = await api.get(`/ansible/playbooks/${pb.id}`);
      setEditingId(pb.id);
      setForm({ name: d.playbook.name, description: d.playbook.description || '', content: d.playbook.content, port: d.playbook.port || '' });
      setShowForm(true);
    } catch (err) {
      setError(err.message);
    }
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editingId) await api.put(`/ansible/playbooks/${editingId}`, form);
      else await api.post('/ansible/playbooks', form);
      closeForm();
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
        <button onClick={() => (showForm ? closeForm() : openCreate())}>{showForm ? 'Cancel' : '+ New playbook'}</button>
      </div>

      {error && <p className="error">{error}</p>}

      {showForm && (
        <section className="card">
          <h2>{editingId ? 'Edit playbook' : 'New playbook'}</h2>
          <form onSubmit={save} autoComplete="off">
            <div className="form-row">
              <label>
                Name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </label>
              <label>
                Description
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
              <label>
                Port (optional, informational)
                <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="e.g. 80, 8080" />
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
            <button type="submit" disabled={saving}>{saving ? 'Saving...' : editingId ? 'Save changes' : 'Save playbook'}</button>
          </form>
        </section>
      )}

      <section className="card">
        <table className="table">
          <thead><tr><th>Name</th><th>Description</th><th>Port</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {playbooks.map((pb) => (
              <tr key={pb.id}>
                <td>{pb.name}</td>
                <td className="muted">{pb.description}</td>
                <td className="muted">{pb.port || '—'}</td>
                <td className="muted">{pb.is_builtin ? 'Built-in' : `Custom · ${pb.created_by}`}</td>
                <td className="actions">
                  {!pb.is_builtin && (
                    <>
                      <button className="icon-btn" title="Edit" onClick={() => openEdit(pb)}><Pencil size={15} /></button>
                      <button className="icon-btn" title="Delete" onClick={() => remove(pb)}><Trash2 size={15} /></button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {playbooks.length === 0 && <tr><td colSpan={5} className="muted">No playbooks yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
