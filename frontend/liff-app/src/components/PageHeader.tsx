import { ChevronLeft } from 'lucide-react';
import { navigate } from '../lib/router';

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  backTo?: string;
};

// Same look as the staff UI's TechHeader.
export default function PageHeader({
  title,
  subtitle,
  backTo,
}: PageHeaderProps) {
  return (
    <header className="flex items-center gap-2 border-b border-gray-200 bg-gray-100 p-3">
      {backTo && (
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(backTo)}
          className="rounded-md p-1 text-gray-500 hover:text-gray-700"
        >
          <ChevronLeft size={20} />
        </button>
      )}
      <div className="flex flex-col">
        <h1 className="text-sm font-semibold">{title}</h1>
        {subtitle && <span className="text-xs text-slate-500">{subtitle}</span>}
      </div>
    </header>
  );
}
