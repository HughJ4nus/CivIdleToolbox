import { useEffect, useRef } from "react";

interface Props {
   svg: string;
   title: string;
   onClose: () => void;
   onExportPng: () => void;
   onExportSvg: () => void;
}

/**
 * Preview of the export output. The SVG body is built by `buildExportSvg`
 * (already escaped + sanitised), so injecting it via `dangerouslySetInnerHTML`
 * is safe.
 *
 * Closes on Escape, on backdrop click, and on the explicit Close button.
 */
export const PreviewModal = ({
   svg,
   title,
   onClose,
   onExportPng,
   onExportSvg,
}: Props): JSX.Element => {
   const bodyRef = useRef<HTMLDivElement>(null);

   useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
         if (e.key === "Escape") onClose();
      };
      document.addEventListener("keydown", onKey);
      // Lock background scroll while modal is open.
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
         document.removeEventListener("keydown", onKey);
         document.body.style.overflow = prevOverflow;
      };
   }, [onClose]);

   return (
      <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Preview of ${title}`}>
         <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <header className="modal-header">
               <h3>Preview · {title}</h3>
               <div className="modal-actions">
                  <button type="button" onClick={onExportPng} className="primary">
                     Export PNG
                  </button>
                  <button type="button" onClick={onExportSvg}>
                     Export SVG
                  </button>
                  <button type="button" onClick={onClose} className="close-btn" aria-label="Close preview">
                     ×
                  </button>
               </div>
            </header>
            <div
               ref={bodyRef}
               className="modal-body preview-body"
               // svg is built by buildExportSvg → all user content is run
               // through escapeXml + sanitizeMapState before reaching here.
               dangerouslySetInnerHTML={{ __html: svg }}
            />
         </div>
      </div>
   );
};
