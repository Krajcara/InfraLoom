import { Routes, Route, Navigate } from 'react-router-dom';
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
import UpsPage from './pages/UpsPage';
import MaintenancePage from './pages/MaintenancePage';
import NetworkScannerPage from './pages/NetworkScannerPage';
import PatchManagementPage from './pages/PatchManagementPage';
import CablingRoomsPage from './pages/cabling/CablingRoomsPage';
import CablingRoomPage from './pages/cabling/CablingRoomPage';
import CablingOfficesPage from './pages/cabling/CablingOfficesPage';
import CablingDevicesPage from './pages/cabling/CablingDevicesPage';
import CablingDeviceFormPage from './pages/cabling/CablingDeviceFormPage';
import CablingTemplatesPage from './pages/cabling/CablingTemplatesPage';

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
          <Route path="/ups" element={<UpsPage />} />
          <Route path="/maintenance" element={<MaintenancePage />} />
          <Route path="/cabling" element={<CablingRoomsPage />} />
          <Route path="/cabling/rooms/:id" element={<CablingRoomPage />} />
          <Route path="/cabling/offices" element={<CablingOfficesPage />} />
          <Route path="/cabling/devices" element={<CablingDevicesPage />} />
          <Route path="/cabling/devices/new" element={<CablingDeviceFormPage />} />
          <Route path="/cabling/devices/:id/edit" element={<CablingDeviceFormPage />} />
          <Route path="/cabling/templates" element={<CablingTemplatesPage />} />
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
            path="/audit-log"
            element={
              <ProtectedRoute roles={['superadmin', 'admin']}>
                <AuditLogPage />
              </ProtectedRoute>
            }
          />
          {/* Unknown URLs (old bookmarks to removed modules, typos) go to the dashboard instead of a blank page. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      </SshSessionsProvider>
    </AuthProvider>
  );
}
