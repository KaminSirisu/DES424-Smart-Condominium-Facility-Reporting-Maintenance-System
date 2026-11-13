import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthProvider } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import AdminLayout from './layouts/AdminLayout';
import OverviewPage from './pages/OverviewPage';
import TicketsPage from './pages/TicketsPage';
import StaffPage from './pages/StaffPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import NotFoundPage from './pages/NotFoundPage';
import ErrorPage from './pages/ErrorPage';
import TriagePage from './pages/TriagePage';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <ErrorPage />},
  {
    path: '/',
    element: <AdminLayout />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'triage', element: <TriagePage /> },
      { path: 'tickets', element: <TicketsPage /> },
      { path: 'staff', element: <StaffPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
    
  );
}
