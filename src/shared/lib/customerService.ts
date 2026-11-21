// src/shared/lib/customerService.ts
import { supabase } from './supabase'

/**
 * Opens Craft Marketing (the Customer Service inbox) signed in as the current
 * staff member. Craft OS trades its Supabase session for a 60-second,
 * single-use ticket from craft-api, then opens <marketing>/sso#t=<ticket>.
 * The fragment never reaches a server log.
 * Spec: Craft_CSS docs/superpowers/specs/2026-10-29-craft-os-sso-design.md
 */

export type TicketFailure = 'signed_out' | 'no_access' | 'unavailable'
export type TicketResult = { ok: true; ticket: string } | { ok: false; reason: TicketFailure }

export const CS_MESSAGES: Record<TicketFailure, string> = {
  signed_out: 'Your Craft OS session has expired. Sign in again, then retry.',
  no_access: "You don't have Customer Service access yet. Ask an admin.",
  unavailable: 'Customer Service is not responding right now. Try again in a minute.',
}

export async function requestCsTicket(
  apiUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  // craft-api runs on Render and may be cold-starting.
  timeoutMs = 30_000,
): Promise<TicketResult> {
  let res: Response
  try {
    res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/api/v1/auth/sso/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
  if (res.status === 401) return { ok: false, reason: 'signed_out' }
  if (res.status === 403) return { ok: false, reason: 'no_access' }
  if (!res.ok) return { ok: false, reason: 'unavailable' }
  const body = (await res.json().catch(() => null)) as { ticket?: string } | null
  return body?.ticket ? { ok: true, ticket: body.ticket } : { ok: false, reason: 'unavailable' }
}

export function ssoUrl(marketingUrl: string, ticket: string): string {
  return `${marketingUrl.replace(/\/+$/, '')}/sso#t=${encodeURIComponent(ticket)}`
}

/**
 * Call this straight from the click handler. Everything before the first
 * `await` runs inside the click, which is the only time the browser lets us
 * open a tab. If we fetched the ticket first, the pop-up blocker would stop
 * the tab. Returns null on success, or a message to show the user.
 */
export async function openCustomerService(): Promise<string | null> {
  const apiUrl = import.meta.env.VITE_CRAFT_API_URL as string | undefined
  const marketingUrl = import.meta.env.VITE_CRAFT_MARKETING_URL as string | undefined
  if (!apiUrl || !marketingUrl) return CS_MESSAGES.unavailable

  const tab = window.open('about:blank', '_blank')
  // Anything that throws after the tab exists must close it, or the user is
  // left on a blank "Signing you in…" page.
  try {
    if (tab) {
      tab.opener = null
      tab.document.title = 'Customer Service'
      tab.document.body.textContent = 'Signing you in…'
    }

    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    const result: TicketResult = token
      ? await requestCsTicket(apiUrl, token)
      : { ok: false, reason: 'signed_out' }

    if (!result.ok) {
      tab?.close()
      return CS_MESSAGES[result.reason]
    }

    const url = ssoUrl(marketingUrl, result.ticket)
    if (tab) tab.location.href = url
    else window.location.href = url // pop-up blocked anyway: use this tab
    return null
  } catch {
    try { tab?.close() } catch { /* already gone */ }
    return CS_MESSAGES.unavailable
  }
}
