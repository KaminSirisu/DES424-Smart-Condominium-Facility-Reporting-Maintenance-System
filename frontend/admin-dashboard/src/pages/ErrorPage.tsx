import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

export default function ErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unknown error';
  return (
    <div className="flex flex-col min-h-screen mx-auto">
      <h1 className="text-lg font-bold">Someting went wrong</h1>
      <p>{message}</p>
      <Link to="/">Back to Overview</Link>
    </div>
  );
}
