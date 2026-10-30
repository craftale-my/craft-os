import { supabase } from '../../shared/lib/supabase'
import { ACCOUNTS_DEFAULT, TAX, DOC_TYPES, type AccountRow, type DocFile } from './claimDesk'
import type { AiImage } from './imaging'

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

const AI_ERRORS: Record<string, string> = {
  ai_not_configured: 'AI reading is not switched on yet — please fill the form in by hand.',
  rate_limited: 'The AI is busy. Try again in a minute.',
  refused: 'The AI would not read this document. Please fill the form in by hand.',
  invalid_json: 'The AI reply could not be read. Press the button again.',
  too_many_images: 'Too many pictures at once — send them in two claims.',
  too_large: 'The pictures are too large. Send fewer at a time.',
  bad_image: 'One of the files is not a picture the AI can read.',
  not_active_staff: 'Your account is not active.',
  forbidden: 'You do not have access to this.',
}

/** Supabase hides a non-2xx body behind error.context; unwrap it into { code, detail }. */
async function invoke(fn: string, body: Record<string, unknown>): Promise<Outcome<Record<string, unknown>>> {
  const { data, error } = await supabase.functions.invoke(fn, { body })
  if (!error) return { ok: true, data: (data ?? {}) as Record<string, unknown> }
  let code = ''
  let detail = error.message
  const ctx = (error as { context?: Response }).context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const parsed = await ctx.json()
      code = parsed?.error ?? ''
      detail = parsed?.message ?? parsed?.detail ?? code ?? detail
    } catch {
      // body was not JSON
    }
  }
  return { ok: false, code, error: typeof detail === 'string' ? detail : JSON.stringify(detail) }
}

export async function aiRead<T = unknown>(
  task: 'taobao' | 'receipt' | 'suggest',
  input: { images?: AiImage[]; pdf?: string; suppliers?: string[] },
  accounts: string[],
): Promise<Outcome<T>> {
  const r = await invoke('claim-ai', {
    task, ...input, accounts,
    taxes: TAX, docTypes: DOC_TYPES.filter(t => !t.startsWith('Foreign')),
  })
  if (!r.ok) return { ok: false, code: r.code, error: AI_ERRORS[r.code ?? ''] ?? `AI reading failed (${r.code || r.error}).` }
  return { ok: true, data: r.data.result as T }
}

export async function inbox(action: 'status' | 'sync' | 'details', body: Record<string, unknown> = {}) {
  return invoke('myinvois-inbox', { action, ...body })
}

/** Chart of accounts (names + AutoCount codes). Falls back to the built-in list before the migration. */
export async function loadAccounts(): Promise<AccountRow[]> {
  const { data } = await supabase.from('account_config').select('accounts').eq('id', 1).maybeSingle()
  const list = (data?.accounts as AccountRow[] | undefined) ?? []
  return list.length ? list : ACCOUNTS_DEFAULT
}

export async function loadCompanyName(): Promise<string> {
  const { data } = await supabase.from('company_settings').select('company_name').limit(1).maybeSingle()
  return (data?.company_name as string | undefined) || 'CRAFTALE SDN. BHD.'
}

/** Upload under an unguessable path. claim-receipts is a public bucket, so the path is the only protection. */
export async function uploadFile(bucket: 'claim-receipts' | 'account-docs', folder: string, blob: Blob, name: string): Promise<Outcome<DocFile>> {
  const ext = (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  const path = `${folder}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(bucket).upload(path, blob, { contentType: blob.type || undefined })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { bucket, path, name, type: blob.type } }
}

/** A link that opens the file: public URL for claim-receipts, a 10-minute signed URL for account-docs. */
export async function fileUrl(f: DocFile): Promise<string | null> {
  if (f.url) return f.url
  if (!f.bucket || !f.path) return null
  if (f.bucket === 'claim-receipts') return supabase.storage.from(f.bucket).getPublicUrl(f.path).data.publicUrl
  const { data } = await supabase.storage.from(f.bucket).createSignedUrl(f.path, 600)
  return data?.signedUrl ?? null
}
