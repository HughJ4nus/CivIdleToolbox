# CivIdle — Context for Tool Building

Source: https://github.com/fishpondstudio/CivIdle (cloned to `./CivIdle/`, GPL-3.0)
Game: Idle/incremental civilization sim, available on Steam, iOS, Android.

This document is a working reference for building **third-party tools** for CivIdle (calculators, save inspectors, optimization helpers, etc.). It maps the code so we can find things fast.

---

## 1. Stack overview

| Layer | Tech |
|---|---|
| Client (game) | TypeScript, React 18, PixiJS 7.4 (canvas), Vite 7, pnpm |
| Worker | Web Worker for save (de)compression (`fflate` deflate/inflate) |
| Server (private) | TS submodule `CivIdle-Server` — **not in repo** (`.gitmodules` points to a private repo). Client imports `ServerImpl` type only |
| Transport | WebSocket + msgpack (`@msgpack/msgpack`) carrying JSON-RPC 2.0 messages |
| Persistence | IndexedDB (web), `@capacitor/preferences` (mobile), Steamworks file (`SteamClient.fileWriteCompressed`) |
| Native | Electron (desktop), Capacitor 6 (iOS/Android), Steamworks (`src/scripts/native/Steamworks.d.ts`) |
| Other libs | `@xyflow/react` (tech tree), `@dagrejs/dagre` (graph layout), `pixi-sound`, `pixi-filter-outline`, `tippy.js`, `xp.css`, `uplot` (charts), `@sentry/browser` |

### Repo layout (top-level)

```
CivIdle/
├── shared/                  # game logic + data, used by both client & server
│   ├── definitions/         # static data: buildings, materials, tech, cities, great people, upgrades, ideologies, traditions, religions, advisors, world map, patch notes
│   ├── logic/               # runtime simulation: tick, transports, building logic, happiness, rebirth, tech, tile, constants
│   ├── utilities/           # Helper, Grid, Hex, Database (types), TypedEvent, Random, i18n, ServerNow, Type, Vector2…
│   ├── languages/           # locale dictionaries (en, de, fr, ru, zh-CN/TW, etc.)
│   └── thirdparty/          # vendored: TRPCClient, wyhash
├── src/scripts/             # client-only: rendering, UI, scenes, IO, native bridges
│   ├── Bootstrap.tsx        # game start sequence
│   ├── Global.tsx           # save/load orchestration, idb access, observable hooks
│   ├── MigrateSavedGame.ts  # forward-migration of older save shapes
│   ├── Route.ts, main.tsx   # app entry / routing
│   ├── logic/               # client-side ticks, heartbeat, achievements, todo, tutorial
│   ├── rpc/                 # RPCClient.tsx (WebSocket+msgpack), SteamClient
│   ├── scenes/              # Pixi scenes: WorldScene, TechTreeScene, PlayerMapScene, FlowGraphScene, ConquestScene
│   ├── ui/                  # ~155 React components/modals/pages
│   ├── workers/             # Compress.ts (main thread API), CompressWorker.ts (deflate/inflate)
│   ├── visuals/, textures/, fonts/, sounds/, css/, images/
│   └── utilities/           # SceneManager, GameTicker, Singleton, IAP, BrowserStorage…
├── server/                  # EMPTY local checkout — private submodule (CivIdle-Server)
├── electron/, android/, ios/, capacitor.config.ts
├── packages/gameanalytics/  # vendored analytics
├── build/                   # tooling: image optimization, bitmap fonts, achievement gen, releases
└── public/, assets/, icons/, .vscode/, .zed/, README.md, biome.json, vite.config.ts
```

---

## 2. Core data model (the bits a tool needs)

All canonical types live in `shared/`. The static data is class instances of `XxxDefinitions` exposed via the singleton `Config`:

```
shared/logic/Config.ts
export const Config = {
  Building, Material, GreatPerson, City, Tech, TechAge,
  Tradition, Religion, Ideology, Upgrade,
  BuildingTier, BuildingTech, BuildingTechAge, BuildingCity,
  MaterialTier, MaterialTech, MaterialPrice,
  BuildingHash, MaterialHash,
}
```

