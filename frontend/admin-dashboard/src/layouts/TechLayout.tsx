import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '../context/AuthContext';

export default function TechLayout() {
  const location = useLocation();
  const { session } = useAuth();
  if (!session)
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (session.staff.role !== 'TECHNICIAN') return <Navigate to="/" replace />;
  return (
    <div className="mx-auto min-h-dvh max-w-md bg-white">
      <main>
        <Outlet />
      </main>
    </div>
  );
}
