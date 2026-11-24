// src/features/pos/menu/photoImport.ts
/** The import's Photos step (spec §5), pure so it is tested: read a zip of
 *  <feedme_product_id>.<ext> files and match each file to a product by its Feedme product ID. */
import { unzipSync } from 'fflate'
import type { PhotoTarget } from './slotsApi'
import { PHOTO_MAX_INPUT_BYTES, imageTypeFromName } from './photo'

/** One image file of the zip; `key` is its name without the extension (the Feedme product ID),
 *  `path` where it sits in the zip (inflatePhoto unpacks it when it is uploaded). */
export interface ZipPhoto { fileName: string; key: string; type: string; path: string }

/** The image files of a zip, wherever they sit in it — listed, none unpacked yet (a few hundred
 *  photos unpacked at once would not fit an iPad's memory). Folders and macOS extras (__MACOSX/,
 *  ._*, .DS_Store) are left out silently; files that are not images, or are 10 MB or more, are
 *  listed as skipped. */
export function readPhotoZip(zip: Uint8Array): { photos: ZipPhoto[]; skipped: string[] } {
  const photos: ZipPhoto[] = []
  const skipped: string[] = []
  const baseOf = (path: string) => path.split('/').pop() ?? ''
  unzipSync(zip, {
    filter: (f) => {
      const base = baseOf(f.name)
      if (f.name.endsWith('/') || f.name.startsWith('__MACOSX/') || base.startsWith('.') || base === '') return false
      if (!imageTypeFromName(base)) { skipped.push(base); return false }
      if (f.originalSize >= PHOTO_MAX_INPUT_BYTES) { skipped.push(`${base} (10 MB or more)`); return false }
      photos.push({ fileName: base, key: base.slice(0, base.lastIndexOf('.')).trim(), type: imageTypeFromName(base), path: f.name })
      return false                                                   // listed only: unpacked one at a time on upload
    },
  })
  photos.sort((a, b) => a.fileName.localeCompare(b.fileName))
  return { photos, skipped: skipped.sort() }
}

/** One photo of the zip, unpacked (only this entry is inflated). */
export function inflatePhoto(zip: Uint8Array, photo: Pick<ZipPhoto, 'path' | 'fileName'>): Uint8Array {
  const bytes = unzipSync(zip, { filter: (f) => f.name === photo.path })[photo.path]
  if (!bytes) throw new Error(`${photo.fileName} could not be read from the zip`)
  return bytes
}

export interface PhotoMatch { photo: ZipPhoto; product: PhotoTarget }
export interface PhotoPlan {
  /** matched files to upload */
  toUpload: PhotoMatch[]
  /** matched, but the product already has a photo and "skip" is on */
  keptExisting: PhotoMatch[]
  /** file names whose ID is no product's Feedme product ID */
  unmatched: string[]
  /** a second file for a product already matched (the first one wins) */
  duplicates: string[]
}

/** Matches files to products by Feedme product ID (exact, spaces at the ends ignored). */
export function planPhotoImport(photos: ZipPhoto[], targets: PhotoTarget[], skipExisting: boolean): PhotoPlan {
  const byFeedmeId = new Map<string, PhotoTarget>()
  for (const t of targets) if (t.feedmeProductId?.trim()) byFeedmeId.set(t.feedmeProductId.trim(), t)
  const plan: PhotoPlan = { toUpload: [], keptExisting: [], unmatched: [], duplicates: [] }
  const taken = new Set<string>()
  for (const photo of photos) {
    const product = byFeedmeId.get(photo.key)
    if (!product) { plan.unmatched.push(photo.fileName); continue }
    if (taken.has(product.id)) { plan.duplicates.push(photo.fileName); continue }
    taken.add(product.id)
    if (skipExisting && product.imagePath) plan.keptExisting.push({ photo, product })
    else plan.toUpload.push({ photo, product })
  }
  return plan
}

/** Products on sale (switched on, not add-on items) that have no photo. */
export const withoutPhoto = (targets: PhotoTarget[]): PhotoTarget[] =>
  targets.filter((t) => t.isActive && !t.isAddon && !t.imagePath)