### Definitions (counts & shapes)

- **296 buildings** — `shared/definitions/BuildingDefinitions.ts` (2618 lines).
  Shape `IBuildingDefinition`: `{ name, input, output, construction?, vision?, deposit?, power?, max?, special?, wikipedia?, desc? }`. `special` ∈ `BuildingSpecial.{HQ, WorldWonder, NaturalWonder}`. Headquarter is the only `HQ`. `max:1` → wonder.
- **~121 materials** — `shared/definitions/MaterialDefinitions.ts`.
  `Worker, Power, Science, Warp, Wheat, Wood, Stone, Iron, Coal, Oil, Aluminum, NaturalGas, Uranium, Steel, Concrete, … FusionFuel`. `NoPrice` and `NoStorage` sets exclude virtual resources (Worker/Power/Science/Festival/Warp/Explorer/Teleport/Cycle/TradeValue).
- **~110 techs** across 10 ages — `shared/definitions/TechDefinitions.ts`.
  Ages (in `TechAgeDefinitions`): `StoneAge`(idx 0), `BronzeAge`(1), `IronAge`(2), `ClassicalAge`(3), `MiddleAge`(4), `RenaissanceAge`(5), `IndustrialAge`(6), `WorldWarAge`(7), `ColdWarAge`(8), `InformationAge`(9). Tech node has `column` (0..27), `requireTech[]`, optional `revealDeposit[]`, plus all `IUnlockable` fields below.
- **17 cities** — `Rome, Athens, Memphis, Beijing, NewYork, Babylon, Kyoto, German, English, French, Ottoman, Brazilian, Indian, Australian, Russian, Canadian, Carthaginian` (`CityDefinitions.ts`). Each has `deposits` (per-tile probabilities), `size`, `naturalWonders`, `uniqueBuildings`, `uniqueMultipliers`, `requireGreatPeopleLevel`, `requireSupporterPack`, `festivalDesc`.
- **~149 great people** — `shared/definitions/GreatPersonDefinitions.ts`. Two flavours: `Normal` (custom `tick(self, level, source)` adding multipliers) and `Adaptive` (auto-applies based on age/buildings). `boostOf({...})` is the common helper that sets per-building output/storage multipliers. Level is `getGreatPersonThisRunLevel(amount) = Σ 1/i`.
- **Upgrades / Traditions / Religions / Ideologies** — separate `*Definitions.ts`. `IUpgradeDefinition` extends `IUnlockable` with `requireResources` and optional `tech`.

### `IUnlockable` (the building block multipliers attach to)

```ts
interface IUnlockable {
  name: () => string;
  unlockBuilding?: Building[];
  buildingMultiplier?: Partial<Record<Building, Multiplier>>;
  globalMultiplier?: Partial<Record<keyof GlobalMultipliers, number>>;
  additionalUpgrades?: () => string[];
  tick?: (gs: GameState) => void;
  onUnlocked?: (gs: GameState) => void;
}
```

Multipliers come in `output | worker | storage | input` flavours and are accumulated each tick into `Tick.next` from `shared/logic/TickLogic.ts` (`MultiplierWithSource`, `MultiplierWithStability`, `GlobalMultipliers`).

### Game state: `shared/logic/GameState.ts`

