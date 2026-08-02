/** Shape of a Supabase write that was asked to return its rows via `.select()`. */
export interface WriteResponse {
  data: unknown[] | null
  error: { message: string } | null
}

export type WriteOutcome = { ok: true } | { ok: false; reason: string }

/** A write that Row Level Security filters out comes back with **no error and
 *  no rows** — Postgres simply matches nothing. So `error === null` does not
 *  mean the write landed; the returned row is the only proof it did.
 *
 *  Clock-outs used to be fired without `.select()` and without inspecting the
 *  response at all, so a rejected write still showed the staff member a green
 *  "Clocked out ✓" while nothing was saved. Every write whose success is shown
 *  to a user must go through here, and must be built with `.select()`. */
export function writeOutcome(res: WriteResponse): WriteOutcome {
  if (res.error) return { ok: false, reason: res.error.message }
  if (!res.data || res.data.length === 0) {
    return { ok: false, reason: 'it was not saved — you may have been signed out.' }
  }
  return { ok: true }
}
