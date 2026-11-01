import { Outlet } from 'react-router';

export default function TechLayout() {
  return (
    <div className="min-h-screen max-w-md mx-auto bg-white">
      <main>
        <Outlet />
      </main>
    </div>
  );
}
