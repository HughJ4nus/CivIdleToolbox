# CivIdle Hex Map

A small browser tool for sketching CivIdle city plans on a hex grid. Click hexes to color them by category, right-click to add a label (with quick-pick of all 285 buildings + 106 wonders + 39 natural wonders pulled from the game's source). Maps autosave to `localStorage` and can be exported / imported as JSON.

Built with Vite + React + TypeScript. Static-only, deploys to GitHub Pages.

## Develop

```sh
pnpm install
pnpm dev          # http://localhost:5173
```

## Build

```sh
pnpm build        # outputs ./dist
pnpm preview      # serve ./dist locally
```

## Deploy to GitHub Pages

GitHub Pages serves a project site at `https://<user>.github.io/<repo>/`, so the build needs that path as `base`. Build with the env var set:

```sh
VITE_BASE="/<repo-name>/" pnpm build
```

Then push `dist/` to a `gh-pages` branch (or use a GitHub Actions workflow). The included `public/.nojekyll` keeps GitHub from stripping the Vite `_assets` folder.

## Refreshing the building list

The list of wonders and buildings is generated once from the cloned CivIdle source at `../CivIdle/`. To regenerate after a game update:

```sh
pnpm extract:buildings
```

This rewrites `src/data/buildings.json` from `../CivIdle/shared/definitions/BuildingDefinitions.ts` + `../CivIdle/shared/languages/en.ts`.

## Controls

| Action | Effect |
|---|---|
| Click hex | Paint with active color |
| Click "Eraser" in legend then click hex | Remove color |
| Right-click hex | Open the label editor |
| Edit color swatch in legend | Change color (live updates the map) |
| Edit color description in legend | Update what that color means |
| Cols / rows / hex | Resize the grid (current values persist) |
| Export JSON / Import JSON | Save / load entire map |
| Clear hexes | Wipe placed colors + labels (palette kept) |
| Reset all | Wipe everything to defaults |
