import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Dashboard is always visible, ungrouped. Everything else lives in a
// collapsible group — new modules from later phases just get added to the
// matching group's items array (or a new group, if it's a new domain).
const NAV_GROUPS = [
  {
    key: 'inventory',
    label: 'Inventory',
    items: [
      { to: '/licences', label: 'Licences' },
      { to: '/entra-apps', label: 'Entra ID Apps' },
    ],
  },
  {
    key: 'network',
    label: 'Network',
    items: [
      { to: '/monitors', label: 'Uptime Monitor' },
      { to: '/routers', label: 'Routers' },
      { to: '/switches', label: 'Switches' },
      { to: '/access-points', label: 'Access Points' },
      { to: '/dns', label: 'DNS' },
      { to: '/dns-analytics', label: 'DNS Analytics' },
      { to: '/netspeed', label: 'Net Speed' },
      { to: '/myip', label: 'MyIP' },
    ],
  },
  {
    key: 'infrastructure',
    label: 'Infrastructure',
    items: [
      { to: '/hypervisors', label: 'Hypervisors' },
      { to: '/network-scanner', label: 'Network Scanner' },
      { to: '/patch-management', label: 'Patch Management' },
      { to: '/ssh', label: 'SSH', roles: ['superadmin', 'admin'] },
    ],
  },
  {
    key: 'account',
    label: 'Account',
    items: [{ to: '/profile', label: 'Profile' }],
  },
  {
    key: 'admin',
    label: 'Admin',
    roles: ['superadmin', 'admin'],
    items: [
      { to: '/users', label: 'Users', roles: ['superadmin', 'admin'] },
      { to: '/audit-log', label: 'Audit Log', roles: ['superadmin', 'admin'] },
      { to: '/settings', label: 'Settings', roles: ['superadmin', 'admin'] },
      { to: '/update', label: 'Update', roles: ['superadmin', 'admin'] },
    ],
  },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [openGroup, setOpenGroup] = useState(null);

  // Auto-open the group containing the active route; dashboard has none.
  useEffect(() => {
    const path = location.pathname;
    if (path === '/') {
      setOpenGroup(null);
      return;
    }
    for (const group of NAV_GROUPS) {
      if (group.items.some((item) => path.startsWith(item.to))) {
        setOpenGroup(group.key);
        return;
      }
    }
  }, [location.pathname]);

  function toggleGroup(key) {
    setOpenGroup((prev) => (prev === key ? null : key));
  }

  return (
    <div className="app-shell-sidebar">
      <aside className="sidebar">
        <div className="sidebar-brand">InfraLoom</div>

        <nav className="sidebar-nav">
          <NavLink to="/" end className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
            Dashboard
          </NavLink>

          {NAV_GROUPS.map((group) => {
            const visibleItems = group.items.filter((item) => !item.roles || item.roles.includes(user?.role));
            if (visibleItems.length === 0) return null;
            if (group.roles && !group.roles.includes(user?.role)) return null;

            const isOpen = openGroup === group.key;
            const isGroupActive = visibleItems.some((item) => location.pathname.startsWith(item.to));

            return (
              <div key={group.key} className="sidebar-group">
                <button
                  className={`sidebar-group-header${isGroupActive && !isOpen ? ' active' : ''}`}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span>{group.label}</span>
                  <span className={`chevron${isOpen ? ' open' : ''}`}>▾</span>
                </button>
                {isOpen && (
                  <div className="sidebar-group-items">
                    {visibleItems.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={({ isActive }) => `sidebar-link nested${isActive ? ' active' : ''}`}
                      >
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <span className="whoami">{user?.username} · {user?.role}</span>
          <button onClick={logout} className="btn-link">Logout</button>
        </div>
      </aside>

      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
