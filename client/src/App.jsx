import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { SshSessionsProvider } from './context/SshSessionsContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ProfilePage from './pages/ProfilePage';
import UsersPage from './pages/UsersPage';
import SettingsPage from './pages/SettingsPage';
import UpdatePage from './pages/UpdatePage';
import BackupPage from './pages/BackupPage';
import NewDeploymentPage from './pages/NewDeploymentPage';
import DeploymentsPage from './pages/DeploymentsPage';
import TemplatesPage from './pages/TemplatesPage';
import PlaybooksPage from './pages/PlaybooksPage';
import RunPlaybookPage from './pages/RunPlaybookPage';
import AuditLogPage from './pages/AuditLogPage';
import LicencesPage from './pages/LicencesPage';
import EntraAppsPage from './pages/EntraAppsPage';
import MonitorsPage from './pages/MonitorsPage';
import StatusPage from './pages/StatusPage';
import TvDashboardPage from './pages/TvDashboardPage';
import TvHypervisorsPage from './pages/TvHypervisorsPage';
import SshPage from './pages/SshPage';
import RoutersPage from './pages/RoutersPage';
import SwitchesPage from './pages/SwitchesPage';
import AccessPointsPage from './pages/AccessPointsPage';
import DnsPage from './pages/DnsPage';
import DnsAnalyticsPage from './pages/DnsAnalyticsPage';
import NetSpeedPage from './pages/NetSpeedPage';
import MyIpPage from './pages/MyIpPage';
import HypervisorsPage from './pages/HypervisorsPage';
import NetworkScannerPage from './pages/NetworkScannerPage';
import PatchManagementPage from './pages/PatchManagementPage';

export default function App() {
  return (
    <AuthProvider>
      <SshSessionsProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/status/dashboard" element={<TvDashboardPage />} />
        <Route path="/status/hypervisors" element={<TvHypervisorsPage />} />
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
          <Route path="/myip" element={<MyIpPage />} />
          <Route path="/hypervisors" element={<HypervisorsPage />} />
          <Route path="/network-scanner" element={<NetworkScannerPage />} />
          <Route path="/patch-management" element={<PatchManagementPage />} />
          <Route
            path="/ssh"
            element={
              <ProtectedRoute roles={['superadmin', 'admin']}>
                <SshPage />
              </ProtectedRoute>
            }
          />
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
            path="/backup"
            element={
              <ProtectedRoute roles={['superadmin', 'admin']}>
                <BackupPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/automation/templates"
            element={
              <ProtectedRoute roles={['superadmin', 'admin']}>
                <TemplatesPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/automation/new"
            element={
              <ProtectedRoute roles={['superadmin', 'admin', 'operator']}>
                <NewDeploymentPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/automation/deployments"
            element={
              <ProtectedRoute roles={['superadmin', 'admin', 'operator']}>
                <DeploymentsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/automation/playbooks"
            element={
              <ProtectedRoute roles={['superadmin', 'admin']}>
                <PlaybooksPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/automation/run-playbook"
            element={
              <ProtectedRoute roles={['superadmin', 'admin', 'operator']}>
                <RunPlaybookPage />
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
      </SshSessionsProvider>
    </AuthProvider>
  );
}
