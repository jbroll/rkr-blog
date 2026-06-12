// Pure canvas → Blob encode helpers. Browser-only. No DOM-app coupling.

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b): void => (b ? resolve(b) : reject(new Error('toBlob: empty result'))),
      mime,
      quality
    );
  });
}

// All iOS browsers (Safari, Chrome/CriOS, Firefox/FxiOS) use WKWebView and
// cannot encode WebP via canvas. Detect by device tokens, not browser name.
export const supportsWebP =
  typeof navigator === 'undefined' || !/\b(iPhone|iPad|iPod)\b/.test(navigator.userAgent);

export function webpOrJpeg(canvas: HTMLCanvasElement, quality = 0.95): Promise<Blob> {
  return canvasToBlob(canvas, supportsWebP ? 'image/webp' : 'image/jpeg', quality);
}
