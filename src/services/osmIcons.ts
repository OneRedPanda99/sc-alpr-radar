/**
 * Icons for the map-detail layers: a round badge in the layer's colour with a
 * simple line symbol, in the same 24-unit, round-capped style as the app's
 * other icons. One definition feeds both the map (rasterised to images) and
 * the Layers panel (inline SVG), so they always match.
 */

export interface Glyph {
  /** Line work (stroked). */
  stroke?: string;
  /** Solid shapes (filled). */
  fill?: string;
}

export const OSM_GLYPHS: Record<string, Glyph> = {
  // Traffic light: housing with three lamps.
  signals: {
    stroke: "M9 3h6a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 15 21H9a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 9 3Z",
    fill: "M12 5.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2ZM12 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2ZM12 15.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2Z",
  },
  // Stop sign: a solid octagon (a bar across it read as "no entry").
  stops: {
    fill: "M8.5 2.5h7l6 6v7l-6 6h-7l-6-6v-7Z",
  },
  // Speed bump: a hump over the road.
  calming: {
    stroke: "M3 17c3 0 4.5-6 9-6s6 6 9 6M3 20h18",
  },
  // Railroad crossing: crossbuck.
  rail: {
    stroke: "M5 5l14 14M19 5L5 19",
  },
  // Height limit: arrows between two bars.
  clearance: {
    stroke: "M4 4h16M4 20h16M12 7.5v9M9 10l3-3 3 3M9 14l3 3 3-3",
  },
  // Toll: dollar sign.
  tolls: {
    stroke:
      "M15.5 8.5c-.6-1.2-1.9-2-3.5-2-2 0-3.5 1.1-3.5 2.7 0 3.6 7 1.9 7 5.6 0 1.6-1.5 2.7-3.5 2.7-1.6 0-2.9-.8-3.5-2M12 4.5v15",
  },
  // School: mortarboard.
  schools: {
    stroke: "M2.5 9.5 12 5l9.5 4.5L12 14ZM6.5 11.5v4.5c3 2.2 8 2.2 11 0v-4.5M21.5 9.5v5",
  },
  // Hospital / fire / clinic: medical cross.
  emergency: {
    stroke: "M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6Z",
  },
  // Courthouse / government: columned building.
  civic: {
    stroke: "M3 20.5h18M4 9.5h16M12 3.5l8.5 4.5h-17ZM6.5 9.5v8M10.2 9.5v8M13.8 9.5v8M17.5 9.5v8",
  },
  // Fuel: pump with hose.
  fuel: {
    stroke: "M4.5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 13.5 5v15.5M3 20.5h12M7 8h4M13.5 10h2a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 0 3 0V8l-2.5-2.5",
  },
  // Rest stop / restrooms: picnic table.
  rest: {
    stroke: "M4 9.5h16M7.5 9.5l-2.5 10M16.5 9.5l2.5 10M3 15h18M9 5.5h6",
  },
  // Parking: a P.
  parking: {
    stroke: "M8.5 20V4h4.5a4.25 4.25 0 0 1 0 8.5H8.5",
  },
  // Food & coffee: fork and knife.
  food: {
    stroke: "M7 3v7.5a2 2 0 0 0 2 2V21M5 3v4.5M9 3v4.5M16.5 21V3c-2.2 1.3-3.5 4.4-3.5 8.5h3.5",
  },
  // Shops: shopping bag.
  shops: {
    stroke: "M5 8.5h14l-1.2 12H6.2ZM9 8.5V6.5a3 3 0 0 1 6 0v2",
  },
};

/** Dark symbols on light badges (yellows), white on the rest. */
export function glyphInk(color: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return "#ffffff";
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.62 ? "#10151d" : "#ffffff";
}

/** Map image name for a category's icon. */
export const osmIconId = (category: string) => `osm-${category}`;

/**
 * Draw a category's badge for the map, at `ratio`× for sharp screens.
 * Returns null where there's no glyph (line layers) or no canvas.
 */
export function rasterizeOsmIcon(
  category: string,
  color: string,
  ratio = 2,
): { width: number; height: number; data: Uint8ClampedArray } | null {
  const glyph = OSM_GLYPHS[category];
  if (!glyph || typeof document === "undefined") return null;
  const size = 26 * ratio;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Badge: coloured disc with a dark rim so it reads on light, dark and
  // satellite maps alike.
  const c = size / 2;
  ctx.beginPath();
  ctx.arc(c, c, c - ratio, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5 * ratio;
  ctx.strokeStyle = "rgba(8, 12, 18, 0.9)";
  ctx.stroke();

  // Symbol: the 24-unit glyph scaled into the middle of the badge.
  const ink = glyphInk(color);
  const inner = size * 0.6;
  ctx.save();
  ctx.translate((size - inner) / 2, (size - inner) / 2);
  ctx.scale(inner / 24, inner / 24);
  if (glyph.fill) {
    ctx.fillStyle = ink;
    ctx.fill(new Path2D(glyph.fill));
  }
  if (glyph.stroke) {
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = ink;
    ctx.stroke(new Path2D(glyph.stroke));
  }
  ctx.restore();
  return { width: size, height: size, data: ctx.getImageData(0, 0, size, size).data };
}
