/** The coded errors of pos_ctx() (supabase/migration-2026-10-29-pos-devices.sql). Every till
 *  call from a POS tablet raises one of these when the device, its outlet or the signed-in
 *  person no longer lets it work. The POS app answers them with the activation or lock
 *  screen; a queued order that meets one waits for the next sign-in instead of failing. */
export const CONTEXT_CODES = ['device_unpaired', 'outlet_closed', 'no_session', 'access_changed'] as const
export type ContextCode = (typeof CONTEXT_CODES)[number]

/** The code when an error message is one of them, else null. */
export function contextCode(message: unknown): ContextCode | null {
  return typeof message === 'string' && (CONTEXT_CODES as readonly string[]).includes(message)
    ? (message as ContextCode) : null
}
