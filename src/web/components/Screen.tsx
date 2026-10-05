import type { ReactNode } from "react";
import { BackLink } from "../router";
import type { Back } from "../routes";

/** A tab screen's header: title, plus an optional action on the right. */
export function TabScreen({ title, titleExtra, action, children }: { title: string; titleExtra?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <header className="flex items-start justify-between pt-safe pr-3 pl-5">
        <div>
          <h1 className="text-title">{title}</h1>
          {titleExtra}
        </div>
        {action}
      </header>
      {children}
    </>
  );
}

/** A pushed screen: back link (plus an optional action on the right), then the title. */
export function PushedScreen({ back, title, action, children }: { back: Back; title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <header className="pt-safe">
        <div className="flex items-center justify-between pr-3 pl-2">
          <BackLink {...back} />
          {action}
        </div>
        <h1 className="mx-5 mt-1 text-title">{title}</h1>
      </header>
      {children}
    </>
  );
}

/** The loading / error / empty line shown above a list. */
export function QueryStatus({ query, what, empty }: { query: { isPending: boolean; isError: boolean }; what: string; empty: string | false }) {
  if (query.isPending) return <p className="mt-2 text-meta text-muted">Loading…</p>;
  if (query.isError) return <p className="mt-2 text-meta text-over-fg">Couldn't load {what}.</p>;
  return empty ? <p className="mt-2 text-meta text-muted">{empty}</p> : null;
}
