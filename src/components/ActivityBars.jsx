import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

function metric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function ActivityTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  return <div className="statistics-tooltip">
    <strong>{row.label || label}</strong>
    <span><i className="tooltip-dot correct-dot" />Đúng: {metric(row.correct)}</span>
    <span><i className="tooltip-dot incorrect-dot" />Sai: {metric(row.incorrect)}</span>
    <span><i className="tooltip-total" />Tổng: {metric(row.total ?? metric(row.correct) + metric(row.incorrect))}</span>
  </div>;
}

export default function ActivityBars({ data = [] }) {
  return <ResponsiveContainer width="100%" height={260}>
    <BarChart data={data} margin={{ top: 10, right: 8, left: -12, bottom: 0 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
      <XAxis dataKey="label" tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false} />
      <YAxis allowDecimals={false} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} tickLine={false} axisLine={false} width={28} />
      <Tooltip content={<ActivityTooltip />} cursor={{ fill: 'var(--surface-soft)' }} />
      <Legend formatter={value => value === 'Đúng' ? 'Đúng' : 'Sai'} wrapperStyle={{ color: 'var(--text-muted)', fontSize: 12 }} />
      <Bar dataKey="correct" name="Đúng" stackId="activity" fill="var(--success)" radius={[0, 0, 0, 0]} maxBarSize={24} />
      <Bar dataKey="incorrect" name="Sai" stackId="activity" fill="var(--danger)" radius={[4, 4, 0, 0]} maxBarSize={24} />
    </BarChart>
  </ResponsiveContainer>;
}

