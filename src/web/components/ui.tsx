import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Account } from "../api";

// Small shared pieces: badges, flags, icons, skeletons and the toast.

/** Short label and colours of an account's badge: "REV" (grey) or "AMEX" (blue). */
export function badgeOf(account: Pick<Account, "name" | "institutionName"> | undefined) {
  const text = `${account?.name ?? ""} ${account?.institutionName ?? ""}`;
  if (/amex|american express/i.test(text)) return { label: "AMEX", className: "bg-acct-amex text-acct-amex-fg" };
  if (/revolut/i.test(text)) return { label: "REV", className: "bg-acct-rev text-acct-rev-fg" };
  return { label: (account?.name ?? "?").slice(0, 4).toUpperCase(), className: "bg-acct-rev text-acct-rev-fg" };
}

export function AccountBadge({ account }: { account: Pick<Account, "name" | "institutionName"> | undefined }) {
  const badge = badgeOf(account);
  return (
    <span className={`inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[10px] font-semibold tracking-[0.05em] ${badge.className}`} title={account?.name}>
      {badge.label}
    </span>
  );
}

export function Flag({ tone, children }: { tone: "warn" | "over" | "accent"; children: ReactNode }) {
  const colours = { warn: "bg-warn-tint text-warn-fg", over: "bg-over-tint text-over-fg", accent: "bg-accent-tint text-accent-fg" }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-md px-[7px] py-0.5 text-[11px] font-medium ${colours}`}>{children}</span>;
}

type IconProps = { size?: number; className?: string };
const icon = (paths: ReactNode, strokeWidth = 1.6) =>
  function Icon({ size = 18, className }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
        {paths}
      </svg>
    );
  };

export const ChevronRight = icon(<path d="M9 6l6 6-6 6" />, 1.8);
export const ChevronLeft = icon(<path d="M15 6l-6 6 6 6" />, 1.8);
export const ChevronDown = icon(<path d="M6 9l6 6 6-6" />, 1.8);
export const ArrowUp = icon(<path d="M12 5v14M5 12l7-7 7 7" />, 2.6);
export const Lock = icon(
  <>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </>,
);
export const Clock = icon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l2.5 2" />
  </>,
);
export const Pencil = icon(<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />);
export const Info = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </>,
);
export const Check = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />, 1.8);
export const Warning = icon(<path d="M12 4l9 16H3l9-16zM12 10v4M12 17h.01" />);
export const Refresh = icon(
  <>
    <path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2" />
    <path d="M18.5 2.5v3.3h-3.3M5.5 21.5v-3.3h3.3" />
  </>,
);
export const Dots = icon(<path d="M6 12h.01M12 12h.01M18 12h.01" />, 2.6);
export const Spinner = icon(<path d="M20 12a8 8 0 1 1-3-6.2" />, 2.4);

export const Skeleton = ({ className }: { className: string }) => <div className={`skeleton ${className}`} aria-hidden="true" />;

export type ToastState = { text: string; actions: { label: string; run: () => void }[] } | null;

/** A bar above the tab bar with up to two actions; it leaves after 6 s. */
export function Toast({ toast, onDone }: { toast: ToastState; onDone: () => void }) {
  // The timer restarts only for a new toast, not whenever the parent re-renders.
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => done.current(), 6_000);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div role="status" className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-lg px-3 pb-safe">
      <div className="mb-2 flex items-center gap-1 rounded-button border border-line bg-raised py-1 pr-1 pl-4 shadow-lg shadow-black/40">
        <span className="flex-1 py-2.5 leading-snug">{toast.text}</span>
        {toast.actions.map((a) => (
          <button
            key={a.label}
            type="button"
            className="min-h-11 px-2 font-semibold text-accent-fg hover:text-fg"
            onClick={() => {
              onDone();
              a.run();
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A primary (sage) or secondary button at the 44 px minimum. */
export function Button({ kind = "primary", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "secondary" | "danger" }) {
  const look = {
    primary: "bg-accent text-on-accent font-medium",
    secondary: "border border-divider bg-raised text-fg font-medium",
    danger: "border border-divider bg-transparent text-over-fg",
  }[kind];
  return <button type="button" className={`min-h-11 rounded-button px-5 disabled:opacity-50 ${look} ${className}`} {...rest} />;
}
