import { type ChangeEvent, useEffect, useId, useState } from 'react';
import camera from '../assets/camera.png';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

type ImageUploadProps = {
  file: File | null;
  onChange: (file: File | null) => void; // function that takes a File | null and returns nothing (void)
};

export default function ImageUpload({ file, onChange }: ImageUploadProps) {
  const inputId = useId(); // unique ID for the file input, used for accessibility (label htmlFor)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url); // Cleanup the object URL when the component unmounts or when the file changes
  }, [file]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!selectedFile) return;

    if (!selectedFile.type.startsWith('image/')) {
      setError('Please select an image file.');
      return;
    }
    if (selectedFile.size > MAX_IMAGE_SIZE) {
      setError(
        'Image is too large. Please select an image smaller than 10 MB.',
      );
      return;
    }
    setError(null);
    onChange(selectedFile);
  }

  function handleRemove() {
    setError(null);
    onChange(null);
  }
  return (
    <div>
      <h1 className="mb-1 text-sm font-medium">Photo</h1>

      {previewUrl ? (
        <div className="space-y-2">
          <img
            src={previewUrl}
            alt="Selected photo of the problem"
            className="max-h-72 w-full rounded-lg object-cover"
          />
          {previewUrl && (
            <p className="mt-2 text-xs text-slate-500 text-center">
              {/* / 1024 / 1024 make it in MB instead of bytes */}
              Selected: {file?.name} (
              {(file ? file.size / 1024 / 1024 : 0).toFixed(1)} MB)
            </p>
          )}
          <div className="flex gap-2">
            <label
              htmlFor={inputId}
              className="cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium"
            >
              Change photo
            </label>
            <button
              type="button"
              onClick={handleRemove}
              className="rounded-lg px-3 py-2 text-sm font-medium text-red-700"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <label
          htmlFor={inputId}
          className="flex h-40 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-400 bg-white text-slate-500"
        >
          <div aria-hidden="true">
            <img src={camera} alt="" className="h-8 w-8 object-cover" />
          </div>
          <span className="text-sm font-medium">Take / Upload Photo</span>
        </label>
      )}
      <input
        // Use inputId to reference to button Change photo and Take / Upload Photo from input(id) -> label(htmlFor)
        id={inputId}
        type="file"
        accept="image/*"
        onChange={handleChange}
        className="sr-only"
      />
      {error && (
        <p className="mt-1 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
