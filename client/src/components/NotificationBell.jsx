import { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { api } from '../api';
import { useSocket } from '../hooks/useSocket';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [toasts, setToasts] = useState([]);
  const boxRef = useRef(null);

  useEffect(() => {
    api.get('/notifications/unread-count').then((d) => setUnreadCount(d.count)).catch(() => {});
  }, []);

  useSocket({
    'notification:new': (notification) => {
      setUnreadCount((c) => c + 1);
      setNotifications((prev) => [notification, ...prev].slice(0, 30));
      const toastId = notification.id ?? Date.now();
      setToasts((prev) => [...prev, { ...notification, toastId }]);
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.toastId !== toastId)), 8000);
    },
  });

  useEffect(() => {
    function onClickOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      const d = await api.get('/notifications');
      setNotifications(d.notifications);
    }
  }

  async function markRead(id) {
    await api.post(`/notifications/${id}/read`);
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
  }

  async function markAllRead() {
    await api.post('/notifications/mark-all-read');
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: 1 })));
    setUnreadCount(0);
  }

  function dismissToast(toastId) {
    setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  }

  return (
    <>
      <div className="notification-bell-wrap" ref={boxRef}>
        <button className="icon-btn notification-bell-btn" onClick={toggle} title="Notifications">
          <Bell size={18} />
          {unreadCount > 0 && <span className="notification-bell-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </button>

        {open && (
          <div className="notification-dropdown">
            <div className="notification-dropdown-header">
              <strong>Notifications</strong>
              {unreadCount > 0 && <button className="btn-link" onClick={markAllRead}>Mark all read</button>}
            </div>
            <div className="notification-dropdown-list">
              {notifications.length === 0 && <p className="muted notification-empty">No notifications.</p>}
              {notifications.map((n) => (
                <div key={n.id} className={`notification-item${n.is_read ? '' : ' unread'}`} onClick={() => !n.is_read && markRead(n.id)}>
                  <span className={`notification-dot notification-dot-${n.severity}`} />
                  <div>
                    <p className="notification-message">{n.message}</p>
                    <p className="muted notification-time">{n.created_at}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.toastId} className={`toast-item toast-${t.severity}`}>
            <span className={`notification-dot notification-dot-${t.severity}`} />
            <span className="toast-message">{t.message}</span>
            <button className="icon-btn toast-close" onClick={() => dismissToast(t.toastId)}><X size={13} /></button>
          </div>
        ))}
      </div>
    </>
  );
}
