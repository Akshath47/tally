import type { ReactNode } from "react";
import { BackLink } from "../router";

/** A pushed screen: back link (plus an optional action on the right), then the title. */
export function PushedScreen({ back, title, action, children }: { back: { href: string; label: string }; title: string; action?: ReactNode; children?: ReactNode }) {
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
