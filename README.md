# CivIdleToolbox

A growing collection of small tools for the idle game [CivIdle](https://store.steampowered.com/app/2181940/CivIdle/).

| Tool | What it does |
|---|---|
| [`hex-map/`](./hex-map) | Browser-based hex grid editor for sketching CivIdle city plans. Click to color, right-click to label (with quick-pick of all 285 buildings + 106 wonders + 39 natural wonders pulled from the game's source), pan + zoom the canvas, then export the map and a side panel of notes / build order to PNG or SVG. |

## Setup

Each tool is self-contained — run its own setup. For example:

```sh
cd hex-map
pnpm install
pnpm dev          # http://localhost:5173
pnpm build
```

## Working with the game's source

Some tools (e.g. the hex-map's building extractor) read directly from the upstream game source. Clone it as a sibling of the tool that needs it:

```sh
git clone https://github.com/fishpondstudio/CivIdle.git
```

The upstream `CivIdle/` directory is intentionally `.gitignore`d here — it has its own license and asset restrictions.

## License

Code in this repo is MIT (unless a tool's own `LICENSE` says otherwise). The game itself is a separate project under GPL-3.0 with restrictive asset terms; nothing in this repo redistributes its assets.
