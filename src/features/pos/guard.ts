const PROD_REF = 'yfsoesxzurzjdwstszru'

/** The spike writes test orders and print jobs freely. It must never point
 *  at the production project, which local dev uses by default. */
export function assertDevDatabase(url: string): void {
  if (url.toLowerCase().includes(PROD_REF)) {
    throw new Error(
      'The POS spike must never run against the production database. Point VITE_SUPABASE_URL at the dev project.',
    )
  }
}

export const isProdDatabase = (url: string): boolean => url.toLowerCase().includes(PROD_REF)

/** The print agent's rule. It is a paired device that only prints its outlet's jobs, so it may run
 *  against production — but only where that is meant: the outlet's printing computer sets
 *  PRINT_AGENT_ALLOW_PROD=1 in its .env. A developer's machine, which has no such line, is still
 *  stopped, so it never prints (or swallows) a real outlet's tickets by accident.
 *  Returns 'production' or 'dev' for the start-up line. */
export function assertAgentDatabase(url: string, allowProd: string | undefined): 'production' | 'dev' {
  if (!isProdDatabase(url)) return 'dev'
  if (allowProd?.trim() !== '1') {
    throw new Error(
      'This is the PRODUCTION database. On the outlet\'s printing computer, add PRINT_AGENT_ALLOW_PROD=1 to tools/print-agent/.env to allow it. On any other machine, point SUPABASE_URL at the dev project.',
    )
  }
  return 'production'
}
