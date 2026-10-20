import { Link } from "../router";

/** "11 to sort", shown only while there's something to sort; it's the only way into To sort. */
export function ToSortChip({ count }: { count: number }) {
  return (
    <Link href="/to-sort" className="flex min-h-11 items-center" aria-label={`${count} to sort`}>
      <span className="inline-flex h-9 items-center gap-[7px] rounded-full border border-accent/35 bg-accent-tint px-[13px] text-[13px] font-medium text-accent-fg">
        <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-[5px] text-[10.5px] font-semibold text-on-accent">{count}</span>
        to sort
      </span>
    </Link>
  );
}
