import { describe, it, expect } from 'vitest'
import { RECEIVING_PHOTOS_BUCKET, toStoragePath } from './photos'

const BASE = 'https://abc.supabase.co/storage/v1/object'

describe('toStoragePath', () => {
  it('uses the receiving-photos bucket by default', () => {
    expect(RECEIVING_PHOTOS_BUCKET).toBe('receiving-photos')
  })

  it('returns a plain path unchanged', () => {
    expect(toStoragePath('po-1/1700000000-invoice.jpg')).toBe('po-1/1700000000-invoice.jpg')
    expect(toStoragePath('wastage/br-1/2026-10-27/u-1.jpg')).toBe('wastage/br-1/2026-10-27/u-1.jpg')
    expect(toStoragePath('test-placeholders/x.png')).toBe('test-placeholders/x.png')
  })

  it('strips a leading slash', () => {
    expect(toStoragePath('/po-1/a.jpg')).toBe('po-1/a.jpg')
  })

  it('extracts the path from a public URL', () => {
    expect(toStoragePath(`${BASE}/public/receiving-photos/po-1/1700-invoice.jpg`)).toBe('po-1/1700-invoice.jpg')
  })

  it('extracts the path from a signed URL with a token', () => {
    expect(toStoragePath(`${BASE}/sign/receiving-photos/po-1/a.jpg?token=eyJhbGciOi.x.y`)).toBe('po-1/a.jpg')
    expect(toStoragePath(`${BASE}/authenticated/receiving-photos/po-1/b.jpg`)).toBe('po-1/b.jpg')
  })

  it('URL-decodes the path', () => {
    expect(toStoragePath(`${BASE}/public/receiving-photos/po-1/my%20photo.jpg`)).toBe('po-1/my photo.jpg')
  })

  it('returns null for another bucket', () => {
    expect(toStoragePath(`${BASE}/public/company-assets/logo.png`)).toBeNull()
    expect(toStoragePath(`${BASE}/public/company-assets/logo.png`, 'company-assets')).toBe('logo.png')
  })

  it('returns null for an external URL', () => {
    expect(toStoragePath('https://example.com/photo.jpg')).toBeNull()
    expect(toStoragePath('http://example.com/receiving-photos/a.jpg')).toBeNull()
  })

  it('returns null for empty values', () => {
    expect(toStoragePath(null)).toBeNull()
    expect(toStoragePath(undefined)).toBeNull()
    expect(toStoragePath('')).toBeNull()
    expect(toStoragePath('   ')).toBeNull()
    expect(toStoragePath('/')).toBeNull()
  })
})
