import type { ReactNode } from "react";
import { Link } from "../router";
import { TABS, type Tab } from "../routes";

const ICONS: Record<Tab, ReactNode> = {
  home: (
    <>
      <circle cx="12" cy="12" r="8" opacity=".35" />
      <path d="M12 4a8 8 0 0 1 7.6 10.5" />
    </>
  ),
  transactions: <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />,
  insights: (
    <>
      <path d="M4 19.5h16" opacity=".35" />
      <path d="M4.5 15l4.5-5 4 3 6.5-7.5" strokeLinejoin="round" />
    </>
  ),
  budget: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
};

export function TabBar({ active }: { active: Tab }) {
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-10 border-t border-divider bg-canvas/94 pb-safe backdrop-blur">
      <div className="mx-auto grid h-tabbar max-w-lg grid-cols-4 px-2">
        {TABS.map(({ tab, href, label }) => (
          <Link
            key={tab}
            href={href}
            aria-current={tab === active ? "page" : undefined}
            className={`flex flex-col items-center justify-center gap-[3px] text-[10.5px] font-medium ${tab === active ? "text-accent-fg" : "text-subtle hover:text-fg"}`}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              {ICONS[tab]}
            </svg>
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
