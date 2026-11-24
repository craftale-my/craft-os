/** Serialises flush passes. A call while a pass is running does not start a
 *  second one; it flags that one more pass must follow and shares the running
 *  promise. The flag is checked after every `run()`, so a request that lands
 *  during ANY part of a pass (including the last await) is never lost.
 *  A rejecting `run` ends the current promise with that error and leaves the
 *  flusher idle, so the next call starts clean. */
export function makeFlusher(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  let again = false
  return () => {
    if (inFlight) { again = true; return inFlight }
    const p = (async () => {
      try {
        do {
          again = false
          await run()
        } while (again)
      } finally { inFlight = null }
    })()
    inFlight = p
    return p
  }
}
