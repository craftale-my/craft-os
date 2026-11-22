// MyInvois HTTP client: token, submit, poll. Uses only fetch and Web Crypto.
// API: https://sdk.myinvois.hasil.gov.my (Identity and System API share one host).

export type Environment = 'sandbox' | 'production'

export const HOSTS: Record<Environment, { api: string; portal: string }> = {
  sandbox: { api: 'https://preprod-api.myinvois.hasil.gov.my', portal: 'https://preprod.myinvois.hasil.gov.my' },
  production: { api: 'https://api.myinvois.hasil.gov.my', portal: 'https://myinvois.hasil.gov.my' },
}

/** The link printed as the receipt's QR code once a document is valid. */
export const validationUrl = (env: Environment, uuid: string, longId: string) =>
  `${HOSTS[env].portal}/${uuid}/share/${longId}`

export interface SubmitResult {
  submissionUid: string | null
  accepted: { uuid: string; codeNumber: string }[]
  rejected: { codeNumber: string; error: unknown }[]
}

export interface DocumentSummary {
  uuid: string
  codeNumber: string
  status: string            // Submitted | Valid | Invalid | Cancelled
  longId: string | null
}

export class MyInvoisError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message)
  }
}

const bytesToHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export class MyInvoisClient {
  private token: { value: string; expiresAt: number } | null = null

  constructor(readonly env: Environment, private readonly clientId: string, private readonly clientSecret: string) {}

  /** Tokens last an hour; reuse one until a minute before it ends (LHDN limits token calls). */
  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value
    const res = await fetch(`${HOSTS[this.env].api}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
        scope: 'InvoicingAPI',
      }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body?.access_token) throw new MyInvoisError('MyInvois refused the credentials', res.status, body)
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
    return this.token.value
  }

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${HOSTS[this.env].api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const parsed = await res.json().catch(() => null)
    if (!res.ok) throw new MyInvoisError(`MyInvois ${method} ${path} → ${res.status}`, res.status, parsed)
    return parsed
  }

  /** Submit JSON documents (up to 100 per call). Each is sent as base64 of its exact bytes plus their SHA-256. */
  async submit(docs: { codeNumber: string; document: Record<string, unknown> }[]): Promise<SubmitResult> {
    const documents = await Promise.all(docs.map(async (d) => {
      const bytes = new TextEncoder().encode(JSON.stringify(d.document))
      return {
        format: 'JSON',
        document: bytesToBase64(bytes),
        documentHash: bytesToHex(await crypto.subtle.digest('SHA-256', bytes)),
        codeNumber: d.codeNumber,
      }
    }))
    const r = await this.call('POST', '/api/v1.0/documentsubmissions/', { documents })
    return {
      submissionUid: r?.submissionUid ?? r?.submissionUID ?? null,
      accepted: (r?.acceptedDocuments ?? []).map((a: any) => ({ uuid: a.uuid, codeNumber: a.invoiceCodeNumber })),
      rejected: (r?.rejectedDocuments ?? []).map((x: any) => ({ codeNumber: x.invoiceCodeNumber, error: x.error })),
    }
  }

  async getSubmission(submissionUid: string): Promise<DocumentSummary[]> {
    const r = await this.call('GET', `/api/v1.0/documentsubmissions/${encodeURIComponent(submissionUid)}?pageNo=1&pageSize=100`)
    return (r?.documentSummary ?? []).map((d: any) => ({
      uuid: d.uuid, codeNumber: d.internalId, status: d.status, longId: d.longId || null,
    }))
  }

  /** Why a document is Invalid: the validator's step results. */
  async getDocumentDetails(uuid: string): Promise<unknown> {
    const r = await this.call('GET', `/api/v1.0/documents/${encodeURIComponent(uuid)}/details`)
    return r?.validationResults ?? r
  }
}
