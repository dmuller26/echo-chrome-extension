import type { CapturedRect, Overlay } from './types';

/**
 * Decode a screenshot data URL, draw a highlight rectangle over the captured
 * element rect, and return a PNG Blob. Runs in a service worker via OffscreenCanvas.
 */
export async function drawHighlight(
  dataUrl: string,
  rect: CapturedRect | undefined,
  devicePixelRatio: number,
): Promise<Blob> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  ctx.drawImage(bitmap, 0, 0);

  if (rect) {
    const dpr = devicePixelRatio || 1;
    const x = rect.x * dpr;
    const y = rect.y * dpr;
    const w = rect.width * dpr;
    const h = rect.height * dpr;
    const pad = 6 * dpr;

    // Soft outer glow
    ctx.save();
    ctx.strokeStyle = 'rgba(20, 100, 220, 0.35)';
    ctx.lineWidth = 8 * dpr;
    ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    ctx.restore();

    // Solid inner ring
    ctx.save();
    ctx.strokeStyle = 'rgba(20, 100, 220, 1)';
    ctx.lineWidth = 3 * dpr;
    ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    ctx.restore();
  }

  return await canvas.convertToBlob({ type: 'image/png' });
}

/**
 * Bake overlay redactions into a screenshot. Overlays are 0..1 fractions of the
 * intrinsic image size, so this works regardless of device pixel ratio. Returns
 * the original blob if no overlays are present, to avoid a needless re-encode.
 */
export async function bakeOverlays(
  source: Blob,
  overlays: Overlay[] | undefined,
): Promise<Blob> {
  if (!overlays || overlays.length === 0) return source;

  const bitmap = await createImageBitmap(source);

  // Browser environments (used at export time) may not have OffscreenCanvas
  // with convertToBlob — fall back to <canvas> with toBlob.
  const useOffscreen = typeof OffscreenCanvas !== 'undefined';
  if (useOffscreen) {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    paintOverlays(ctx, bitmap, overlays);
    return await canvas.convertToBlob({ type: 'image/png' });
  }

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  paintOverlays(ctx, bitmap, overlays);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

function paintOverlays(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  overlays: Overlay[],
): void {
  ctx.drawImage(bitmap, 0, 0);
  ctx.save();
  ctx.fillStyle = '#1f2937';
  for (const o of overlays) {
    const x = o.x * bitmap.width;
    const y = o.y * bitmap.height;
    const w = o.w * bitmap.width;
    const h = o.h * bitmap.height;
    const r = Math.min(8, w / 4, h / 4);
    roundedRectPath(ctx, x, y, w, h, r);
    ctx.fill();
  }
  ctx.restore();
}

function roundedRectPath(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
