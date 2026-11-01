import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type Props = HTMLAttributes<HTMLElement> & { title?: ReactNode; action?: ReactNode; hero?: boolean; flat?: boolean };

export function Card({ title, action, hero, flat, className, children, ...rest }: Props) {
  return (
    <section className={cx("card", hero && "card-hero", flat && "card-flat", className)} {...rest}>
      {(title || action) && (
        <div className="card-head">
          {title ? <h3>{title}</h3> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
