// Download the edited canvas. Format picker: PNG (lossless) / WebP / JPEG,
// with a quality slider for the lossy formats.

export type OutFormat = 'png' | 'webp' | 'jpeg';

export function mimeFor(fmt: OutFormat): string {
  return fmt === 'png' ? 'image/png' : fmt === 'webp' ? 'image/webp' : 'image/jpeg';
}

/** `<stem>-edited.<ext>` from the input filename (stem only, original ext dropped). */
export function outputName(inputName: string, fmt: OutFormat): string {
  const dot = inputName.lastIndexOf('.');
  const stem = dot > 0 ? inputName.slice(0, dot) : inputName;
  return `${stem}-edited.${fmt}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob: empty result'))),
      mime,
      quality
    );
  });
}

/** Encode `canvas` to `fmt` and trigger a browser download. Quality is ignored
 * for PNG (lossless). */
export async function downloadCanvas(
  canvas: HTMLCanvasElement,
  inputName: string,
  fmt: OutFormat,
  quality: number
): Promise<void> {
  const blob = await canvasToBlob(canvas, mimeFor(fmt), fmt === 'png' ? undefined : quality);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = outputName(inputName, fmt);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
