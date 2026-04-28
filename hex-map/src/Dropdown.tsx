import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
   /** Visible content of the trigger button. */
   trigger: ReactNode;
   /** aria-label for the trigger when there is no visible text label. */
   ariaLabel?: string;
   /** Extra class on the trigger button (e.g. "danger"). */
   triggerClassName?: string;
   /** "right" anchors the menu to the right edge of the trigger. */
   align?: "left" | "right";
   /**
    * Children should be plain `<button>`s (or anything clickable). The
    * dropdown automatically closes after a click anywhere inside the menu,
    * so consumers don't have to remember to call any close callback.
    */
   children: ReactNode;
}

/**
 * Tiny hover/click-to-open dropdown. Behaviours:
 *   • Mouse enter on the wrapper opens the menu.
 *   • Mouse leave closes it.
 *   • Click on the trigger toggles open (covers touch + when the menu was
 *     opened by hover but the user wants to keep it open).
 *   • Click anywhere inside the menu closes it (so menu items don't have to
 *     manage state themselves).
 *   • Click outside the wrapper closes it.
 *   • Escape closes it.
 */
export const Dropdown = ({
   trigger,
   ariaLabel,
   triggerClassName,
   align = "left",
   children,
}: Props): JSX.Element => {
   const [open, setOpen] = useState(false);
   const wrapRef = useRef<HTMLDivElement>(null);

   useEffect(() => {
      if (!open) return;
      const onDocMouseDown = (e: MouseEvent) => {
         if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
      };
      const onKey = (e: KeyboardEvent) => {
         if (e.key === "Escape") setOpen(false);
      };
      document.addEventListener("mousedown", onDocMouseDown);
      document.addEventListener("keydown", onKey);
      return () => {
         document.removeEventListener("mousedown", onDocMouseDown);
         document.removeEventListener("keydown", onKey);
      };
   }, [open]);

   return (
      <div
         ref={wrapRef}
         className={`dropdown ${open ? "open" : ""} dropdown-${align}`}
         onMouseEnter={() => setOpen(true)}
         onMouseLeave={() => setOpen(false)}
      >
         <button
            type="button"
            className={`dropdown-trigger ${triggerClassName ?? ""}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={ariaLabel}
            onClick={() => setOpen((v) => !v)}
         >
            {trigger}
         </button>
         <div
            className="dropdown-menu"
            role="menu"
            // Any click inside the menu (typically a menu-item button) closes
            // the dropdown. This fires after the item's own onClick.
            onClick={() => setOpen(false)}
         >
            {children}
         </div>
      </div>
   );
};
