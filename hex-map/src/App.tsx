import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Annotations } from "./Annotations";
import { exportPng, exportSvg } from "./export";
import { computeCenterShift } from "./resize";
import { HexGrid } from "./HexGrid";
import { LabelEditor } from "./LabelEditor";
import { Legend, newPaletteEntry } from "./Legend";
import { loadState, saveState } from "./storage";
import {
   initialMapState,
   newAnnotation,
   type Annotation,
   type HexCell,
   type MapState,
} from "./types";

const STORAGE_KEYS_HEX_SIZE = "cividle-hex-map:hexSize";

export const App = (): JSX.Element => {
   const [state, setState] = useState<MapState>(() => loadState());
   const [hexSize, setHexSize] = useState<number>(() => {
      const stored = Number(localStorage.getItem(STORAGE_KEYS_HEX_SIZE));
      return Number.isFinite(stored) && stored > 0 ? stored : 26;
   });
   const [selected, setSelected] = useState<string | null>(null);
   const [editorOpen, setEditorOpen] = useState(false);
   const fileInputRef = useRef<HTMLInputElement | null>(null);

   useEffect(() => {
      saveState(state);
   }, [state]);

   useEffect(() => {
      localStorage.setItem(STORAGE_KEYS_HEX_SIZE, String(hexSize));
   }, [hexSize]);

   const counts = useMemo(() => {
      const m = new Map<string, number>();
      for (const cell of Object.values(state.cells)) {
         if (cell.colorId) m.set(cell.colorId, (m.get(cell.colorId) ?? 0) + 1);
      }
      return m;
   }, [state.cells]);

   const updateCell = useCallback((key: string, patch: Partial<HexCell> | null) => {
      setState((prev) => {
         const cells = { ...prev.cells };
         if (patch === null) {
            delete cells[key];
         } else {
            const existing = cells[key] ?? {};
            const next = { ...existing, ...patch };
            // Remove cell entirely if it's empty.
            if (!next.colorId && !next.text) delete cells[key];
            else cells[key] = next;
         }
         return { ...prev, cells };
      });
   }, []);

   const handleHexClick = useCallback(
      (key: string) => {
         setSelected(key);
         updateCell(key, { colorId: state.activeColorId ?? undefined });
         if (state.activeColorId === null) {
            // Eraser: also clear color but keep text.
            updateCell(key, { colorId: undefined });
         }
      },
      [state.activeColorId, updateCell],
   );

   const handleHexContextMenu = useCallback((key: string, ev: React.MouseEvent) => {
      ev.preventDefault();
      setSelected(key);
      setEditorOpen(true);
   }, []);

   const onSelectActive = useCallback((id: string | null) => {
      setState((prev) => ({ ...prev, activeColorId: id }));
   }, []);

   const onChangeColor = useCallback((id: string, color: string) => {
      setState((prev) => ({
         ...prev,
         palette: prev.palette.map((p) => (p.id === id ? { ...p, color } : p)),
      }));
   }, []);

   const onChangeLabel = useCallback((id: string, label: string) => {
      setState((prev) => ({
         ...prev,
         palette: prev.palette.map((p) => (p.id === id ? { ...p, label } : p)),
      }));
   }, []);

   const onAddColor = useCallback(() => {
      setState((prev) => ({
         ...prev,
         palette: [...prev.palette, newPaletteEntry(prev.palette)],
      }));
   }, []);

   const onRemoveColor = useCallback((id: string) => {
      setState((prev) => {
         const palette = prev.palette.filter((p) => p.id !== id);
         const cells = { ...prev.cells };
         for (const k of Object.keys(cells)) {
            if (cells[k].colorId === id) {
               const cell = { ...cells[k] };
               delete cell.colorId;
               if (!cell.text) delete cells[k];
               else cells[k] = cell;
            }
         }
         return {
            ...prev,
            palette,
            cells,
            activeColorId: prev.activeColorId === id ? null : prev.activeColorId,
         };
      });
   }, []);

   const onResize = useCallback((cols: number, rows: number) => {
      const c = Math.max(1, Math.min(80, cols));
      const r = Math.max(1, Math.min(80, rows));
      setState((prev) => {
         const colShift = computeCenterShift(prev.cols, c);
         const rowShift = computeCenterShift(prev.rows, r);
         const cells: Record<string, HexCell> = {};
         for (const [k, v] of Object.entries(prev.cells)) {
            const [cc, rr] = k.split(",").map(Number);
            const nc = cc + colShift;
            const nr = rr + rowShift;
            if (nc >= 0 && nc < c && nr >= 0 && nr < r) {
               cells[`${nc},${nr}`] = v;
            }
         }
         return { ...prev, cols: c, rows: r, cells };
      });
   }, []);

   const onClearAll = useCallback(() => {
      if (!confirm("Clear all hexes? (Palette is kept.)")) return;
      setState((prev) => ({ ...prev, cells: {} }));
      setSelected(null);
   }, []);

   const onResetAll = useCallback(() => {
      if (!confirm("Reset everything to defaults? Palette and cells will be wiped.")) return;
      setState(initialMapState(state.cols, state.rows));
      setSelected(null);
   }, [state.cols, state.rows]);

   const onExport = useCallback(() => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safe = state.title.replace(/[^a-z0-9_-]+/gi, "_") || "hex-map";
      a.href = url;
      a.download = `${safe}.json`;
      a.click();
      URL.revokeObjectURL(url);
   }, [state]);

   const onImportClick = useCallback(() => fileInputRef.current?.click(), []);

   const onImportFile = useCallback((file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
         try {
            const parsed = JSON.parse(String(reader.result)) as MapState;
            if (parsed.version !== 1 || !parsed.cells || !parsed.palette) {
               alert("That file doesn't look like a hex-map JSON.");
               return;
            }
            // Backfill new fields if importing an older save.
            if (typeof parsed.notes !== "string") parsed.notes = "";
            if (!Array.isArray(parsed.annotations)) parsed.annotations = [];
            setState(parsed);
         } catch (e) {
            alert(`Failed to import: ${(e as Error).message}`);
         }
      };
      reader.readAsText(file);
   }, []);

   // ── Export-panel handlers (notes + annotations) ───────────────────────
   const onNotesChange = useCallback((notes: string) => {
      setState((prev) => ({ ...prev, notes }));
   }, []);

   const onAnnotationAdd = useCallback(() => {
      setState((prev) => ({
         ...prev,
         annotations: [...prev.annotations, newAnnotation(prev.annotations, prev.activeColorId)],
      }));
   }, []);

   const onAnnotationUpdate = useCallback((id: string, patch: Partial<Annotation>) => {
      setState((prev) => ({
         ...prev,
         annotations: prev.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      }));
   }, []);

   const onAnnotationRemove = useCallback((id: string) => {
      setState((prev) => ({ ...prev, annotations: prev.annotations.filter((a) => a.id !== id) }));
   }, []);

   const onAnnotationMove = useCallback((id: string, dir: -1 | 1) => {
      setState((prev) => {
         const idx = prev.annotations.findIndex((a) => a.id === id);
         if (idx < 0) return prev;
         const target = idx + dir;
         if (target < 0 || target >= prev.annotations.length) return prev;
         const next = prev.annotations.slice();
         const [item] = next.splice(idx, 1);
         next.splice(target, 0, item);
         return { ...prev, annotations: next };
      });
   }, []);

   const onExportPng = useCallback(async () => {
      try {
         await exportPng(state, { hexSize: Math.max(28, hexSize), pixelRatio: 2 });
      } catch (e) {
         alert(`PNG export failed: ${(e as Error).message}`);
      }
   }, [state, hexSize]);

   const onExportImageSvg = useCallback(() => {
      exportSvg(state, { hexSize: Math.max(28, hexSize) });
   }, [state, hexSize]);

   const selectedCell = selected ? state.cells[selected] : undefined;

   return (
      <div className="app">
         <header className="toolbar">
            <input
               type="text"
               value={state.title}
               onChange={(e) => setState((prev) => ({ ...prev, title: e.target.value }))}
               className="title-input"
               aria-label="Map title"
            />
            <div className="toolbar-group">
               <label>
                  cols
                  <input
                     type="number"
                     value={state.cols}
                     min={1}
                     max={80}
                     onChange={(e) => onResize(Number(e.target.value), state.rows)}
                  />
               </label>
               <label>
                  rows
                  <input
                     type="number"
                     value={state.rows}
                     min={1}
                     max={80}
                     onChange={(e) => onResize(state.cols, Number(e.target.value))}
                  />
               </label>
               <label>
                  hex
                  <input
                     type="range"
                     min={12}
                     max={60}
                     value={hexSize}
                     onChange={(e) => setHexSize(Number(e.target.value))}
                  />
               </label>
            </div>
            <div className="toolbar-group">
               <button type="button" onClick={onExportPng} className="primary" title="Render map + side panel to PNG">
                  Export PNG
               </button>
               <button type="button" onClick={onExportImageSvg} title="Render map + side panel to SVG">
                  Export SVG
               </button>
               <button type="button" onClick={onExport}>
                  Save JSON
               </button>
               <button type="button" onClick={onImportClick}>
                  Load JSON
               </button>
               <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                     const file = e.target.files?.[0];
                     if (file) onImportFile(file);
                     e.target.value = "";
                  }}
               />
               <button type="button" onClick={onClearAll}>
                  Clear hexes
               </button>
               <button type="button" onClick={onResetAll} className="danger">
                  Reset all
               </button>
            </div>
         </header>

         <main className="main">
            <aside className="sidebar">
               <Legend
                  palette={state.palette}
                  activeId={state.activeColorId}
                  counts={counts}
                  onSelect={onSelectActive}
                  onChangeColor={onChangeColor}
                  onChangeLabel={onChangeLabel}
                  onAdd={onAddColor}
                  onRemove={onRemoveColor}
               />
               {editorOpen && selected && (
                  <LabelEditor
                     tileKey={selected}
                     value={selectedCell?.text ?? ""}
                     onSave={(text) => {
                        updateCell(selected, { text: text.trim() ? text : undefined });
                     }}
                     onClear={() => updateCell(selected, { text: undefined })}
                     onClose={() => setEditorOpen(false)}
                  />
               )}
               {!editorOpen && (
                  <p className="hint-block">
                     <strong>Tip.</strong> Right-click a hex to set a text label. The Wonders tab is pre-populated with all 106 wonders from the game.
                  </p>
               )}

               <Annotations
                  annotations={state.annotations}
                  palette={state.palette}
                  onAdd={onAnnotationAdd}
                  onUpdate={onAnnotationUpdate}
                  onRemove={onAnnotationRemove}
                  onMove={onAnnotationMove}
                  notes={state.notes}
                  onNotesChange={onNotesChange}
               />
            </aside>

            <section className="canvas-wrap">
               <HexGrid
                  state={state}
                  hexSize={hexSize}
                  selected={selected}
                  onHexClick={handleHexClick}
                  onHexContextMenu={handleHexContextMenu}
               />
            </section>
         </main>
      </div>
   );
};
