// Validates centred-resize behaviour described in src/resize.ts.
//   node scripts/test-resize.mjs

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const src = readFileSync(new URL("../src/resize.ts", import.meta.url), "utf8");
const out = ts.transpileModule(src, {
   compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tmp = mkdtempSync(join(tmpdir(), "hex-resize-"));
const file = join(tmp, "resize.mjs");
writeFileSync(file, out);
const { computeCenterShift } = await import(`file://${file}`);

const cases = [
   // [old, new, expectedShift, description]
   [10, 11, 0, "+1 from even: extra col on right (shift 0)"],
   [11, 12, 1, "+1 from odd: extra col on left (shift +1)"],
   [12, 13, 0, "+1 alternates back to right"],
   [13, 14, 1, "+1 alternates back to left"],
   [11, 10, 0, "−1 from odd: drop rightmost (shift 0)"],
   [12, 11, -1, "−1 from even: drop leftmost (shift -1)"],
   [10, 14, 2, "+4: split 2/2"],
   [10, 15, 2, "+5: split 2/3 (odd extra on right)"],
   [15, 10, -2, "−5: drop 2 from left, 3 from right"],
   [14, 10, -2, "−4: drop 2 from each side"],
   [45, 45, 0, "no change"],
];

const round = (a, b, c) => {
   const there = computeCenterShift(a, b);
   const back = computeCenterShift(b, a);
   return [there + back, `${a}→${b} shift ${there}, ${b}→${a} shift ${back}, sum should be 0 ${c}`];
};

const roundtrips = [
   round(10, 11),
   round(11, 12),
   round(45, 46),
   round(45, 44),
   round(10, 15),
   round(20, 14),
];

let failed = 0;
for (const [oldSize, newSize, expected, desc] of cases) {
   const actual = computeCenterShift(oldSize, newSize);
   if (actual === expected) {
      console.log(`✓ ${oldSize}→${newSize} = ${actual}  ${desc}`);
   } else {
      failed++;
      console.error(`✗ ${oldSize}→${newSize} = ${actual}, expected ${expected}  ${desc}`);
   }
}
for (const [delta, msg] of roundtrips) {
   if (delta === 0) {
      console.log(`✓ round-trip ${msg}`);
   } else {
      failed++;
      console.error(`✗ round-trip ${msg}`);
   }
}

if (failed) {
   console.error(`${failed} failure(s)`);
   process.exit(1);
}
console.log("all centred-resize cases pass");
