import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { ChevronLeft } from "./components/ui";
import type { Back } from "./routes";

// A tiny History API router: real URLs, so the browser's and iOS's back gestures work, and the
// Worker's SPA fallback serves index.html for any of them. Each entry remembers the path it
// was pushed from, so a back link can return to it instead of stacking a new entry.

type NavState = { from: string } | null;

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export const usePathname = () => useSyncExternalStore(subscribe, () => window.location.pathname);

export function navigate(href: string, { replace = false } = {}) {
  const from = window.location.pathname;
  if (href === from) return;
  const state: NavState = { from };
  if (replace) window.history.replaceState(state, "", href);
  else window.history.pushState(state, "", href);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}

/** Back to `parent`: pops the history entry when that's where this screen was opened from. */
export function goBack(parent: string) {
  if ((window.history.state as NavState)?.from === parent) window.history.back();
  else navigate(parent, { replace: true });
}

/** Leaves modified clicks (new tab, etc.) to the browser. */
function isPlainClick(e: MouseEvent<HTMLAnchorElement>) {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (!isPlainClick(e)) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    />
  );
}

export function BackLink({ href, label }: Back) {
  return (
    <a
      href={href}
      className="inline-flex min-h-11 items-center gap-0.5 px-2 text-[15px] text-accent-fg"
      onClick={(e) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        goBack(href);
      }}
    >
      <ChevronLeft size={18} />
      {label}
    </a>
  );
}
