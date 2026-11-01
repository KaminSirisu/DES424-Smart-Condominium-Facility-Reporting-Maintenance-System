import { Link } from 'react-router';
import { ChevronLeft } from 'lucide-react';

type HeaderProps = {
  title: string;
  subtitle?: string;
  backTo?: string;
  initial?: string;
};

export default function TechHeader({
  title,
  subtitle,
  backTo,
  initial,
}: HeaderProps) {
  return (
    <header className="flex items-center justify-start gap-2 bg-gray-100 p-3 border-b border-gray-200">
      {backTo ? (
        <Link
          to={backTo}
          aria-label="Back"
          className="text-gray-500 hover:text-gray-700"
        >
          <ChevronLeft size={20} />
        </Link>
      ) : (
        <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center text-white">
          {initial}
        </div>
      )}
      <div className="flex flex-col">
        <h1 className="text-sm font-semibold">{title}</h1>
        {subtitle && (
          <span className="text-[10px] text-slate-500 font-extralight">
            {subtitle}
          </span>
        )}
      </div>
    </header>
  );
}
