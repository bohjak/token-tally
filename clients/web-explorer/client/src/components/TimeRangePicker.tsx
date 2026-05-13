import type { Preset } from "../hooks/useFilters.ts";

type Props = {
  activePreset: Preset | null;
  from: number;
  to: number;
  onPreset: (p: Preset) => void;
  onCustomRange: (from: Date, to: Date) => void;
};

const PRESETS: { key: Preset; label: string }[] = [
  { key: "1d",  label: "Day"   },
  { key: "7d",  label: "Week"  },
  { key: "30d", label: "Month" },
];

function toDateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export default function TimeRangePicker({ activePreset, from, to, onPreset, onCustomRange }: Props) {
  const handleFrom = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.value) return;
    onCustomRange(new Date(e.target.value), new Date(to));
  };

  const handleTo = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.value) return;
    const toDate = new Date(e.target.value);
    toDate.setHours(23, 59, 59, 999);
    onCustomRange(new Date(from), toDate);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex h-8 overflow-hidden rounded border border-gray-200 bg-white shadow-sm">
        {PRESETS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onPreset(key)}
            className={`border-r border-gray-200 px-3 text-xs font-medium last:border-r-0 ${
              activePreset === key
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {activePreset === "all" || from === 0 ? (
        <div className="inline-flex h-8 items-center rounded border border-gray-200 bg-white px-3 text-xs text-gray-700 shadow-sm">
          All time
        </div>
      ) : (
        <div className="inline-flex h-8 items-center gap-1 rounded border border-gray-200 bg-white px-2 shadow-sm">
          <input
            type="date"
            value={toDateInput(from)}
            onChange={handleFrom}
            className="w-32 border-0 bg-transparent p-0 text-xs text-gray-700 outline-none"
          />
          <span className="text-gray-300 text-xs">—</span>
          <input
            type="date"
            value={toDateInput(to)}
            onChange={handleTo}
            className="w-32 border-0 bg-transparent p-0 text-xs text-gray-700 outline-none"
          />
        </div>
      )}
    </div>
  );
}
