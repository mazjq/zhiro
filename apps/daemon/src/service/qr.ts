import jsqrModule from "jsqr";
// jsqr ships CJS with `module.exports = jsQR`; under NodeNext the default import may be the namespace
type JsQr = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null;
const jsQR = ((jsqrModule as any).default ?? jsqrModule) as JsQr;
import { PNG } from "pngjs";
import { decode as decodeJpeg } from "jpeg-js";

/** Decode QR codes from a PNG/JPEG buffer. Pure JS (jsqr + pngjs + jpeg-js), no native deps. Returns decoded strings (deduped). */
export function decodeQr(buf: Buffer, mimeType: string): string[] {
  let width: number, height: number, data: Uint8ClampedArray;
  try {
    if (/png/.test(mimeType)) {
      const png = PNG.sync.read(buf);
      ({ width, height } = png);
      data = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
    } else if (/jpe?g/.test(mimeType)) {
      const j = decodeJpeg(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
      ({ width, height } = j);
      data = new Uint8ClampedArray(j.data.buffer, j.data.byteOffset, j.data.byteLength);
    } else return [];
  } catch {
    return [];
  }
  const out = new Set<string>();
  // full image, then a coarse 2x2 tile scan for posters that carry several small codes
  const tryRegion = (x: number, y: number, w: number, h: number) => {
    if (w < 60 || h < 60) return;
    const sub = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) sub.set(data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
    const r = jsQR(sub, w, h, { inversionAttempts: "dontInvert" });
    if (r?.data) out.add(r.data.trim());
  };
  tryRegion(0, 0, width, height);
  if (out.size === 0 && width * height > 400 * 400) {
    const hw = Math.floor(width / 2), hh = Math.floor(height / 2);
    for (const [x, y] of [[0, 0], [hw, 0], [0, hh], [hw, hh]] as const) tryRegion(x, y, width - x < hw * 1.5 ? width - x : hw + Math.floor(hw / 2), height - y < hh * 1.5 ? height - y : hh + Math.floor(hh / 2));
  }
  return [...out];
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}
