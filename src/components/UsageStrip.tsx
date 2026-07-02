import { formatCount } from "../lib/format";
import { totalTokens } from "../lib/usage";
import type { UsageSnapshot } from "../lib/usageSession";

export function UsageStrip({
  snapshot,
}: {
  snapshot: UsageSnapshot | null;
}): React.JSX.Element {
  if (snapshot === null) {
    return <div className="usage-strip usage-strip--empty">usage —</div>;
  }
  const tools = Object.entries(snapshot.cli).filter(
    ([, t]) => totalTokens(t) > 0,
  );
  return (
    <div className="usage-strip">
      <span className="usage-strip__item">
        session {formatCount(snapshot.sessionTokens)}
      </span>
      <span className="usage-strip__item usage-strip__item--muted">
        inapp {formatCount(snapshot.inappTokens)}
      </span>
      {tools.map(([name, t]) => (
        <span key={name} className="usage-strip__item usage-strip__item--muted">
          {name} {formatCount(totalTokens(t))}
        </span>
      ))}
      <span
        className={
          "usage-strip__guard" +
          (snapshot.guard === "warn" ? " usage-strip__guard--warn" : "")
        }
      >
        {snapshot.guard === "warn" ? "⚠ budget" : "● ok"}
      </span>
    </div>
  );
}
