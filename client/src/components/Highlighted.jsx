// Renders the content with each open finding's text span highlighted. Clicking a highlight selects the finding.
export default function Highlighted({ body, findings, activeId, onPick, code }) {
  const spans = findings
    .filter((f) => f.start >= 0 && f.end > f.start && f.status === 'open' && !f.advisory)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const parts = [];
  let pos = 0;
  for (const f of spans) {
    if (f.start < pos) continue; // overlapping span: the earlier (higher priority) one wins
    if (f.start > pos) parts.push(body.slice(pos, f.start));
    parts.push(
      <mark
        key={f.id}
        id={`hl-${f.id}`}
        className={`hl ${f.severity}${f.id === activeId ? ' active' : ''}`}
        onClick={() => onPick(f.id)}
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(f.id))}
        title={f.message}
      >
        {body.slice(f.start, f.end)}
      </mark>
    );
    pos = f.end;
  }
  parts.push(body.slice(pos));
  return <div className={`content-box${code ? ' code' : ''}`} tabIndex={0} aria-label="Content under review">{parts}</div>;
}