```ts
class SavedGame { current = new GameState(); options = new GameOptions(); }

class GameState {
  id = uuid4();
  city: City = "Rome";
  unlockedTech: PartialSet<Tech>;
  unlockedUpgrades: PartialSet<Upgrade>;
  tiles: Map<Tile, ITileData>;            // Tile = packed (x<<16)|y number
  tick: number; seconds: number;
  greatPeople: PartialTabulate<GreatPerson>;
  greatPeopleChoicesV2: GreatPeopleChoiceV2[];
  transportId: number;
  lastPriceUpdated: number;
  isOffline: boolean;
  rebirthed: boolean;
  festival: boolean;
  tradeValue: number;
  favoriteTiles: Set<Tile>;
  claimedGreatPeople: number;
  valueTrackers: Map<ValueToTrack, IValueTracker>;
  speedUp: number;                        // Petra / time warp
  pinStatPanel: boolean;
  adaptiveGreatPeople: Map<GreatPerson, Building>;
  flags: GameStateFlags;                  // bitfield: HasDemolishedBuilding, HasUsedTimeWarp, HasThreeAllies
  lastClientTickAt: number;
  clientOfflineSec: number;
  watchedResources: Set<Material>;
  mapSize: number;                        // Rome default = 45
}

class GameOptions {
  // 70+ fields: useModernUI, language, userId, checksum, sidePanelWidth, fontSizeScale,
  // shortcuts, themeColors, buildingColors, resourceColors, defaultStockpileCapacity/Max,
  // defaultProductionPriority/ConstructionPriority/WonderConstructionPriority,
  // greatPeople: Partial<Record<GreatPerson, {level, amount}>>,   // permanent
  // ageWisdom: PartialTabulate<TechAge>,
  // rebirthInfo: RebirthInfo[],
  // hideResourcePanelSections, supporterPackPurchased, useMirrorServer, …
}
```

`shared/logic/Tile.ts` defines `IBuildingData` (level, desiredLevel, status, capacity, stockpileCapacity/Max, electrification, productionPriority/constructionPriority, options, suspendedInput, inputMode, maxInputDistance, resources) and many subtype interfaces for special wonders: `IMarketBuildingData`, `IResourceImportBuildingData`, `IWarehouseBuildingData`, `ICloneBuildingData`, `ITraditionBuildingData`, `IReligionBuildingData`, `IIdeologyBuildingData`, `IGreatPeopleBuildingData`, `IZugspitzeBuildingData` (Map<TechAge,GreatPerson>), `ILouvreBuildingData`, `ICentrePompidouBuildingData` (Set<City>), `ISwissBankBuildingData`, `IItaipuDamBuildingData`, `IAuroraBorealisBuildingData`, `IChateauFrontenacBuildingData`, `IDinosaurProvincialParkBuildingData`. `BuildingStatus = "building" | "upgrading" | "completed"`. `BuildingInputMode = Distance(0) | Amount(1) | StoragePercentage(2)`.

Constants worth knowing (`shared/logic/Constants.ts`):
`SAVE_FILE_VERSION = 1`, `SAVE_KEY = "CivIdle"`, `MAX_OFFLINE_PRODUCTION_SEC = 4h`, `SCIENCE_VALUE = 0.2`, `MAX_TARIFF_RATE = 0.1`, `MARKET_DEFAULT_TRADE_COUNT = 5`, `MAX_EXPLORER = 10`, `EXPLORER_SECONDS = 60`, `MAX_PETRA_SPEED_UP = 16`, `FESTIVAL_CONVERSION_RATE = 100`, `TRIBUNE_TRADE_VALUE_PER_MINUTE = 10000`, `TOWER_BRIDGE_GP_PER_CYCLE = 3600`, `EAST_INDIA_COMPANY_BOOST_PER_EV = 2000`. URLs to discord, anticheat FAQ, Steam guide, supporter pack DLC, etc.

`calculateTierAndPrice()` in Constants.ts derives `Config.MaterialTier`, `Config.MaterialPrice`, `Config.BuildingTier`, `Config.BuildingHash` at boot from recipe graph + tech columns.

### Tile coordinates

Hex grid, axial-style (`shared/utilities/Hex.ts`) wrapped by `shared/utilities/Grid.ts`. The world is offset-coord; a tile is encoded as `Tile = (x << 16) | y` (a single number) — see `pointToTile` / `tileToPoint` in `shared/utilities/Helper.ts`. Grid size for Rome is 45; default tile pixel size is `TILE_SIZE = 64` (`GameStateLogic.ts`).

Player world map is a separate 200×100 grid (`MAP_MAX_X/Y` in `Database.ts`), used for player-tile claims, tariffs, trade tile bonuses (`TRADE_TILE_BONUS = 5`, `TRADE_TILE_NEIGHBOR_BONUS = 1`, `TRADE_TILE_ALLY_BONUS = 2`).

---

## 3. Tick / simulation pipeline

