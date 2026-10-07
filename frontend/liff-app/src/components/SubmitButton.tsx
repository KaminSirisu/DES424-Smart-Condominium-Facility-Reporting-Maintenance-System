type SubmitButtonProps = {
  submitting: boolean;
};

export default function SubmitButton({ submitting }: SubmitButtonProps) {
  return (
    <button
      type="submit"
      disabled={submitting}
      className="w-full rounded-lg bg-[#06C755] px-4 py-3 font-semibold text-white active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {submitting ? 'Submitting...' : 'Submit Report'}
    </button>
  );
}
