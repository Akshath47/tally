import { useEffect, useRef, type ReactNode } from "react";

/**
 * A bottom sheet on the native modal <dialog>, which brings focus trapping, Escape, an inert
 * page behind and the top layer for free. Controlled: `open` drives it, and Escape, a tap on
 * the backdrop or a close() from inside all ask the parent via onDismiss.
 */
export function Sheet({ open, onDismiss, labelledBy, children }: { open: boolean; onDismiss: () => void; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // iOS scrolls the page behind a modal dialog unless the root stops scrolling.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.classList.add("overflow-hidden");
    return () => root.classList.remove("overflow-hidden");
  }, [open]);

  return (
    // No display class here: it would override the UA's display:none for a closed dialog.
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      className="fixed inset-x-0 top-auto bottom-0 m-0 mx-auto w-full max-w-lg rounded-t-[22px] border-t border-line bg-sheet p-0 text-fg backdrop:bg-black/55 motion-safe:animate-sheet-up"
      onCancel={(e) => {
        e.preventDefault();
        onDismiss();
      }}
      onClose={() => {
        if (open) onDismiss();
      }}
      // Taps on the backdrop land on the dialog itself; the content wrapper covers the rest.
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="flex max-h-[calc(100dvh-64px)] flex-col pb-safe">
        <div className="flex shrink-0 justify-center pt-2" aria-hidden="true">
          <span className="h-[5px] w-[38px] rounded-full bg-muted/30" />
        </div>
        {open && children}
      </div>
    </dialog>
  );
}
