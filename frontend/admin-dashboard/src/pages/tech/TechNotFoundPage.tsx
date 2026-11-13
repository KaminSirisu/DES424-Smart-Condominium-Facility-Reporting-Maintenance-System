import { Link } from 'react-router';

const TechNotFoundPage = () => {
  return (
    <div className="flex flex-col gap-2 min-h-dvh mt-2">
      <h1 className="text-lg font-bold mx-auto">Page not found</h1>
      <Link to="/tech" className="text-slate-500 mx-auto">
        Back to Jobs
      </Link>
    </div>
  );
};

export default TechNotFoundPage;
