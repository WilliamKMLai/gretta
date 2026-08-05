/**
 * Lifecycle of the one literature run that can be in flight at a time
 * (DECISIONS.md ADR-028).
 *
 * `search()` and `captureAndDraft()` already threaded an `AbortController`
 * through every network and generation call they make. Nothing exposed it, so
 * a search that fans out across four APIs, then enriches, then checks
 * retractions, then embeds, was uninterruptible short of reloading the pane.
 *
 * The controller lives here, module-scoped, rather than in the store or in a
 * `useRef`:
 *
 * - It is not serializable state. The store holds what the pane renders; a
 *   live object with a `signal` behind a setter invites renders keyed on its
 *   identity and would have to be excluded from every persistence path.
 * - `useLiteratureSearch` is called from more than one component — the panel
 *   and the recent-searches list — so a `useRef` would give each of them its
 *   own controller while the state they all drive is a single global store.
 *   The Cancel button in the panel has to be able to abort a run that a click
 *   in the history list started. One store, one run, one controller.
 *
 * A run must also survive being *superseded*, not only cancelled. Aborting a
 * signal does not unwind the promises already awaiting on it: an in-flight
 * fetch still settles, and a late resolution that writes results is exactly
 * how a cancelled search reappears on top of the one the user actually wanted.
 * That is what `isCurrent` is for, and it has to be checked after every await
 * that precedes a write to the store.
 */
import type { LiteratureState } from './literature.store';

let inFlight: AbortController | null = null;

/**
 * Claims the in-flight slot, aborting whatever held it.
 *
 * Superseding rather than running alongside: two concurrent searches race to
 * call `setResults`, and the one that lands last wins regardless of which the
 * user asked for most recently.
 */
export function beginRun(): AbortController {
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  return controller;
}

/** True while `controller` is still the run whose writes should be honoured. */
export function isCurrent(controller: AbortController): boolean {
  return inFlight === controller && !controller.signal.aborted;
}

/**
 * Releases the slot, if this run still holds it. The guard matters: a
 * superseded run finishing late must not clear the controller of the run that
 * replaced it, or the next `cancel()` would have nothing to abort.
 */
export function endRun(controller: AbortController): void {
  if (inFlight === controller) inFlight = null;
}

/** Aborts the in-flight run, if any. The Cancel button, minus the phase change. */
export function abortRun(): void {
  inFlight?.abort();
  inFlight = null;
}

/**
 * Whether a thrown value is this run being stopped rather than failing.
 *
 * Checks the signal first because not every layer rethrows a named
 * `AbortError` — a `for await` over an aborted stream, or a client that wraps
 * the underlying failure, can surface as something else entirely. If the
 * signal is aborted, nothing that escaped afterwards is news the user needs.
 */
export function wasAborted(error: unknown, controller: AbortController): boolean {
  if (controller.signal.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Wraps `setResults` so a superseded or cancelled run cannot paint over the
 * current one. Passed down into the pipeline because `deliverRanked` and
 * `resolveCacheHit` call `setResults` themselves — the check has to travel
 * with the setter rather than sit at the call site.
 */
export function onlyIfCurrent(
  controller: AbortController,
  setResults: LiteratureState['setResults'],
): LiteratureState['setResults'] {
  return (results, ranking, hiddenCount, rankingNote, sentQueries) => {
    if (isCurrent(controller)) {
      setResults(results, ranking, hiddenCount, rankingNote, sentQueries);
    }
  };
}
