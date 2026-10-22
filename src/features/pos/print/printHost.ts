import type { TicketPayload } from './ticket'

export interface PrintJob {
  id: string
  route: string
  payload: TicketPayload
  status: string
}

export interface PrintHostDeps {
  /** Atomically moves the job pending → printing; false if another host got it first. */
  claim(id: string): Promise<boolean>
  finish(id: string, ok: boolean, error: string | null): Promise<void>
  print(job: PrintJob): Promise<void>
}

export type JobResult = 'skipped' | 'printed' | 'failed'

/** Shared by the iPad page and the Node print agent. Claiming first is what
 *  keeps two hosts — or one host hearing about a job twice — from printing
 *  the same ticket twice. */
export async function processJob(job: PrintJob, deps: PrintHostDeps): Promise<JobResult> {
  if (job.status !== 'pending') return 'skipped'
  if (!(await deps.claim(job.id))) return 'skipped'
  try {
    await deps.print(job)
  } catch (e) {
    await deps.finish(job.id, false, e instanceof Error ? e.message : String(e))
    return 'failed'
  }
  // Outside the try on purpose: the ticket is already on paper, so failing to
  // record that must never turn into 'failed' (which would invite a duplicate
  // reprint). The error propagates and the job stays 'printing'.
  await deps.finish(job.id, true, null)
  return 'printed'
}
