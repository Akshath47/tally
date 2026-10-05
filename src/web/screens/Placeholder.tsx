import { PushedScreen } from "../components/Screen";
import type { Back } from "../routes";

/** A pushed screen whose design hasn't been built yet. */
export function Placeholder({ back, title }: { back: Back; title: string }) {
  return (
    <PushedScreen back={back} title={title}>
      <p className="mx-5 mt-2 text-meta text-muted">Not built yet.</p>
    </PushedScreen>
  );
}
