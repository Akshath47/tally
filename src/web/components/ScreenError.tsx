import { ApiError } from "../api";
import { formatTimestamp } from "../format";
import { Link } from "../router";
import { Button, Refresh } from "./ui";

/** A tab screen that failed to load: what failed, reassurance, a retry and when it happened. */
export function ScreenError({ what, error, at, onRetry, retrying }: { what: string; error: unknown; at: number; onRetry: () => void; retrying: boolean }) {
  const status = error instanceof ApiError ? error.status : null;
  return (
    <div role="alert" className="mx-6 mt-[110px] flex flex-col items-center gap-2.5 text-center">
      <span className="grid size-16 place-items-center rounded-full border border-over/40 bg-over-tint text-over-fg">
        <Refresh size={26} />
      </span>
      <h2 className="mt-2 text-[22px] font-light">Tally couldn't load {what}</h2>
      <p className="text-[13.5px] leading-normal text-muted">
        {status ? "The server didn't respond." : "Tally couldn't reach the server."} Your data is safe and nothing was changed. Check your connection and try again.
      </p>
      <Button className="mt-2.5 min-h-[50px] px-7" onClick={onRetry} disabled={retrying}>
        {retrying ? "Trying…" : "Try again"}
      </Button>
      <Link href="/accounts" className="inline-flex min-h-11 items-center text-[13.5px] text-accent-fg">
        Check account status
      </Link>
      <div className="text-[11.5px] text-subtle">
        {status ? `Error ${status}` : "No connection"} · {formatTimestamp(new Date(at).toISOString())}
      </div>
    </div>
  );
}
