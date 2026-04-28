// Pointy-top hex math, "odd-r" offset coordinates (matches what CivIdle uses
// for tile placement on its city grids).
//
// World layout convention used here:
//   col   0..maxX-1   (x in offset coords)
//   row   0..maxY-1   (y in offset coords)
//   width  = sqrt(3) * size
//   height = 2 * size
//   horizontal step = width
//   vertical step   = 0.75 * height
//   odd rows are shifted right by width/2

export const SQRT3 = Math.sqrt(3);

export interface Coord {
   col: number;
   row: number;
}

export interface PixelPoint {
   x: number;
   y: number;
}

export const tileKey = (col: number, row: number): string => `${col},${row}`;

export const parseTileKey = (key: string): Coord => {
   const [c, r] = key.split(",").map(Number);
   return { col: c, row: r };
};

export const hexWidth = (size: number): number => SQRT3 * size;
export const hexHeight = (size: number): number => 2 * size;

export const center = (col: number, row: number, size: number): PixelPoint => {
   const w = hexWidth(size);
   const h = hexHeight(size);
   return {
      x: w * (col + 0.5 * (row & 1)) + w / 2,
      y: (h * 3) / 4 * row + h / 2,
   };
};

export const cornerPoints = (cx: number, cy: number, size: number): PixelPoint[] => {
   // Pointy-top hex: corners at -90°, -30°, 30°, 90°, 150°, 210°.
   const out: PixelPoint[] = [];
   for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i - 90);
      out.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
   }
   return out;
};

export const hexPolygonPoints = (col: number, row: number, size: number): string => {
   const c = center(col, row, size);
   return cornerPoints(c.x, c.y, size)
      .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(" ");
};

export interface GridDimensions {
   widthPx: number;
   heightPx: number;
}

export const gridDimensions = (cols: number, rows: number, size: number): GridDimensions => {
   const w = hexWidth(size);
   const h = hexHeight(size);
   return {
      widthPx: cols * w + w / 2 + w, // +half for odd-row shift, +full for right padding
      heightPx: ((rows - 1) * 3 * h) / 4 + h,
   };
};

export interface ColCoords {
   col: number;
   row: number;
}

export const allCoords = (cols: number, rows: number): ColCoords[] => {
   const out: ColCoords[] = [];
   for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
         out.push({ col: c, row: r });
      }
   }
   return out;
};
