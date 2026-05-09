// Cropper modal: opens a dialog with cropperjs mounted on the LOCAL
// post-ops canvas (not the server preview), so the coords the user
// drags are already in current-canvas space — applyCrop interprets
// them in that same space, so crop appends cleanly after prior
// rotates / flips / earlier crops.

import Cropper from 'cropperjs';

import type { SidecarOp } from '../lib/sidecar-types.ts';
import { canvasToBlob, getPipelineCache, loadOriginal } from './canvas-loaders';
import { $, setStatus } from './dom';
import { type LocalEditState, localMutate } from './image-edit';

let activeCropper: Cropper | null = null;

export async function openCropper(
  id: string,
  s: LocalEditState,
  onSaved: () => void
): Promise<void> {
  const dialog = $<HTMLDialogElement>('rkr-crop-modal');
  const stageImg = $<HTMLImageElement>('rkr-crop-img');
  const status = $<HTMLSpanElement>('rkr-crop-status');
  const cancelBtn = $<HTMLButtonElement>('rkr-crop-cancel');
  const saveBtn = $<HTMLButtonElement>('rkr-crop-save');

  if (!s.sourceWidth || !s.sourceHeight) {
    setStatus('crop: source image has no recorded dimensions');
    return;
  }

  status.textContent = 'loading…';
  let canvas: HTMLCanvasElement;
  try {
    const original = await loadOriginal(id);
    canvas = getPipelineCache(id).apply(
      {
        drawable: original,
        width: original.naturalWidth,
        height: original.naturalHeight
      },
      s.ops
    );
  } catch (err) {
    setStatus(`crop: ${(err as Error).message}`);
    return;
  }

  let blob: Blob;
  try {
    blob = await canvasToBlob(canvas, 'image/webp', 0.95);
  } catch (err) {
    setStatus(`crop: ${(err as Error).message}`);
    return;
  }
  const stageUrl = URL.createObjectURL(blob);
  stageImg.src = stageUrl;
  stageImg.onload = (): void => {
    if (activeCropper) activeCropper.destroy();
    activeCropper = new Cropper(stageImg, {
      viewMode: 1,
      autoCropArea: 1,
      background: false,
      ready: () => {
        status.textContent = `${canvas.width}×${canvas.height} current`;
      }
    });
    saveBtn.onclick = (): void => {
      if (!activeCropper) return;
      const data = activeCropper.getData(true); // rounded to integers
      // Cropper coords are in stageImg.natural space, which IS the
      // current canvas space. No scaling needed.
      const op: SidecarOp = {
        type: 'crop',
        x: Math.max(0, Math.round(data.x)),
        y: Math.max(0, Math.round(data.y)),
        w: Math.round(data.width),
        h: Math.round(data.height)
      };
      // Append to the existing op chain. Prior rotates / flips / etc
      // are preserved; the new crop operates on what they produced.
      localMutate(s, (ops) => [...ops, op]);
      status.textContent = 'saved';
      closeCropper();
      URL.revokeObjectURL(stageUrl);
      onSaved();
    };
  };

  cancelBtn.onclick = (): void => {
    closeCropper();
    URL.revokeObjectURL(stageUrl);
  };
  dialog.addEventListener(
    'close',
    () => {
      closeCropper();
      URL.revokeObjectURL(stageUrl);
    },
    { once: true }
  );
  dialog.showModal();
}

function closeCropper(): void {
  const dialog = $<HTMLDialogElement>('rkr-crop-modal');
  if (activeCropper) {
    activeCropper.destroy();
    activeCropper = null;
  }
  if (dialog.open) dialog.close();
}
