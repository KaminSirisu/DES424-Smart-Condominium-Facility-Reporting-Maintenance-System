import { getPhotoAccess } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { Skeleton } from './Skeleton';

type PhotoPreviewProps = { ticketId: string; photoId: string; alt: string };

// Asks the backend for a short-lived photo link, then shows the image.
export default function PhotoPreview({
  ticketId,
  photoId,
  alt,
}: PhotoPreviewProps) {
  const photo = useAsync(() => getPhotoAccess(ticketId, photoId), photoId);
  if (photo.error) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-xl bg-slate-100 text-sm text-slate-500">
        Photo unavailable.
        <button type="button" onClick={photo.reload} className="underline">
          Try again
        </button>
      </div>
    );
  }
  if (!photo.data) return <Skeleton className="h-48 w-full rounded-xl" />;
  return (
    <img
      src={photo.data.url}
      alt={alt}
      className="max-h-72 w-full rounded-xl object-cover"
    />
  );
}
