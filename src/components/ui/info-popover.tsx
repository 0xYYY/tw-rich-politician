import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface InfoPopoverProps {
  label?: string;
  className?: string;
  children?: React.ReactNode;
}

function InfoPopover({ label = "了解更多", className, children }: InfoPopoverProps) {
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const baseItems = React.Children.toArray(children).filter(
    (node) => !(typeof node === "string" && node.trim() === ""),
  );
  let items = baseItems;

  // Astro React islands pass default slot as an `astro-slot` element with HTML in `props.value`.
  // Parse <p> blocks so each paragraph becomes a numbered item.
  if (baseItems.length === 1 && React.isValidElement(baseItems[0])) {
    const single = baseItems[0] as React.ReactElement<{
      value?: unknown;
      children?: React.ReactNode;
    }>;
    const rawSlotHtml = typeof single.props?.value === "string" ? single.props.value : null;

    if (rawSlotHtml) {
      const paragraphHtmlItems = Array.from(rawSlotHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi))
        .map((match) => match[1].trim())
        .filter(Boolean);

      if (paragraphHtmlItems.length > 0) {
        items = paragraphHtmlItems.map((html, idx) => (
          <span key={`slot-html-${idx}`} dangerouslySetInnerHTML={{ __html: html }} />
        ));
      } else {
        const stripped = rawSlotHtml
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (stripped) items = [stripped];
      }
    } else {
      // Fallback for non-slot wrappers that contain nested React children.
      const nestedItems = React.Children.toArray(single.props?.children).filter(
        (node) => !(typeof node === "string" && node.trim() === ""),
      );
      if (nestedItems.length > 1) items = nestedItems;
    }
  }

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={cn(
          "inline-grid grid-cols-[auto_auto] items-start gap-1 border-0 bg-transparent p-0 text-xs leading-none text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:outline-none",
          className,
        )}
        onClick={() => setOpen(true)}
      >
        <span className="inline-flex items-center justify-center text-[13px] leading-none">ℹ️</span>
        <span className="block leading-none">{label}</span>
      </button>
      {mounted &&
        open &&
        createPortal(
          <>
            <button
              type="button"
              className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-[1px]"
              aria-label="關閉說明"
              onClick={() => setOpen(false)}
            />
            <div className="fixed inset-0 z-[61] grid place-items-center p-3 pointer-events-none">
              <div className="pointer-events-auto relative w-[min(420px,calc(100vw-28px))] rounded-none border border-[var(--border-grid)] bg-[var(--bg-card)] p-3 text-[var(--color-text)] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
                <ol className="space-y-2 text-xs leading-5 text-[var(--color-text-secondary)]">
                  {items.map((item, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="mt-0.5 w-4 shrink-0 text-right font-mono text-[11px] text-[var(--color-text-secondary)]">
                        {idx + 1}.
                      </span>
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ol>
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-3 h-9 w-full rounded-none border border-[var(--border-grid)] text-sm text-[var(--color-text-secondary)] hover:bg-white/10 hover:text-[var(--color-text)]"
                  aria-label="關閉"
                  onClick={() => setOpen(false)}
                >
                  關閉
                </Button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

export default InfoPopover;
