/** Tiny CSS bar chart (no chart library). Accessible: a text summary stands in for the picture. */
export function Bars({ points, label, unit }: { points: { day: string; value: number }[]; label: string; unit: string }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const total = points.reduce((a, p) => a + p.value, 0);
  return (
    <figure className="bars-fig">
      <div className="bars" role="img" aria-label={`${label}: ${total} ${unit} over ${points.length} days`}>
        {points.map((p) => (
          <span key={p.day} className="bar" style={{ height: `${Math.max(4, Math.round((p.value / max) * 100))}%` }} title={`${p.day}: ${p.value} ${unit}`} />
        ))}
      </div>
      <figcaption className="stat-note">
        {label}: {total} {unit} over {points.length} days{points.length ? ` (${points[0].day} to ${points[points.length - 1].day})` : ""}
      </figcaption>
    </figure>
  );
}
