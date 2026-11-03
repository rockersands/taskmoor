import { type ReactNode, useId } from 'react';

/** A titled card of label and value lines, as the system status page shows them. */
export function Facts({
  title,
  children,
  after,
}: {
  title: string;
  children: ReactNode;
  /** What follows the list inside the card: a command, a switch. */
  after?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="facts">
      <h2 id={id} className="facts-title">
        {title}
      </h2>
      <dl className="facts-list">{children}</dl>
      {after}
    </section>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