Driven from `src/scripts/utilities/GameTicker.ts`:

- Pixi `ticker` runs `tickEveryFrame(gs, dt)` each frame (after `Actions.tick(dt)` advances tweens).
- A `setInterval` runs `tickEverySecond(gs, false)` every `1000 / speedUp` ms (Petra speed-up scales the interval).
- Save autosave cadence: every 60s on Steam, 10s elsewhere. Heartbeat: 60s prod / 10s dev.

`shared/logic/Update.ts` (1087 lines) is the heart. Key functions:
- `tickUnlockable(IUnlockable, source, gs)` — applies multipliers + custom `tick(gs)`.
- `tickTransports(gs)` — moves every queued `ITransportationDataV2` along `Transports` array; consumes worker fuel; on arrival calls `completeTransport`.
- `tickPower(gs)` — flood-fill power grid from `Tick.next.powerPlants` over neighbour hexes.
- `tickPrice(gs)` — periodic resource price updates.
- `transportAndConsumeResources`, `getSortedTiles`, `addTransportation`, `addMultiplier`, `clearTransportSourceCache`, `tickTiles` (queued into `tickTileQueue`).

Public TypedEvents (subscribe with `.on/.off`): `OnPriceUpdated`, `OnBuildingComplete`, `OnBuildingOrUpgradeComplete`, `OnTechUnlocked`, `OnBuildingProductionComplete`, `RequestFloater`, `RequestChooseGreatPerson`, `OnEligibleAccountRankUpdated`. `GameStateChanged` and `GameOptionsChanged` are emitted whenever `notifyGameStateUpdate()` / `notifyGameOptionsUpdate()` runs.

`shared/logic/TickLogic.ts` defines `Tick.current` / `Tick.next` (frozen vs mutable per-tick scratch). `ITickData` carries everything derived per tick: workers, multipliers per tile/building, electrified tiles, power grid, happiness, special-buildings index, total empire value, resource amounts/values, transit, scienceProduced.

`shared/logic/IntraTickCache.ts` (419 lines) memoizes derived structures (grid, building IO, types, transport stats, fuel-by-target) cleared by `clearIntraTickCache()` at end of each `tickEverySecond`.

`shared/logic/RebirthLogic.ts`:
- `getRebirthGreatPeopleCount() = clamp(floor(cbrt(totalValue/1e6)/4), 0, ∞)`
- `getValueRequiredForGreatPeople(n) = (4n)^3 * 1e6`
- `getGreatPersonThisRunLevel(amount) = Σ_{i=1..amount} 1/i`
- `getGreatPersonUpgradeCost(gp, level)` is `Math.pow(2, level-1)` (`Fibonacci` is special).
- `getTotalGreatPeopleUpgradeCost(gp, target)` sums the geometric series.
- `getTribuneUpgradeMaxLevel(age)`, etc.

`shared/logic/HappinessLogic.ts` computes happiness; `shared/logic/InitializeGameState.ts` seeds new games (places `Headquarter` at center, `LoggingCamp`/`StoneQuarry`/`Aqueduct` near nearest deposits, unlocks column-0 techs).

---

## 4. Save format

`shared/logic/GameStateLogic.ts`:
```ts
serializeSave(save) -> string  // structured-cloned, transports flattened back into building.resources, then JSON.stringify with `replacer` (Map/Set become {$type,value}); checksum = wyhash(serializedLite, 0).toString(16) injected into options.checksum
deserializeSave(str) -> SavedGame  // JSON.parse with `reviver`; checksum compared back; `transportation` / `transportationV2` legacy fields auto-pass
```

`src/scripts/Global.tsx`:
- `SaveKey = "CivIdle"` (legacy compressed binary form), `SaveKeyNew = "CivIdleNew"` (uncompressed JSON string).
- Steam: `SteamClient.fileWriteCompressed(SaveKey, serialized)` / `fileReadBytes` then `decompressSave`.
- Mobile: `Capacitor Preferences` (`SaveKeyNew` JSON, falling back to `SaveKey` base64+deflated).
- Web: IndexedDB via `idb-keyval`-style helpers (`idbGet`/`idbSet` in `utilities/BrowserStorage`).
- `compressSave(save)` = `compress(TextEncoder.encode(serializeSave(save)))` where `compress`/`decompress` post to `workers/CompressWorker.ts` which calls `fflate` `deflateSync`/`inflateSync`.
- `isGameDataCompatible(gs)` checks `options.version === SAVE_FILE_VERSION` then runs `migrateSavedGame(gs)` and merges into `savedGame`.

