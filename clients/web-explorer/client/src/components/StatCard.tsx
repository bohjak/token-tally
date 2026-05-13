type Props = {
  label: string;
  value: string;
  sub?: string;
  delta?: {
    text: string;
    tone?: "good" | "bad" | "neutral";
  };
};

export default function StatCard({ label, value, sub, delta }: Props) {
  const deltaClass = delta?.tone === "good"
    ? "text-green-600"
    : delta?.tone === "bad"
      ? "text-red-600"
      : "text-gray-400";
  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
      <div className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">{label}</div>
      <div className="text-xl font-semibold text-gray-900 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
      {delta && <div className={`text-xs mt-1 ${deltaClass}`}>{delta.text}</div>}
    </div>
  );
}
