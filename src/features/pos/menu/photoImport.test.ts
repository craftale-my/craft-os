import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { planPhotoImport, readPhotoZip, withoutPhoto } from './photoImport'
import type { PhotoTarget } from './slotsApi'

const target = (id: string, feedmeProductId: string | null, over: Partial<PhotoTarget> = {}): PhotoTarget =>
  ({ id, name: `Product ${id}`, feedmeProductId, imagePath: null, isActive: true, isAddon: false, ...over })
const zip = zipSync({
  'photos/FM-1.jpg': strToU8('a'),
  'photos/FM-2.PNG': strToU8('b'),
  'photos/FM-9.webp': strToU8('c'),
  'photos/notes.txt': strToU8('d'),
  'photos/.DS_Store': strToU8('e'),
  '__MACOSX/photos/._FM-1.jpg': strToU8('f'),
  'FM-1.jpeg': strToU8('g'),
  'photos/': new Uint8Array(0),
  'photos/FM-7.jpg': new Uint8Array(10 * 1024 * 1024),
})

describe('readPhotoZip', () => {
  it('reads every image wherever it sits, keyed by its name without the extension', () => {
    const { photos, skipped } = readPhotoZip(zip)
    expect(photos.map((p) => [p.fileName, p.key, p.type])).toEqual([
      ['FM-1.jpeg', 'FM-1', 'image/jpeg'], ['FM-1.jpg', 'FM-1', 'image/jpeg'],
      ['FM-2.PNG', 'FM-2', 'image/png'], ['FM-9.webp', 'FM-9', 'image/webp'],
    ])
    expect(skipped).toEqual(['FM-7.jpg (10 MB or more)', 'notes.txt'])
  })
  it('refuses a file that is not a zip', () => {
    expect(() => readPhotoZip(strToU8('not a zip'))).toThrow()
  })
})

describe('planPhotoImport', () => {
  const { photos } = readPhotoZip(zip)
  const targets = [target('a', 'FM-1'), target('b', ' FM-2 ', { imagePath: 'products/b/x1234567.webp' }), target('c', null), target('d', 'FM-4')]
  it('matches by Feedme product ID, first file wins, lists the rest', () => {
    const plan = planPhotoImport(photos, targets, true)
    expect(plan.toUpload.map((m) => [m.photo.fileName, m.product.id])).toEqual([['FM-1.jpeg', 'a']])
    expect(plan.keptExisting.map((m) => m.product.id)).toEqual(['b'])
    expect(plan.duplicates).toEqual(['FM-1.jpg'])
    expect(plan.unmatched).toEqual(['FM-9.webp'])
  })
  it('replaces existing photos when skip is off', () => {
    const plan = planPhotoImport(photos, targets, false)
    expect(plan.toUpload.map((m) => m.product.id)).toEqual(['a', 'b'])
    expect(plan.keptExisting).toEqual([])
  })
  it('lists products on sale that still have no photo', () => {
    const all = [...targets, target('e', 'FM-5', { isAddon: true }), target('f', 'FM-6', { isActive: false })]
    expect(withoutPhoto(all).map((t) => t.id)).toEqual(['a', 'c', 'd'])
  })
})
