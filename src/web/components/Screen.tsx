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

/** A list or screen that failed to load, with a retry. */
export function LoadError({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <p role="alert" className="mx-5 mt-4 text-over-fg">
      Couldn't load {what}.{" "}
      {onRetry && (
        <button type="button" className="min-h-11 font-medium text-accent-fg underline" onClick={onRetry}>
          Try again
        </button>
      )}
    </p>
  );
}
