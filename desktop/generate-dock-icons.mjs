// Generates the two macOS Dock running-indicator icon frames by compositing a
// green breathing dot onto the base app icon. The dot sits in the top-right
// corner so it is visually distinct from the bottom-right tray indicator and
// matches the user-requested "top-right" placement.
//
// Run: node desktop/generate-dock-icons.mjs
// Output: public/icons/dock-running-bright.png, dock-running-dim.png (512x512)

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const baseIcon = path.join(repoRoot, "public", "icons", "icon-512.png");
const outBright = path.join(repoRoot, "public", "icons", "dock-running-bright.png");
const outDim = path.join(repoRoot, "public", "icons", "dock-running-dim.png");

const SIZE = 512;

// The dot occupies ~26% of the icon and sits in the top-right with a small
// inset so it stays fully inside the rounded app-icon mask on macOS.
const DOT_DIAMETER = Math.round(SIZE * 0.26);
const INSET = Math.round(SIZE * 0.06);
const DOT_RADIUS = DOT_DIAMETER / 2;
const CENTER_X = SIZE - INSET - DOT_RADIUS;
const CENTER_Y = INSET + DOT_RADIUS;

// A subtle dark ring keeps the lamp legible on light icon backgrounds.
const RING_WIDTH = Math.max(4, Math.round(DOT_DIAMETER * 0.08));

async function buildOverlay(opacity) {
  const innerR = DOT_RADIUS - RING_WIDTH;
  const ringR = DOT_RADIUS;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <radialGradient id="lamp" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#86efac" stop-opacity="${opacity}"/>
      <stop offset="55%" stop-color="#22c55e" stop-opacity="${opacity}"/>
      <stop offset="100%" stop-color="#16a34a" stop-opacity="${opacity}"/>
    </radialGradient>
  </defs>
  <circle cx="${CENTER_X}" cy="${CENTER_Y}" r="${ringR}" fill="#0f172a" fill-opacity="${Math.min(0.9, opacity + 0.1)}"/>
  <circle cx="${CENTER_X}" cy="${CENTER_Y}" r="${innerR}" fill="url(#lamp)"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  for (const [opacity, out] of [[1.0, outBright], [0.6, outDim]]) {
    const overlay = await buildOverlay(opacity);
    await sharp(baseIcon)
      .composite([{ input: overlay, blend: "over" }])
      .png()
      .toFile(out);
    const meta = await sharp(out).metadata();
    console.log(`wrote ${path.relative(repoRoot, out)} (${meta.width}x${meta.height})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
