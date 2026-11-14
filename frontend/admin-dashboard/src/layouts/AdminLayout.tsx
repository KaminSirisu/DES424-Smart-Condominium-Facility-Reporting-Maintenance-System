import { Navigate, Outlet, useLocation } from 'react-router';
import Sidebar from '../components/Sidebar';
import { useAuth } from '../context/AuthContext';

export default function AdminLayout() {
  const location = useLocation();
  const { session } = useAuth();
  if (!session)
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (session.staff.role !== 'MANAGER') return <Navigate to="/tech" replace />;
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
