/** Browser only (canvas): read an uploaded image into the receipt logo, and draw a logo as it will print.
 *  Never imported by the print agent. */
import { fromBase64, type ReceiptLogo } from '../print/logo'
import { fitLogoSize, makeLogo, unpackBits } from './logoImage'

export async function readLogoFile(file: File): Promise<ReceiptLogo> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (PNG or JPG).')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('This image could not be read. Try a PNG or JPG.')
  }
  const { width, height } = fitLogoSize(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('This browser cannot read images.')
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return makeLogo(ctx.getImageData(0, 0, width, height).data, width, height)
}

/** The dithered logo, black dots on white, at its printed size. */
export function drawLogo(canvas: HTMLCanvasElement, logo: ReceiptLogo): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const bits = unpackBits(fromBase64(logo.data), logo.width, logo.height)
  const img = ctx.createImageData(logo.width, logo.height)
  for (let i = 0; i < bits.length; i++) {
    const v = bits[i] ? 0 : 255
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}
