import { Link } from 'react-router';

const NotFoundPage = () => {
  return (
    <div className="flex flex-col gap-2 min-h-screen">
      <h1 className="text-lg font-bold">Page not found</h1>
      <Link to="/" className="text-slate-500">
        Back to Overview
      </Link>
    </div>
  );
};

export default NotFoundPage;
