import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">InfraLoom</span>
        <nav className="topnav">
          <Link to="/">Dashboard</Link>
          <Link to="/licences">Licences</Link>
          <Link to="/entra-apps">Entra ID Apps</Link>
          {user && (user.role === 'superadmin' || user.role === 'admin') && (
            <>
              <Link to="/users">Users</Link>
              <Link to="/audit-log">Audit Log</Link>
              <Link to="/settings">Settings</Link>
            </>
          )}
          <Link to="/profile">Profile</Link>
        </nav>
        <div className="topbar-right">
          {user && <span className="whoami">{user.username} · {user.role}</span>}
          {user && <button onClick={logout} className="btn-link">Logout</button>}
        </div>
      </header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
