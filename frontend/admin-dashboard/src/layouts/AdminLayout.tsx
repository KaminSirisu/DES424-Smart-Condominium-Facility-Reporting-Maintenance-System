import { Navigate, Outlet } from 'react-router';
import Sidebar from '../components/Sidebar';
import { useAuth } from '../context/AuthContext';

export default function AdminLayout() {
  const { session } = useAuth();
  if (!session) return <Navigate to="/login" replace />;
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
