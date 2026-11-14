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
import TechLayout from './layouts/TechLayout';
import JobsPage from './pages/tech/JobsPage';
import JobDetailPage from './pages/tech/JobDetailPage';
import TechNotFoundPage from './pages/tech/TechNotFoundPage';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <ErrorPage /> },
  {
    path: '/',
    element: <AdminLayout />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'triage', element: <TriagePage /> },
      { path: 'tickets', element: <TicketsPage /> },
      { path: 'tickets/:ticketId', element: <TicketsPage /> },
      { path: 'staff', element: <StaffPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  {
    path: '/tech',
    element: <TechLayout />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <JobsPage /> },
      { path: 'jobs/:ticketId', element: <JobDetailPage /> },
      { path: '*', element: <TechNotFoundPage /> },
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
