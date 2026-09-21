import { useEffect, useState } from 'react';
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

function SortableWidget({ widget, onHide }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: widget.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="widget-card">
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
        <p className="muted">Coming in Phase {widget.phase}.</p>
      </div>
    </div>
  );
}
