import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

export default function DashboardPage() {
  const { user } = useAuth();
  const [layout, setLayout] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get('/dashboard/layout')
      .then((data) => {
        setLayout(data.layout);
        setLoaded(true);
      })
      .catch((err) => setError(err.message));
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  async function persist(nextLayout) {
    setLayout(nextLayout);
    try {
      await api.put('/dashboard/layout', {
        layout: nextLayout.map((w) => ({ id: w.id, visible: w.visible })),
      });
    } catch (err) {
      setError(err.message);
    }
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const visibleIds = layout.filter((w) => w.visible).map((w) => w.id);
    const oldIndex = visibleIds.indexOf(active.id);
    const newIndex = visibleIds.indexOf(over.id);
    const reorderedVisible = arrayMove(visibleIds, oldIndex, newIndex);

    // Rebuild the full layout: visible widgets in their new order, hidden ones kept at the end.
    const byId = Object.fromEntries(layout.map((w) => [w.id, w]));
    const hidden = layout.filter((w) => !w.visible);
    const next = [...reorderedVisible.map((id) => byId[id]), ...hidden];
    persist(next);
  }

  function toggleVisible(id) {
    const next = layout.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w));
    persist(next);
  }

  if (!loaded) return <div className="page-loading">Loading dashboard...</div>;

  const visible = layout.filter((w) => w.visible);
  const hidden = layout.filter((w) => !w.visible);

  return (
    <div className="page dashboard-page">
      <h1>Dashboard</h1>
      <p className="muted">
        Welcome, {user?.username}. Drag cards to reorder them; use the eye icon to hide a card you
        don't need. Widgets show live data as each module ships — for now they show what's coming.
      </p>
      {error && <p className="error">{error}</p>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visible.map((w) => w.id)} strategy={rectSortingStrategy}>
          <div className="dashboard-grid">
            {visible.map((widget) => (
              <SortableWidget key={widget.id} widget={widget} onHide={() => toggleVisible(widget.id)} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {hidden.length > 0 && (
        <div className="hidden-widgets">
          <h2>Hidden</h2>
          <div className="hidden-widgets-list">
            {hidden.map((w) => (
              <button key={w.id} className="btn-link" onClick={() => toggleVisible(w.id)}>
                + {w.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <footer className="dashboard-footer">Powered by Krajcara</footer>
    </div>
  );
}

// Maps a widget id to the page it should open when clicked. Only widgets
// whose module has actually shipped get an entry — the rest stay
// non-clickable until their phase lands.
const WIDGET_LINKS = {
  licences: '/licences',
  uptime: '/monitors',
  ssl: '/monitors',
  routers: '/routers',
  switches: '/switches',
  access_points: '/access-points',
  dns: '/dns',
  netspeed: '/netspeed',
  myip: '/myip',
  hypervisors: '/hypervisors',
};

function SortableWidget({ widget, onHide }) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: widget.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const link = WIDGET_LINKS[widget.id];

  function handleCardClick(e) {
    if (!link) return;
    // Don't navigate when the click originated on the drag handle or hide button.
    if (e.target.closest('.widget-drag-handle') || e.target.closest('.widget-hide')) return;
    navigate(link);
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`widget-card${link ? ' widget-card-clickable' : ''}`}
      onClick={handleCardClick}
    >
      <div className="widget-header">
        <span className="widget-drag-handle" {...attributes} {...listeners} title="Drag to reorder">
          ⠿
        </span>
        <h3>{widget.title}</h3>
        <button className="widget-hide" onClick={onHide} title="Hide this widget">
          ✕
        </button>
      </div>
      <div className="widget-body">
        {widget.id === 'licences' ? (
          <LicencesWidgetBody />
        ) : widget.id === 'uptime' ? (
          <UptimeWidgetBody />
        ) : widget.id === 'ssl' ? (
          <SslWidgetBody />
        ) : widget.id === 'routers' ? (
          <DeviceTypeWidgetBody apiPath="routers" noun="routers" />
        ) : widget.id === 'switches' ? (
          <DeviceTypeWidgetBody apiPath="switches" noun="switches" />
        ) : widget.id === 'access_points' ? (
          <DeviceTypeWidgetBody apiPath="access-points" noun="access points" />
        ) : widget.id === 'dns' ? (
          <DnsWidgetBody />
        ) : widget.id === 'netspeed' ? (
          <NetSpeedWidgetBody />
        ) : widget.id === 'myip' ? (
          <MyIpWidgetBody />
        ) : widget.id === 'hypervisors' ? (
          <HypervisorsWidgetBody />
        ) : (
          <p className="muted">Coming in Phase {widget.phase}.</p>
        )}
      </div>
    </div>
  );
}

function UptimeWidgetBody() {
  const [state, setState] = useState({ loading: true, error: null, monitors: [] });

  useEffect(() => {
    api
      .get('/monitors')
      .then((data) => setState({ loading: false, error: null, monitors: data.monitors }))
      .catch((err) => setState({ loading: false, error: err.message, monitors: [] }));
  }, []);

  if (state.loading) return <p className="muted">Loading...</p>;
  if (state.error) return <p className="error">{state.error}</p>;
  if (state.monitors.length === 0) return <p className="muted">No monitors yet.</p>;

  const down = state.monitors.filter((m) => m.enabled && m.last_status === 'down');
  return (
    <div>
      <p className={down.length === 0 ? 'success' : 'error'}>
        {down.length === 0 ? `All ${state.monitors.length} monitors up` : `${down.length} monitor(s) down`}
      </p>
      {down.length > 0 && (
        <ul className="widget-list">
          {down.slice(0, 5).map((m) => (
            <li key={m.id} className="error">{m.label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DnsWidgetBody() {
  const [state, setState] = useState({ loading: true, error: null, servers: [] });

  useEffect(() => {
    api
      .get('/dns/local')
      .then(async (servers) => {
        const withStatus = await Promise.all(
          servers.map(async (s) => {
            try {
              const st = await api.get(`/dns/local/${s.id}/status`);
              return { ...s, online: st.online };
            } catch {
              return { ...s, online: false };
            }
          })
        );
        setState({ loading: false, error: null, servers: withStatus });
      })
      .catch((err) => setState({ loading: false, error: err.message, servers: [] }));
  }, []);

  if (state.loading) return <p className="muted">Checking...</p>;
  if (state.error) return <p className="error">{state.error}</p>;
  if (state.servers.length === 0) return <p className="muted">No DNS servers configured.</p>;

  const down = state.servers.filter((s) => !s.online);
  if (down.length === 0) return <p className="success">All DNS servers online.</p>;

  return (
    <ul className="widget-list">
      {down.map((s) => (
        <li key={s.id} className="error">{s.role} ({s.ip}) — offline</li>
      ))}
    </ul>
  );
}

function NetSpeedWidgetBody() {
  const [state, setState] = useState({ loading: true, error: null, test: null });

  useEffect(() => {
    api
      .get('/netspeed/status')
      .then((data) => setState({ loading: false, error: null, test: data.last_test }))
      .catch((err) => setState({ loading: false, error: err.message, test: null }));
  }, []);

  if (state.loading) return <p className="muted">Loading...</p>;
  if (state.error) return <p className="error">{state.error}</p>;
  if (!state.test || state.test.status !== 'done') return <p className="muted">No completed tests yet.</p>;

  return (
    <p className="muted">
      ↓ {state.test.download} Mbps · ↑ {state.test.upload} Mbps · {state.test.ping}ms
    </p>
  );
}

function HypervisorsWidgetBody() {
  const [state, setState] = useState({ loading: true, error: null, byType: {}, connections: 0 });

  useEffect(() => {
    api
      .get('/hypervisors/nodes')
      .then((data) => {
        const byType = {};
        data.results.forEach((r) => {
          const key = r.connectionType || 'unknown';
          byType[key] = byType[key] || { running: 0, total: 0 };
          (r.nodes || []).forEach((n) => {
            byType[key].running += n.running_count || 0;
            byType[key].total += (n.vm_count || 0) + (n.lxc_count || 0);
          });
        });
        setState({ loading: false, error: null, byType, connections: data.results.length });
      })
      .catch((err) => setState({ loading: false, error: err.message, byType: {}, connections: 0 }));
  }, []);

  if (state.loading) return <p className="muted">Loading...</p>;
  if (state.error) return <p className="error">{state.error}</p>;
  if (state.connections === 0) return <p className="muted">No hypervisor connections yet.</p>;

  const typeLabels = { proxmox: 'Proxmox', hyperv: 'Hyper-V', esxi: 'ESXi' };

  return (
    <div>
      {Object.entries(state.byType).map(([type, counts]) => (
        <p key={type} className="muted">
          {typeLabels[type] || type}: {counts.running}/{counts.total} running
        </p>
      ))}
    </div>
  );
}

function MyIpWidgetBody() {
  const [state, setState] = useState({ loading: true, error: null, result: null });

  useEffect(() => {
    api
      .get('/myip/cards')
      .then((data) => {
        const ok = data.results.find((r) => !r.error);
        setState({ loading: false, error: null, result: ok || null });
      })
      .catch((err) => setState({ loading: false, error: err.message, result: null }));
  }, []);

  if (state.loading) return <p className="muted">Looking up...</p>;
  if (state.error) return <p className="error">{state.error}</p>;
  if (!state.result) return <p className="muted">Could not determine public IP.</p>;

  return (
    <div>
      <p className="mono myip-widget-ip">{state.result.ip}</p>
      <p className="muted">{[state.result.city, state.result.country_name].filter(Boolean).join(', ') || state.result.org}</p>
    </div>
  );
}

function DeviceTypeWidgetBody({ apiPath, noun }) {
  const [state, setState] = useState({ loading: true, error: null, down: [], total: 0 });

  useEffect(() => {
    api
      .get(`/${apiPath}`)
      .then((data) => {
        const devices = data.devices;
        setState({ loading: false, error: null, down: devices.filter((d) => d.last_status === 'down'), total: devices.length });
      })
      .catch((err) => setState({ loading: false, error: err.message, down: [], total: 0 }));
  }, [apiPath]);

  if (state.loading) return <p className="muted">Loading...</p>;
  if (state.error) return <p className="error">{state.error}</p>;
  if (state.total === 0) return <p className="muted">No {noun} yet.</p>;
  if (state.down.length === 0) return <p className="success">All {state.total} {noun} online.</p>;

  return (
    <ul className="widget-list">
      {state.down.slice(0, 5).map((d) => (
        <li key={d.id} className="error">{d.name} — offline</li>
      ))}
    </ul>
  );
}

function SslWidgetBody() {
  const [state, setState] = useState({ loading: true, error: null, expiring: [] });

  useEffect(() => {
    api
      .get('/monitors')
      .then((data) => {
        const expiring = data.monitors.filter((m) => m.ssl_days != null && m.ssl_days <= 30);
        setState({ loading: false, error: null, expiring });
      })
      .catch((err) => setState({ loading: false, error: err.message, expiring: [] }));
  }, []);

  if (state.loading) return <p className="muted">Loading...</p>;
  if (state.error) return <p className="error">{state.error}</p>;
  if (state.expiring.length === 0) return <p className="success">No certificates expiring soon.</p>;

  return (
    <ul className="widget-list">
      {state.expiring.slice(0, 5).map((m) => (
        <li key={m.id} className={m.ssl_days < 0 ? 'error' : 'warning'}>
          {m.label} — {m.ssl_days < 0 ? 'expired' : `${m.ssl_days}d left`}
        </li>
      ))}
    </ul>
  );
}

function LicencesWidgetBody() {
  const [state, setState] = useState({ loading: true, error: null, expiring: [], total: 0 });

  useEffect(() => {
    api
      .get('/licences')
      .then((data) => {
        const expiring = data.licences.filter((l) => l.expiry_status === 'expiring' || l.expiry_status === 'expired');
        setState({ loading: false, error: null, expiring, total: data.licences.length });
      })
      .catch((err) => setState({ loading: false, error: err.message, expiring: [], total: 0 }));
  }, []);

  if (state.loading) return <p className="muted">Loading...</p>;
  if (state.error) return <p className="error">{state.error}</p>;
  if (state.total === 0) return <p className="muted">No licences yet.</p>;
  if (state.expiring.length === 0) return <p className="success">All {state.total} licences are within their term.</p>;

  return (
    <ul className="widget-list">
      {state.expiring.slice(0, 5).map((l) => (
        <li key={l.id} className={l.expiry_status === 'expired' ? 'error' : 'warning'}>
          {l.vendor} {l.licence_type} — {l.expiry_status === 'expired' ? 'expired' : `${l.days_until_expiry}d left`}
        </li>
      ))}
    </ul>
  );
}
