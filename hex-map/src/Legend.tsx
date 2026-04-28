import { useState } from "react";
import type { PaletteEntry } from "./types";

interface Props {
   palette: PaletteEntry[];
   activeId: string | null;
   counts: Map<string, number>;
   onSelect: (id: string | null) => void;
   onChangeColor: (id: string, color: string) => void;
   onChangeLabel: (id: string, label: string) => void;
   onAdd: () => void;
   onRemove: (id: string) => void;
}

const randomColor = (): string => {
   const hue = Math.floor(Math.random() * 360);
   return `hsl(${hue} 70% 55%)`;
};

export const Legend = ({
   palette,
   activeId,
   counts,
   onSelect,
   onChangeColor,
   onChangeLabel,
   onAdd,
   onRemove,
}: Props): JSX.Element => {
   const [erasing, setErasing] = useState(activeId === null);

   return (
      <div className="legend">
         <div className="legend-header">
            <h3>Palette</h3>
            <button type="button" onClick={onAdd} title="Add color">
               + add
            </button>
         </div>
         <ul className="legend-list">
            <li
               className={`legend-row legend-eraser ${activeId === null ? "active" : ""}`}
               onClick={() => {
                  setErasing(true);
                  onSelect(null);
               }}
            >
               <span className="legend-swatch eraser-swatch">⌫</span>
               <span className="legend-label">Eraser (clear color)</span>
            </li>
            {palette.map((p) => (
               <li
                  key={p.id}
                  className={`legend-row ${activeId === p.id ? "active" : ""}`}
                  onClick={() => {
                     setErasing(false);
                     onSelect(p.id);
                  }}
               >
                  <input
                     type="color"
                     value={p.color.startsWith("#") ? p.color : "#888888"}
                     onChange={(e) => onChangeColor(p.id, e.target.value)}
                     onClick={(e) => e.stopPropagation()}
                     className="legend-swatch"
                     aria-label="Color"
                  />
                  <input
                     type="text"
                     value={p.label}
                     onChange={(e) => onChangeLabel(p.id, e.target.value)}
                     onClick={(e) => e.stopPropagation()}
                     className="legend-label-input"
                     placeholder="Description"
                  />
                  <span className="legend-count">{counts.get(p.id) ?? 0}</span>
                  <button
                     type="button"
                     onClick={(e) => {
                        e.stopPropagation();
                        onRemove(p.id);
                     }}
                     title="Remove color"
                     className="legend-remove"
                  >
                     ×
                  </button>
               </li>
            ))}
         </ul>
         <p className="legend-hint">
            Click a color to make it active. Click any hex to paint it. Right-click a hex to edit its label.
            {erasing ? " Eraser is active." : ""}
         </p>
      </div>
   );
};

export const newPaletteEntry = (existing: PaletteEntry[]): PaletteEntry => {
   const ids = new Set(existing.map((p) => p.id));
   let i = existing.length + 1;
   while (ids.has(`p${i}`)) i++;
   return { id: `p${i}`, color: randomColor(), label: "New category" };
};
