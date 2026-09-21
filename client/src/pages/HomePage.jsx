import { useAuth } from '../context/AuthContext';

export default function HomePage() {
  const { user } = useAuth();

  return (
    <div className="page">
      <h1>Welcome, {user?.username}</h1>
      <p className="muted">
        The full Dashboard is built in Phase 3. For now, use the top navigation to manage your
        profile{user?.role === 'superadmin' || user?.role === 'admin' ? ' or users' : ''}.
      </p>
    </div>
  );
}
