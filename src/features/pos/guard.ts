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
