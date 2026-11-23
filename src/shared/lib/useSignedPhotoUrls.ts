import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import { RECEIVING_PHOTOS_BUCKET, toStoragePath } from './photos'

interface Signed {
  key: string
  /** Storage path -> signed URL, or null when signing failed. */
  byPath: Record<string, string | null>
}

/**
 * Signed URLs for photos in the private 'receiving-photos' bucket.
 * `values` are stored column values (paths, or legacy URLs). Returns a map
 * keyed by the original value: a signed URL, or null when the photo cannot be
 * shown (unsignable value, or RLS / missing object). Values still being signed
 * are absent from the map while `loading` is true.
 * One createSignedUrls call per change of the list; no refresh (URLs last `expiresIn` s).
 */
export function useSignedPhotoUrls(
  values: (string | null | undefined)[],
  expiresIn = 3600,
): { urls: Record<string, string | null>; loading: boolean } {
  // Stable dependency: the joined list, not the array identity.
  const key = values.map(v => v ?? '').join('\n')

  const { originals, paths } = useMemo(() => {
    const originals = [...new Set(key.split('\n').filter(Boolean))]
    const paths = [...new Set(originals.map(v => toStoragePath(v)).filter((p): p is string => !!p))]
    return { originals, paths }
  }, [key])
  const pathsKey = paths.join('\n')

  const [signed, setSigned] = useState<Signed>({ key: '', byPath: {} })

  useEffect(() => {
    if (!pathsKey) return
    const list = pathsKey.split('\n')
    let cancelled = false
    const finish = (byPath: Record<string, string | null>) => {
      if (!cancelled) setSigned({ key: pathsKey, byPath })
    }
    supabase.storage
      .from(RECEIVING_PHOTOS_BUCKET)
      .createSignedUrls(list, expiresIn)
      .then(({ data, error }) => {
        const byPath: Record<string, string | null> = {}
        for (const p of list) byPath[p] = null
        if (!error) {
          ;(data ?? []).forEach((d, i) => {
            const p = d.path ?? list[i]
            if (p in byPath && !d.error && d.signedUrl) byPath[p] = d.signedUrl
          })
        }
        finish(byPath)
      })
      .catch(() => finish(Object.fromEntries(list.map(p => [p, null]))))
    return () => { cancelled = true }
  }, [pathsKey, expiresIn])

  const loading = !!pathsKey && signed.key !== pathsKey

  const urls = useMemo(() => {
    const out: Record<string, string | null> = {}
    for (const v of originals) {
      const p = toStoragePath(v)
      if (!p) { out[v] = null; continue }
      // Keep URLs signed for an earlier list while the new one is in flight.
      if (p in signed.byPath) out[v] = signed.byPath[p]
      else if (!loading) out[v] = null
    }
    return out
  }, [originals, signed, loading])

  return { urls, loading }
}

/** Single-photo convenience wrapper: url is undefined while signing, null when unavailable. */
export function useSignedPhotoUrl(
  value: string | null | undefined,
  expiresIn = 3600,
): { url: string | null | undefined; loading: boolean } {
  const { urls, loading } = useSignedPhotoUrls([value], expiresIn)
  return { url: value ? urls[value] : null, loading }
}
