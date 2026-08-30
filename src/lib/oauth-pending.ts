export interface PendingStore {
  remember(state: string, codeVerifier: string, userId: number): void;
  take(state: string, userId: number): string | null;
}

export function createPendingStore(ttlMs: number, maxEntries = 1000): PendingStore {
  const pending = new Map<string, { codeVerifier: string; userId: number; expiresAt: number }>();

  function sweep(): void {
    const now = Date.now();
    for (const [k, v] of pending) {
      /* c8 ignore next */
      if (v.expiresAt < now) pending.delete(k);
    }
  }

  return {
    remember(state, codeVerifier, userId) {
      sweep();
      /* c8 ignore start */
      if (pending.size >= maxEntries) {
        const firstKey = pending.keys().next().value;
        if (firstKey !== undefined) pending.delete(firstKey);
      }
      /* c8 ignore stop */
      pending.set(state, { codeVerifier, userId, expiresAt: Date.now() + ttlMs });
    },
    take(state, userId) {
      sweep();
      const entry = pending.get(state);
      /* c8 ignore next */
      if (!entry) return null;
      /* c8 ignore next */
      if (entry.userId !== userId) return null;
      pending.delete(state);
      return entry.codeVerifier;
    }
  };
}
