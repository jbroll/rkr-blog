// The page body is inert while anything holds it: a pending render or an
// open sheet. Counting holds keeps one from clearing the other's.

export type ReleaseInert = () => void;

export function createInertHolds(el: Element): () => ReleaseInert {
  let holds = 0;
  return () => {
    holds++;
    el.setAttribute('inert', '');
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds--;
      if (holds === 0) el.removeAttribute('inert');
    };
  };
}
