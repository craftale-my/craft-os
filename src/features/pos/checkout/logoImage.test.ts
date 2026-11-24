import { describe, expect, it } from 'vitest'
import { ditherFloydSteinberg, fitLogoSize, grayscale, levels, makeLogo, packBits, unpackBits } from './logoImage'

describe('fitLogoSize: at most 384 × 240 dots, the width a multiple of 8, never enlarged', () => {
  it('scales down to fit, keeping the shape', () => {
    expect(fitLogoSize(800, 400)).toEqual({ width: 384, height: 192 })
    expect(fitLogoSize(1000, 1000)).toEqual({ width: 240, height: 240 })
    expect(fitLogoSize(300, 1000)).toEqual({ width: 72, height: 240 })
    expect(fitLogoSize(2000, 10)).toEqual({ width: 384, height: 2 })
  })
  it('a small image keeps its size, the width down to a multiple of 8 (at least 8)', () => {
    expect(fitLogoSize(100, 50)).toEqual({ width: 96, height: 48 })
    expect(fitLogoSize(5, 5)).toEqual({ width: 8, height: 8 })
  })
})

describe('grayscale', () => {
  it('luminance, on white: transparent is white', () => {
    const g = grayscale(Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 255, 0, 0, 255]), 4, 1)
    expect(g[0]).toBeCloseTo(0)
    expect(g[1]).toBeCloseTo(255)
    expect(g[2]).toBeCloseTo(255)
    expect(g[3]).toBeCloseTo(76.245, 2)
  })
})

describe('ditherFloydSteinberg (1 = black)', () => {
  it('black stays black, white stays white', () => {
    expect(Array.from(ditherFloydSteinberg(new Float32Array(8).fill(0), 8, 1))).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect(Array.from(ditherFloydSteinberg(new Float32Array(8).fill(255), 8, 1))).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
  it('mid gray in one row: every other dot (7/16 of the error to the right)', () => {
    expect(Array.from(ditherFloydSteinberg(new Float32Array(8).fill(128), 8, 1))).toEqual([0, 1, 0, 1, 0, 1, 0, 1])
  })
  it('the error goes down too (3/16, 5/16, 1/16)', () => {
    expect(Array.from(ditherFloydSteinberg(new Float32Array(4).fill(128), 2, 2))).toEqual([0, 1, 1, 0])
  })
})

describe('packBits / unpackBits', () => {
  it('rows of width / 8 bytes, the leftmost dot the high bit', () => {
    const bits = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    expect(Array.from(packBits(bits, 16, 2))).toEqual([0x80, 0x01, 0xff, 0xff])
    expect(Array.from(unpackBits(packBits(bits, 16, 2), 16, 2))).toEqual(Array.from(bits))
  })
})

describe('makeLogo', () => {
  it('an all-black 8 × 1 image is one 0xff byte', () => {
    const black = new Uint8ClampedArray(32).map((_, i) => (i % 4 === 3 ? 255 : 0))
    expect(makeLogo(black, 8, 1)).toEqual({ width: 8, height: 1, data: '/w==' })
  })
})

describe('levels: a light background prints as clean paper', () => {
  it('whitens 215 and above, blackens 40 and below, stretches the middle', () => {
    expect(Array.from(levels(Float32Array.from([250, 215, 214, 127.5, 40, 10])))).toEqual([255, 255, expect.closeTo(254, 0), expect.closeTo(127.5, 0), 0, 0])
  })

  it('a cream background (RGB 235, 228, 215) leaves no dots', () => {
    const cream = new Array(16 * 2).fill(0).flatMap(() => [235, 228, 215, 255])
    expect(makeLogo(cream, 16, 2).data).toBe(makeLogo(new Array(16 * 2).fill(0).flatMap(() => [255, 255, 255, 255]), 16, 2).data)
  })
})
