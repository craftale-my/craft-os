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

/** Same contract as {@link writeOutcome}, for the rarer caller that needs the
 *  row the database actually returned — not just proof that one came back.
 *
 *  A BEFORE UPDATE trigger can rewrite columns of NEW before Postgres ever
 *  returns them: attendance_guard_late_update() (supabase/migration-2026-09-
 *  02-late-reason-notifications.sql) clamps a clock-in's status/late_minutes
 *  back to their old values rather than let the write erase a verdict a
 *  manager or the system already recorded (an absent sweep, a hand-marked
 *  late, an approved leave). `.select()`'s returned row is the only place
 *  that shows what actually landed, so a caller that needs to tell the user
 *  the truth about a possible clamp has to see it.
 *
 *  Deliberately a SEPARATE function rather than a `row` field added to
 *  `WriteOutcome` itself: several call sites and their tests pin
 *  `writeOutcome`'s `{ ok: true }` shape with `toEqual` (db-write.test.ts,
 *  api.projects.write.test.ts) — an extra field on that return, even an
 *  optional one nobody reads, would fail those exact-shape assertions. This
 *  widens the module additively instead: every existing `writeOutcome()` call
 *  site keeps working, byte for byte, untouched. */
export type WriteOutcomeWithRow<T = unknown> = { ok: true; row: T } | { ok: false; reason: string }

export function writeOutcomeWithRow<T = unknown>(res: WriteResponse): WriteOutcomeWithRow<T> {
  const outcome = writeOutcome(res)
  if (!outcome.ok) return outcome
  return { ok: true, row: (res.data as T[])[0] }
}
