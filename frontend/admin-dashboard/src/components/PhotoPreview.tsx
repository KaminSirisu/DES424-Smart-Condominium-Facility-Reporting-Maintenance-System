import { useApi } from '../hooks/useApi';
import { api } from '../services/api';
import { Skeleton } from './Skeleton';

type PhotoPreviewProps = { ticketId: string; photoId: string; alt: string };

/** Loads a short-lived photo URL from the photo-access endpoint and shows the image. */
export default function PhotoPreview({
  ticketId,
  photoId,
  alt,
}: PhotoPreviewProps) {
  const photo = useApi(() => api.getPhotoAccess(ticketId, photoId), photoId);
  if (photo.error) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-400">
        {photo.error}
      </div>
    );
  }
  if (!photo.data) return <Skeleton className="h-40 w-full rounded-xl" />;
  return (
    <img
      src={photo.data.url}
      alt={alt}
      className="max-h-64 w-full rounded-xl object-cover"
    />
  );
}