`src/scripts/MigrateSavedGame.ts` rewrites legacy fields: invalid tiles deleted, renamed buildings (`Cathedral` removed, `DiaryFarm` → `DairyFarm`, `Skyscrapper` → `Skyscraper`), Petra `speedUp`/`offlineProductionPercent`/`Warp` migrated to `GameState.speedUp` / `GameOptions.offlineProductionPercent` / Headquarter `Warp` resource, etc.

**Tool implication:** to read a real player save you need to:
1. Read the file (Steam: `~/.steam/.../remote/CivIdle` or whatever the Steam Cloud user-data dir is, Web: IndexedDB key `CivIdle` → `Uint8Array`, mobile: Preferences plist/xml).
2. If binary: `inflate` (zlib/deflate) → UTF-8 string. If string: parse directly.
3. `JSON.parse` with reviver that converts `{$type:"Map",value:[...]}` and `{$type:"Set",value:[...]}` back into `Map`/`Set`.
4. Optionally verify wyhash checksum (`shared/thirdparty/wyhash.ts`, called as `wyhash(bytes, 0n).toString(16)` over `serializeSaveLite` with `options.checksum = null`).

---

## 5. Networking / RPC surface

`src/scripts/rpc/RPCClient.tsx`:
- WebSocket to `wss://de.cividle.com` (default) or `wss://us.cividle.com` (mirror), or `?server=` query param in dev (default `ws://localhost:8000`).
- Auth params in URL: Steam (`appId`, `ticket`, `steamId`, `userId`, `version`, `build`, `gameId`, `hash`, `checksum`), Android (Google Play `serverAuthToken`), iOS (Game Center ticket).
- Frames are `@msgpack/msgpack` encode/decode of JSON-RPC 2.0 envelopes `{ jsonrpc:"2.0", id, method, params }`.
- Dispatched `MessageType` tagged messages: `Chat | RPC | Welcome | Trade | Map | PendingClaim` (see `shared/utilities/Database.ts`).
- TRPC-style proxy `client = rpcClient<ServerImpl>({ request })`; `ServerImpl` is imported as a *type* from the private `server/src/Server.ts` submodule.

### RPC methods called by the client (complete list, grep’d from `src/scripts/`):

```
addPendingClaim, addTrade, announce, cancelTrade,
changeColor, changeHandle, changePlayerLevel,
checkInSave, checkOutSaveEnd, checkOutSaveStart, claimTile,
claimTradesV, clearConnection, clearTileCooldown,
doGreatPeopleRecovery, fillTrade,
getAchievedAchievements, getAllAchievements, getBuildings,
getEmpireValueRank, getGreatPeopleLevelRank, getGreatPeopleRecovery,
getHallOfFame, getMods, getMutedPlayers, getOnlinePlayerCount,
getOptionsFromServer, getPendingClaims, getPlayTime, getPlayerAttr,
getSlowedPlayer, getSupporters, getTotalPlayerCount,
getTradeTileBonusVotes, getVotedBoosts,
heartbeatV, listSpecialPlayers, makeMod, mutePlayer,
occupyTile, queryChecksums, queryCloudSave, queryGreatPeopleRecovery,
queryPlayer, queryPlayerSave, queryRankUp, queryRelatedPlayers,
rankUp, rebirthV, removePlayerFromMap, removeTrade, renamePlayer,
requestPassCode, rerollBoostVotes, rerollTradeTileVotes, resetRank,
saveOptionsToServer, setGreatPeopleRecovery, setPlayTime, setPlayerAttr,
setTariffRate, slowPlayer, tabulateVotedBoost, updateGameId, upgrade,
verifyPassCode, verifyReceipt, voteBoosts, voteTradeTileBonus
```

