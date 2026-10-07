import { useState, useId, type FormEvent } from 'react';
import ImageUpload from './ImageUpload';
import SubmitButton from './SubmitButton';
import { submitReport } from '../services/api';
import check from '../assets/check.png';

const MIN_DESCRIPTION_LENGTH = 10;
const MAX_DESCRIPTION_LENGTH = 500;

type FormErrors = {
  image?: string;
  description?: string;
};

export default function ReportForm() {
  const descriptionId = useId();
  const [image, setImage] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  function handleImageChange(file: File | null) {
    setImage(file);
    setErrors((prev) => ({ ...prev, image: undefined }));
  }
  function handleDescriptionChange(value: string) {
    setDescription(value);
    setErrors((prev) => ({ ...prev, description: undefined }));
  }
  function validateForm(): FormErrors {
    const next: FormErrors = {};
    const trimmed = description.trim();

    if (!image) {
      next.image = 'Please add a photo of the problem.';
    }
    if (!trimmed) {
      next.description = 'Please describe the problem.';
    } else if (trimmed.length < MIN_DESCRIPTION_LENGTH) {
      next.description = `Please add a bit more detail (at least ${MIN_DESCRIPTION_LENGTH} characters).`;
    }
    return next;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextErrors = validateForm();
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0 || !image) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitReport({ image, description: description.trim() });
      setSubmitted(true);
    } catch (error) {
      console.error('Error submitting report:', error);
      setSubmitError('Could not send your report. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleReportAnother() {
    setImage(null);
    setDescription('');
    setErrors({});
    setSubmitted(false);
  }

  if (submitted) {
    return (
      <div className="space-y-4 rounded-lg bg-white p-6 text-center">
        <div aria-hidden="true">
          <img src={check} alt="" className="mx-auto h-15 w-15" />
        </div>
        <p className="font-semibold">Report submitted</p>
        <p className="text-sm text-slate-600">
          Thank you. Our maintenance team will take a look.
        </p>
        <button
          type="button"
          onClick={handleReportAnother}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium"
        >
          Report another problem
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div>
        <ImageUpload file={image} onChange={handleImageChange} />
        {errors.image && (
          <p className="mt-1 text-sm text-red-700" role="alert">
            {errors.image}
          </p>
        )}
      </div>
      <div>
        <label
          htmlFor={descriptionId}
          className="mb-1 block text-sm font-medium"
        >
          Description
        </label>
        <textarea
          id={descriptionId}
          value={description}
          onChange={(event) => handleDescriptionChange(event.target.value)}
          maxLength={MAX_DESCRIPTION_LENGTH}
          rows={4}
          placeholder="Describe the problem, e.g. the lift on floor 3 makes a loud noise"
          className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base focus:border-[#06C755] focus:outline-none"
        />
        <div className="mt-1 flex justify-between text-xs">
          <span className="text-red-700" role="alert">
            {errors.description}
          </span>
          <span className="text-slate-500">
            {description.length}/{MAX_DESCRIPTION_LENGTH}
          </span>
        </div>
      </div>
      {submitError && (
        <p
          className="rounded-lg bg-red-50 p-3 text-sm text-red-800"
          role="alert"
        >
          {submitError}
        </p>
      )}

      <SubmitButton submitting={submitting} />
    </form>
  );
}
