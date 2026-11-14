type ErrorBoxProps = { message: string; onRetry?: () => void };

export default function ErrorBox({ message, onRetry }: ErrorBoxProps) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
    >
      {message}{' '}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="font-medium underline"
        >
          Retry
        </button>
      )}
    </div>
  );
}