(Server impl is closed source. We can only call these methods if we successfully complete the same auth handshake — so any tool that talks to the live server will likely impersonate the Steam/Mobile login flow, which **probably violates ToS**. For tools that ingest local saves only, we don’t need any of this.)

### Database / wire types (`shared/utilities/Database.ts`)

Important enums/interfaces tools will see in saves or RPC payloads:
- `IUser` (handle, color, level, flag, attr, totalPlayTime, tradeValues, lastGameId, heartbeatData, gameOptions…)
- `IChat`, `IClientTrade`, `ITrade`, `IClientMapEntry`, `IPendingClaim`, `IAddTradeRequest`, `IFillTradeRequest`, `IVotedBoost`/`IVotedBoostOption`
- `AccountLevel = Tribune(0) | Quaestor(1) | Aedile(2) | Praetor(3) | Consul(4) | Caesar(5) | Augustus(6)`
  - Required playtime hours: 0 / 48 / 200 / 500 / 1000 / 1500 / 2000
  - Required total GP level: 0 / 0 / 200 / 500 / 1000 / 1500 / 2000
  - `TradeTileReservationDays`: 1, 3, 5, 7, 9, 9, 9
- `UserAttributes` bitfield: `Mod, DLC1..DLC5, Banned, TribuneOnly, DisableRename, SuspendTrade, Suspicious, Desynced, OverrideRankUp`
- `Platform = None | Steam | iOS | Android` (deduced from `userId` prefix `steam:` / `ios:` / `android:`)
- `MoveTileCooldown = 12h`, `MAP_MAX_X = 200`, `MAP_MAX_Y = 100`
- `ChatChannels = en, zh, de, ru, fr, kr, jp, es, pt`
- `ServerWSErrorCode = Ok(0), BadRequest(3000), InvalidTicket(3001), NotAllowed(3002), Background(4000)`

---

## 6. Localization

Locale dictionaries live in `shared/languages/{en,de,fr,ru,zh-CN,zh-TW,kr,nl,pt-BR,es,cz,tr,jp,fi,dk}.ts`. `EN` is the canonical key set. `i18n.ts` exposes `L` (key map) and `$t(key, params?)` for runtime translation. UI labels in definitions are `() => $t(L.X)` — they only resolve once `syncLanguage(...)` has run.

---

## 7. Useful entry points for tooling

If we want to **reuse the game's own logic** (recommended — it's GPL anyway):
- Import from `shared/` directly. The folder has no React, no Pixi, no DOM dependencies — it's portable to Node, server, or our own UI.
- `shared/logic/Config.ts` + `calculateTierAndPrice()` give you the full data graph after one call.
- `shared/logic/InitializeGameState.ts` will seed a new `GameState` if you don't have a save.
- For deterministic computation (a build-cost / production-rate calculator, planner, etc.) we can call `tickEverySecond`-style functions ourselves with a constructed `GameState`. We'd reuse `Update.ts`, `BuildingLogic.ts`, `RebirthLogic.ts`.

If we just want to **inspect saves**:
- Load file → inflate (if zlib) → JSON.parse with the Map/Set reviver → operate on `SavedGame`.
- Read `current.tiles` (Map<Tile, ITileData>) for every building, level, status, stockpiles, electrification.
- `current.greatPeople` + `options.greatPeople` for run-vs-permanent levels; `RebirthLogic.getGreatPersonTotalLevel(gp)` is the canonical formula.
- `options.rebirthInfo: RebirthInfo[]` keeps history per rebirth (greatPeopleAtRebirth, totalEmpireValue, totalTicks, totalSeconds, city, time).

