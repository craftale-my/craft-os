import { describe, expect, it } from 'vitest'
import {
  PHOTO_MAX_HEIGHT, PHOTO_MAX_INPUT_BYTES, PHOTO_MAX_WIDTH, PHOTO_QUALITY, imageTypeFromName, photoInputProblem, photoPath, resizeTarget,
} from './photo'

describe('photo rules', () => {
  it('uses the spec parameters: 800 px wide, quality 0.8, input under 10 MB', () => {
    expect(PHOTO_MAX_WIDTH).toBe(800)
    expect(PHOTO_MAX_HEIGHT).toBe(1600)
    expect(PHOTO_QUALITY).toBe(0.8)
    expect(PHOTO_MAX_INPUT_BYTES).toBe(10 * 1024 * 1024)
  })
  it('accepts an image under 10 MB only', () => {
    expect(photoInputProblem({ type: 'image/jpeg', size: 2_000_000 })).toBeNull()
    expect(photoInputProblem({ type: 'image/png', size: PHOTO_MAX_INPUT_BYTES - 1 })).toBeNull()
    expect(photoInputProblem({ type: 'image/png', size: PHOTO_MAX_INPUT_BYTES })).toBe('The photo is too large (at most 10 MB)')
    expect(photoInputProblem({ type: 'application/pdf', size: 10 })).toBe('Choose an image file (JPEG, PNG, WebP or HEIC)')
    expect(photoInputProblem({ type: '', size: 10 })).toBe('Choose an image file (JPEG, PNG, WebP or HEIC)')
    expect(photoInputProblem({ type: 'image/webp', size: 0 })).toBe('The photo file is empty')
  })
  it('scales down to 800 px wide (and 1600 px high) in proportion, never up', () => {
    expect(resizeTarget(800, 6000)).toEqual({ width: 213, height: 1600 })
    expect(resizeTarget(3000, 9000)).toEqual({ width: 533, height: 1600 })
    expect(resizeTarget(4032, 3024)).toEqual({ width: 800, height: 600 })
    expect(resizeTarget(1000, 1500)).toEqual({ width: 800, height: 1200 })
    expect(resizeTarget(1601, 3)).toEqual({ width: 800, height: 1 })
    expect(resizeTarget(640, 480)).toEqual({ width: 640, height: 480 })
    expect(resizeTarget(800, 800)).toEqual({ width: 800, height: 800 })
  })
  it('stores under products/<product id>/ with a random name', () => {
    const id = '3f2c1e9a-1111-4222-8333-944455566677'
    expect(photoPath(id, 'image/webp', 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff'))
      .toBe(`products/${id}/a1b2c3d4e5f647118899aabbccddeeff.webp`)
    expect(photoPath(id, 'image/jpeg', 'abcdefgh')).toBe(`products/${id}/abcdefgh.jpg`)
    expect(() => photoPath(id, 'image/jpeg', 'abc')).toThrow('A photo name needs at least 8 letters or digits')
  })
  it('reads the image type from a file name', () => {
    expect(imageTypeFromName('8812.JPG')).toBe('image/jpeg')
    expect(imageTypeFromName('8812.jpeg')).toBe('image/jpeg')
    expect(imageTypeFromName('8812.png')).toBe('image/png')
    expect(imageTypeFromName('8812.webp')).toBe('image/webp')
    expect(imageTypeFromName('notes.txt')).toBe('')
    expect(imageTypeFromName('8812')).toBe('')
  })
})
