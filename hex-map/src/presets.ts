// Premade designs surfaced in the title-input dropdown. Each preset returns
// a complete MapState; the loader runs it through sanitizeMapState before
// applying, so the same safety net as user-imported JSON applies.
//
// To add a preset:
//   1. Build the design in the editor.
//   2. Export it as JSON via the toolbar.
//   3. Open the JSON, paste its contents into a new `build: () => ({...})`
//      below, and give it an `id` + display `name`.
//   4. Reload — it'll show up in the dropdown.

import { sanitizeMapState } from "./sanitize";
import { initialMapState, type MapState } from "./types";

export interface Preset {
   id: string;
   name: string;
   build: () => MapState;
}

export const PRESETS: Preset[] = [
   {
      id: "blank-45x45",
      name: "Blank 45×45",
      build: () => ({ ...initialMapState(45, 45), title: "Untitled Design" }),
   },
];

export const loadPreset = (preset: Preset): MapState => sanitizeMapState(preset.build());