If we want a **DOM-side overlay/extension** (e.g. for the web build):
- The game exposes hooks like `useGameState`, `useGameOptions`, `useTrades`, `usePlayerMap`, `useUser` via `makeObservableHook(GameStateChanged, getGameState)`. A userscript / browser extension can grab `window`-attached singletons if any are exposed (most aren't — they live inside the bundled IIFE), so realistic extension surfaces are: hooking IndexedDB reads or scraping the canvas. For our tool, importing `shared/` types into a separate Node/Vite project is far cleaner.

---

## 8. Things that will bite us

- **Save shape evolves silently.** `MigrateSavedGame.ts` is the source of truth for renames. If the live game ships a new `SAVE_FILE_VERSION`, our tool will need to mirror migrations or reject the save.
- **Map/Set serialization tag.** Every `Map`/`Set` field round-trips through `{$type:"Map"|"Set", value:[…]}`. `JSON.parse` without the reviver gives you that envelope, not real collections.
- **Checksum is wyhash(saveBytes, 0n)** with `options.checksum` nulled before hashing. The server uses the checksum field in WebSocket auth params (`checksum=${expected}${actual}`); a mismatch will eventually mark the user `Desynced` (`UserAttributes.Desynced = 1<<11`). Read-only tools should leave it alone; round-trip tools must recompute it.
- **Server is closed source.** We can call type-checked RPC methods only in an environment that *also* compiles `server/src/Server.ts`. For a local-save tool, replace that import with a hand-written interface or `unknown`.
- **Anti-cheat.** The game pings checksums and a Steam binary hash; tampering is detectable. Keep tooling read-only / external.
- **Premium content gates.** Some `TileTexture`/`SpinnerTexture` sets and several `City` definitions require `requireSupporterPack: true` or `requireGreatPeopleLevel > 0`.
- **GPL-3.0 viral license.** Anything we ship that links against `shared/` falls under GPL. A separate tool that only consumes JSON saves is fine; reusing `shared/` source means open-sourcing under GPL.

---

## 9. Quick file index for "where do I look?"

| Question | File |
|---|---|
| List of buildings + recipes | `shared/definitions/BuildingDefinitions.ts` |
| List of materials | `shared/definitions/MaterialDefinitions.ts` |
| Tech tree edges | `shared/definitions/TechDefinitions.ts` (`requireTech`, `column`) |
| Tech ages / colors | `TechAgeDefinitions` in same file |
| Cities and their deposits | `shared/definitions/CityDefinitions.ts` |
| Great people, ages, boosts | `shared/definitions/GreatPersonDefinitions.ts` |
| Permanent upgrades | `shared/definitions/UpgradeDefinitions.ts` |
| World map JSON | `shared/definitions/WorldMap.json` |
| Patch notes (good for testing) | `shared/definitions/PatchNotes.ts` |
| Game constants | `shared/logic/Constants.ts` |
| Save (de)serialization + checksum | `shared/logic/GameStateLogic.ts` |
| `GameState` & `GameOptions` shape | `shared/logic/GameState.ts` |
| Building data types & helpers | `shared/logic/Tile.ts` (+ `BuildingLogic.ts` 1627 LoC) |
| Per-tick simulation | `shared/logic/Update.ts` (+ `TickLogic.ts`, `IntraTickCache.ts`) |
| Rebirth / great people math | `shared/logic/RebirthLogic.ts` |
| Tech unlocking | `shared/logic/TechLogic.ts` |
| Happiness | `shared/logic/HappinessLogic.ts` |
| Player trades / tariffs | `shared/logic/PlayerTradeLogic.ts` |
| Tile encoding helpers | `shared/utilities/Helper.ts` (`pointToTile`, `tileToPoint`, `Tile = number`) |
| Hex math | `shared/utilities/Hex.ts`, `shared/utilities/Grid.ts` |
| Wire / DB types | `shared/utilities/Database.ts` |
| Save-shape migrations | `src/scripts/MigrateSavedGame.ts` |
| RPC client + WS auth | `src/scripts/rpc/RPCClient.tsx` |
| Compression worker | `src/scripts/workers/Compress*.ts` |
| Game start sequence | `src/scripts/Bootstrap.tsx` |
| Save load orchestration | `src/scripts/Global.tsx` |
| Frame/second tickers | `src/scripts/utilities/GameTicker.ts`, `src/scripts/logic/ClientUpdate.tsx` |
| Pixi scenes (canvas rendering) | `src/scripts/scenes/` |
| React UI (good for copying styles/icons) | `src/scripts/ui/` |
