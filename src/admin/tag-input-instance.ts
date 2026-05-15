// Singleton accessor for the mounted TagInputWidget. startup.ts calls
// setTagInput() once during boot; save.ts calls getTagInput() on every
// save. The indirection avoids a circular dependency between those two
// modules and keeps tag-input.ts free of global state.

import type { TagInputWidget } from './tag-input.ts';

let instance: TagInputWidget | null = null;

export function setTagInput(widget: TagInputWidget): void {
  instance = widget;
}

export function getTagInput(): TagInputWidget | null {
  return instance;
}
