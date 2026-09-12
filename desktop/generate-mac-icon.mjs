// Generates the macOS app icon with proper Apple-grid padding.
//
// The source icon artwork (a circle) fills ~96% of its 512x512 canvas, but
// macOS icons are expected to leave ~10% transparent margin on every side
// (Apple's icon grid: 824px body on a 1024px canvas ≈ 80.5%). Without the
// padding the Dock icon looks noticeably larger than every other app's.
//
// Run: node desktop/generate-mac-icon.mjs
// Output: public/icons/icon-mac-512.png (used by electron-builder "mac.icon")

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const baseIcon = path.join(repoRoot, "public", "icons", "icon-512.png");
const out = path.join(repoRoot, "public", "icons", "icon-mac-512.png");

const SIZE = 512;
// Apple icon grid: icon body is 824/1024 ≈ 80.5% of the canvas.
const BODY_RATIO = 824 / 1024;

// Measure the opaque bounding box so the artwork is scaled by its actual
// content size, not by transparent padding it may already contain.
async function main() {
  const { data, info } = await sharp(baseIcon).raw().toBuffer({ resolveWithObject: true });
  let minx = info.width, miny = info.height, maxx = -1, maxy = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] > 10) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  const contentW = maxx - minx + 1;
  const contentH = maxy - miny + 1;
  const contentRatio = contentW / info.width;
  const scale = BODY_RATIO / contentRatio;
  const bodyW = Math.round(contentW * scale);
  const bodyH = Math.round(contentH * scale);

  const body = await sharp(baseIcon)
    .extract({ left: minx, top: miny, width: contentW, height: contentH })
    .resize(bodyW, bodyH, { fit: "fill" })
    .png()
    .toBuffer();

  await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: body, left: Math.round((SIZE - bodyW) / 2), top: Math.round((SIZE - bodyH) / 2) }])
    .png()
    .toFile(out);

  const meta = await sharp(out).metadata();
  console.log(
    `wrote ${path.relative(repoRoot, out)} (${meta.width}x${meta.height}); ` +
    `content scaled to ${bodyW}x${bodyH}px (${((bodyW / SIZE) * 100).toFixed(1)}% of canvas)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
