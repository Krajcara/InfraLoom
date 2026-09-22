import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ProfilePage from './pages/ProfilePage';
import UsersPage from './pages/UsersPage';
import SettingsPage from './pages/SettingsPage';
import UpdatePage from './pages/UpdatePage';
import AuditLogPage from './pages/AuditLogPage';
import LicencesPage from './pages/LicencesPage';
import EntraAppsPage from './pages/EntraAppsPage';
import MonitorsPage from './pages/MonitorsPage';
import StatusPage from './pages/StatusPage';
import RoutersPage from './pages/RoutersPage';
import SwitchesPage from './pages/SwitchesPage';
import AccessPointsPage from './pages/AccessPointsPage';
import DnsPage from './pages/DnsPage';
import DnsAnalyticsPage from './pages/DnsAnalyticsPage';
import NetSpeedPage from './pages/NetSpeedPage';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<DashboardPage />} />
          <Route path="/licences" element={<LicencesPage />} />
          <Route path="/entra-apps" element={<EntraAppsPage />} />
          <Route path="/monitors" element={<MonitorsPage />} />
          <Route path="/routers" element={<RoutersPage />} />
          <Route path="/switches" element={<SwitchesPage />} />
          <Route path="/access-points" element={<AccessPointsPage />} />
          <Route path="/dns" element={<DnsPage />} />
          <Route path="/dns-analytics" element={<DnsAnalyticsPage />} />
          <Route path="/netspeed" element={<NetSpeedPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route
            path="/users"
            element={
              <ProtectedRoute roles={['superadmin', 'admin']}>
                <UsersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute roles={['superadmin', 'admin']}>
                <SettingsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/update"
            element={
              <ProtectedRoute roles={['superadmin', 'admin']}>
                <UpdatePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/audit-log"
            element={
              <ProtectedRoute roles={['superadmin', 'admin']}>
                <AuditLogPage />
              </ProtectedRoute>
            }
          />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
