type Props = { label: string; value: string | number; danger?: boolean };

export default function StatCard({ label, value, danger }: Props) {
    return (
        <div
            className={`rounded-2xl border p-5 ${
                danger ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'
            }`}
        >
            <p className={`text-sm ${danger ? 'text-red-700' : 'text-slate-500'}`}>{label}</p>
            <p className={`mt-3 text-3xl font-bold ${danger ? 'text-red-600' : 'text-slate-900'}`}>
                {value}
            </p>
        </div>
    )
}