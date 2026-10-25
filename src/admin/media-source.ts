// Media sources for the unified editor's figure, video and macro image
// dialogs: the shared source picker, then a local upload or a cloud
// import. Every branch resolves to stored sidecar ids, never to files,
// so the dialogs only ever handle ids they don't show.
//
// Browser-safe: no node:* imports. `pickMedia` takes its effects as
// deps so the branching is unit-tested without a browser.

import { setStatus } from './dom.ts';
import { pickFromDrive, pickFromDriveVideo } from './integrations/gdrive.ts';
import { pickFromPhotos, pickFromPhotosVideo } from './integrations/gphotos.ts';
import { pickFromOneDrive, pickFromOneDriveVideo } from './integrations/onedrive.ts';
import type { MediaKind } from './integrations/provider-browser.ts';
import { openSourcePicker, type SourceChoice } from './source-picker.ts';

type CloudSource = 'drive' | 'onedrive' | 'photos';

/** What the editor dialogs need from the media layer. */
export interface MediaPicker {
  pick(kind: MediaKind, multiple: boolean): Promise<string[]>;
  /** Thumbnail URL for a stored id, or null for a placeholder. */
  thumbUrl(kind: MediaKind, id: string): string | null;
}

export interface MediaSourceDeps {
  chooseSource(kind: MediaKind): Promise<SourceChoice>;
  /** Files from the local chooser; [] when it is dismissed. */
  chooseFiles(kind: MediaKind): Promise<File[]>;
  upload(kind: MediaKind, file: File): Promise<string>;
  pickCloud(kind: MediaKind, source: CloudSource): Promise<string[]>;
  /** Wait for queued local uploads to reach the server, so the next
   * render can resolve them. Offline it returns once the queue halts. */
  settle(): Promise<void>;
  report(text: string, isError?: boolean): void;
}

/** New sidecar ids from the chosen source, or [] on cancel. */
export async function pickMedia(kind: MediaKind, deps: MediaSourceDeps): Promise<string[]> {
  const choice = await deps.chooseSource(kind);
  if (!choice) return [];
  if (choice !== 'local') {
    try {
      return await deps.pickCloud(kind, choice);
    } catch (err) {
      deps.report(`${choice} error: ${(err as Error).message}`, true);
      return [];
    }
  }
  const files = await deps.chooseFiles(kind);
  if (files.length === 0) return [];
  const ids: string[] = [];
  for (const [i, file] of files.entries()) {
    deps.report(`Uploading ${file.name} (${i + 1} of ${files.length})…`);
    try {
      ids.push(await deps.upload(kind, file));
    } catch (err) {
      deps.report(`Upload of ${file.name} failed: ${(err as Error).message}`, true);
      break;
    }
  }
  if (ids.length > 0) {
    deps.report(`Uploaded ${ids.length} ${kind === 'video' ? 'video' : 'image'}(s)`);
    await deps.settle();
  }
  return ids;
}

const CLOUD: Record<MediaKind, Record<CloudSource, () => Promise<string[]>>> = {
  image: { drive: pickFromDrive, onedrive: pickFromOneDrive, photos: pickFromPhotos },
  video: { drive: pickFromDriveVideo, onedrive: pickFromOneDriveVideo, photos: pickFromPhotosVideo }
};

function byId<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`media source: missing #${id}`);
  return el as T;
}

/** Resolve with the chooser's files. `cancel` fires when the native
 * chooser is dismissed (Chromium, Firefox, Safari 16.4+). */
function chooseFrom(input: HTMLInputElement, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const done = (files: File[]): void => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.value = '';
      resolve(files);
    };
    const onChange = (): void => done(Array.from(input.files ?? []));
    const onCancel = (): void => done([]);
    input.multiple = multiple;
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

/** Deps wired to the edit page's source picker and file inputs. The
 * entry supplies the upload and drain functions: their modules open
 * BroadcastChannels at import, which unit tests of this file avoid. */
export function browserMediaDeps(
  doc: Document,
  multiple: boolean,
  io: Pick<MediaSourceDeps, 'upload' | 'settle'>
): MediaSourceDeps {
  return {
    chooseSource: (kind) => {
      byId(doc, 'rkr-source-picker-title').textContent =
        kind === 'video' ? 'Add video' : multiple ? 'Add images' : 'Add image';
      return openSourcePicker(byId<HTMLDialogElement>(doc, 'rkr-source-picker'));
    },
    chooseFiles: (kind) =>
      chooseFrom(
        byId<HTMLInputElement>(doc, kind === 'video' ? 'rkr-video-input' : 'rkr-image-input'),
        multiple && kind === 'image'
      ),
    upload: io.upload,
    pickCloud: (kind, source) => CLOUD[kind][source](),
    settle: io.settle,
    report: (text, isError) => setStatus(text, isError)
  };
}
