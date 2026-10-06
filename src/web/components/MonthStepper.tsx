import type { ReactNode } from "react";
import { addMonths } from "../dates";
import { ChevronLeft, ChevronRight } from "./ui";

const step = "grid size-11 place-items-center text-fg/80 hover:text-fg disabled:opacity-30 disabled:hover:text-fg/80";

/** ‹ › around an optional label. `onStep` gets the month to show; forward stops at `current`. */
export function MonthStepper({ month, current, prevDisabled = false, onStep, className = "", children }: { month: string; current: string; prevDisabled?: boolean; onStep: (month: string) => void; className?: string; children?: ReactNode }) {
  return (
    <div className={`flex items-center ${className}`} role="group" aria-label="Month">
      <button type="button" aria-label="Previous month" className={step} disabled={prevDisabled} onClick={() => onStep(addMonths(month, -1))}>
        <ChevronLeft size={18} />
      </button>
      {children}
      <button type="button" aria-label="Next month" className={step} disabled={month >= current} onClick={() => onStep(addMonths(month, 1))}>
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
