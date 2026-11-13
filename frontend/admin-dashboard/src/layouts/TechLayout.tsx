import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../context/AuthContext';

export default function TechLayout() {
  const { session } = useAuth();
  if (!session) return <Navigate to="/login" replace />;
  if (session.staff.role !== 'TECHNICIAN') return <Navigate to="/" replace />;
  return (
    <div className="mx-auto min-h-dvh max-w-md bg-white">
      <main>
        <Outlet />
      </main>
    </div>
  );
}
