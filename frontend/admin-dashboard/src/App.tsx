import { createBrowserRouter, RouterProvider } from 'react-router';
import AdminLayout from './layouts/AdminLayout';
import OverviewPage from './pages/OverviewPage';
import TicketsPage from './pages/TicketsPage';
import StaffPage from './pages/StaffPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AdminLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'tickets', element: <TicketsPage /> },
      { path: 'staff', element: <StaffPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
