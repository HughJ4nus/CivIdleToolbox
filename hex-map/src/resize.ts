// Centred resize: when the grid grows or shrinks, work out how much existing
// content should shift along each axis so the change feels symmetric around
// the middle.
//
// Rule: each unit of resize toggles which side of the axis is modified, based
// on the parity of `max(old, new)` for that single ±1 step.
//   max odd  → modify the right / bottom
//   max even → modify the left / top
//
// Properties this gives us:
//   • Repeated ±1 clicks alternate sides instead of always trimming the same edge.
//   • A round-trip (N → N±1 → N) returns content to its exact original column.
//   • Larger jumps (Δ ≥ 2) come out evenly distributed: Δ=4 splits 2/2,
//     Δ=5 splits 2/3 with the odd one on the right/bottom side.
//
// `shift` is the per-cell offset to add to the old column/row to get its new
// position. After shifting, cells that fall outside [0, newSize) are dropped.

const countEvenInRange = (a: number, b: number): number => {
   if (a > b) return 0;
   // Number of even integers in the inclusive interval [a, b].
   return Math.floor(b / 2) - Math.floor((a - 1) / 2);
};

export const computeCenterShift = (oldSize: number, newSize: number): number => {
   if (newSize === oldSize) return 0;
   if (newSize > oldSize) {
      // Growing: each step where max=cur+1 is even adds a column on the LEFT.
      return countEvenInRange(oldSize + 1, newSize);
   }
   // Shrinking: each step where max=cur (the size before this −1 step) is even
   // removes a column from the LEFT (which appears as a leftward shift in
   // surviving cells, hence the negative sign).
   return -countEvenInRange(newSize + 1, oldSize);
};
