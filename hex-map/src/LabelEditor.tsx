import { useEffect, useMemo, useRef, useState } from "react";
import buildings from "./data/buildings.json";

interface BuildingEntry {
   key: string;
   name: string;
   special: "WorldWonder" | "NaturalWonder" | "HQ" | null;
}

const ALL: BuildingEntry[] = buildings as BuildingEntry[];

const filterCategory = (
   category: "all" | "wonders" | "natural" | "buildings",
   q: string,
): BuildingEntry[] => {
   const needle = q.trim().toLowerCase();
   return ALL.filter((b) => {
      if (category === "wonders" && b.special !== "WorldWonder") return false;
      if (category === "natural" && b.special !== "NaturalWonder") return false;
      if (category === "buildings" && b.special !== null) return false;
      if (!needle) return true;
      return b.name.toLowerCase().includes(needle) || b.key.toLowerCase().includes(needle);
   }).slice(0, 60);
};

interface Props {
   tileKey: string;
   value: string;
   onSave: (next: string) => void;
   onClear: () => void;
   onClose: () => void;
}

export const LabelEditor = ({ tileKey, value, onSave, onClear, onClose }: Props): JSX.Element => {
   const [text, setText] = useState(value);
   const [search, setSearch] = useState("");
   const [tab, setTab] = useState<"wonders" | "natural" | "buildings" | "all">("wonders");
   const inputRef = useRef<HTMLInputElement | null>(null);

   useEffect(() => {
      setText(value);
      setSearch("");
      inputRef.current?.focus();
      inputRef.current?.select();
   }, [tileKey, value]);

   const matches = useMemo(() => filterCategory(tab, search), [tab, search]);

   const commit = (next: string) => {
      onSave(next);
   };

   return (
      <div className="label-editor">
         <div className="label-editor-header">
            <h3>Label · {tileKey}</h3>
            <button type="button" onClick={onClose} className="close-btn" aria-label="Close">
               ×
            </button>
         </div>

         <input
            ref={inputRef}
            type="text"
            value={text}
            placeholder="Type a label or pick one below"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
               if (e.key === "Enter") commit(text);
               if (e.key === "Escape") onClose();
            }}
            className="label-input"
         />

         <div className="label-editor-actions">
            <button type="button" onClick={() => commit(text)} className="primary">
               Save
            </button>
            <button
               type="button"
               onClick={() => {
                  setText("");
                  onClear();
               }}
            >
               Clear
            </button>
         </div>

         <div className="quick-tabs">
            <button
               type="button"
               className={tab === "wonders" ? "active" : ""}
               onClick={() => setTab("wonders")}
            >
               Wonders
            </button>
            <button
               type="button"
               className={tab === "natural" ? "active" : ""}
               onClick={() => setTab("natural")}
            >
               Natural
            </button>
            <button
               type="button"
               className={tab === "buildings" ? "active" : ""}
               onClick={() => setTab("buildings")}
            >
               Buildings
            </button>
            <button
               type="button"
               className={tab === "all" ? "active" : ""}
               onClick={() => setTab("all")}
            >
               All
            </button>
         </div>

         <input
            type="search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="search-input"
         />

         <ul className="quick-list">
            {matches.map((b) => (
               <li key={b.key}>
                  <button
                     type="button"
                     onClick={() => {
                        setText(b.name);
                        commit(b.name);
                     }}
                     title={b.key}
                  >
                     <span className="quick-name">{b.name}</span>
                     {b.special && <span className={`tag tag-${b.special}`}>{b.special}</span>}
                  </button>
               </li>
            ))}
            {matches.length === 0 && <li className="quick-empty">No matches.</li>}
         </ul>
      </div>
   );
};
