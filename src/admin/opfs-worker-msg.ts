/** Body-only variants (no `id`) used by the main-thread dispatcher. */
export type WriteRequestBody =
  | { op: 'write'; path: string; data: string | ArrayBuffer }
  | { op: 'remove'; path: string };

export type WriteRequest =
  | ({ id: string } & Extract<WriteRequestBody, { op: 'write' }>)
  | ({ id: string } & Extract<WriteRequestBody, { op: 'remove' }>);

export type WriteResponse =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string; isCapabilityError: boolean; debug?: string };
