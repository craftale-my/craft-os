#!/usr/bin/env python3
"""Generate the PWA icon set in public/icons/ from the brand logo.

The home-screen icon is the monkey mark only — the "CRAFT CAFE" wordmark in the
full logo is illegible once the icon is drawn at its real ~60px size, and
cropping it lets the mark itself be much larger.

Run this again if public/craft-logo.jpg ever changes:

    python3 scripts/generate-icons.py

Stdlib only. `sips` (built into macOS) decodes the source JPEG to PNG; the crop,
composite and downsample all happen here so there's no PIL/ImageMagick
dependency. On a non-macOS machine, convert the logo to PNG by any means and
pass it as argv[1].
"""
import os
import struct
import subprocess
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'craft-logo.jpg')
DEST = os.path.join(ROOT, 'public', 'icons')

CREAM = (0xF5, 0xF0, 0xE8)

# Bounding box of the monkey mark within the 1181x1181 source, measured by
# scanning for the blank rows that separate the mark from the wordmark.
HEAD = (209, 240, 937, 689)

# Luminance of the two tones in the source artwork. Remapping by luminance
# rather than thresholding keeps the antialiased edges of the line art smooth.
INK_L, PAPER_L = 121, 239

# The mark is drawn in a light taupe (#887458) that holds up at 180px and
# larger. A favicon is a different problem: the strokes cover only ~14% of the
# tile, so at 16px the box filter averages each one down towards the cream and
# the monkey washes out to a smudge. Favicons get the ink re-toned to the app's
# darkest brown, which roughly doubles the contrast the downsample has to work
# with. brown.dark in tailwind.config.js.
FAVICON_INK = (0x3D, 0x2B, 0x1F)

# A plain icon may fill most of its canvas. A maskable one gets cropped to a
# circle or squircle by the Android launcher, so the mark has to sit well inside
# the safe zone or the monkey loses its ears. Nothing crops a favicon and it is
# drawn at ~16px in the tab strip, so that one runs right out to the edge.
FILL_PLAIN = 0.80
FILL_MASKABLE = 0.60
FILL_FAVICON = 0.92

OUTPUTS = [
    ('icon-192.png', 192, FILL_PLAIN),
    ('icon-512.png', 512, FILL_PLAIN),
    # iOS applies its own rounding and ignores transparency, so this is the
    # plain mark at the size Apple asks for.
    ('apple-touch-icon-180.png', 180, FILL_PLAIN),
    ('icon-maskable-512.png', 512, FILL_MASKABLE),
    ('favicon-32.png', 32, FILL_FAVICON),
]

# Packed into public/favicon.ico. Browsers pick 16 or 32 for the tab; Windows
# uses 48 for a pinned shortcut.
ICO_SIZES = (16, 32, 48)


def read_png(path):
    data = open(path, 'rb').read()
    pos, idat = 8, b''
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, depth, colour = struct.unpack('>IIBB', chunk[:10])
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
    if depth != 8:
        raise SystemExit(f'expected an 8-bit PNG, got {depth}-bit')
    nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour]
    raw = zlib.decompress(idat)
    stride = w * nch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b = prev[i]
                c = prev[i - nch] if i >= nch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    if nch == 3:
        return w, h, out
    rgb = bytearray(w * h * 3)
    for i in range(w * h):
        if nch in (1, 2):
            v = out[i * nch]
            rgb[i * 3:i * 3 + 3] = bytes((v, v, v))
        else:
            rgb[i * 3:i * 3 + 3] = out[i * 4:i * 4 + 3]
    return w, h, rgb


def png_bytes(w, h, rgb):
    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff))

    raw = b''.join(b'\x00' + bytes(rgb[y * w * 3:(y + 1) * w * 3]) for y in range(h))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def write_png(path, w, h, rgb):
    open(path, 'wb').write(png_bytes(w, h, rgb))


def write_ico(path, images):
    """Pack `(size, png_blob)` pairs into one multi-resolution .ico.

    An .ico entry may hold either a BMP or a whole PNG file; every browser that
    is still shipping reads the PNG form. The bit-depth field is advisory, so
    the conventional 32 goes in even though these blobs are 24-bit.
    """
    offset = 6 + 16 * len(images)
    entries = b''
    for size, blob in images:
        entries += struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32,
                               len(blob), offset)
        offset += len(blob)
    blob = (struct.pack('<HHH', 0, 1, len(images)) + entries
            + b''.join(b for _, b in images))
    open(path, 'wb').write(blob)


def crop(px, w, box):
    x0, y0, x1, y1 = box
    cw, ch = x1 - x0, y1 - y0
    out = bytearray(cw * ch * 3)
    for y in range(ch):
        s = ((y + y0) * w + x0) * 3
        out[y * cw * 3:(y + 1) * cw * 3] = px[s:s + cw * 3]
    return cw, ch, out


def remap_ink(px, ink):
    """Re-tone the artwork from its own INK_L..PAPER_L range onto ink..CREAM.

    Interpolating on luminance keeps every antialiased edge pixel proportional,
    so the line art darkens without picking up jaggies.
    """
    out = bytearray(len(px))
    span = PAPER_L - INK_L
    for i in range(0, len(px), 3):
        lum = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) // 1000
        t = (PAPER_L - lum) / span
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        for c in range(3):
            out[i + c] = int(CREAM[c] + (ink[c] - CREAM[c]) * t + 0.5)
    return out


def pad_square(px, w, h, bg, fill_ratio):
    """Centre the mark on a square canvas so it occupies `fill_ratio` of the side."""
    side = int(round(max(w, h) / fill_ratio))
    out = bytearray(bytes(bg) * side * side)
    ox, oy = (side - w) // 2, (side - h) // 2
    for y in range(h):
        d = ((y + oy) * side + ox) * 3
        out[d:d + w * 3] = px[y * w * 3:(y + 1) * w * 3]
    return side, side, out


def resize_box(src, sw, sh, size):
    """Box-filter downsample to size x size."""
    dst = bytearray(size * size * 3)
    for dy in range(size):
        y0 = dy * sh // size
        y1 = max(y0 + 1, (dy + 1) * sh // size)
        for dx in range(size):
            x0 = dx * sw // size
            x1 = max(x0 + 1, (dx + 1) * sw // size)
            r = g = b = cnt = 0
            for y in range(y0, y1):
                base = y * sw * 3
                for x in range(x0, x1):
                    i = base + x * 3
                    r += src[i]
                    g += src[i + 1]
                    b += src[i + 2]
                    cnt += 1
            j = (dy * size + dx) * 3
            dst[j] = r // cnt
            dst[j + 1] = g // cnt
            dst[j + 2] = b // cnt
    return dst


def main():
    os.makedirs(DEST, exist_ok=True)

    if len(sys.argv) > 1:
        png, tmp = sys.argv[1], None
    else:
        tmp = os.path.join(DEST, '_source.png')
        subprocess.run(['sips', '-s', 'format', 'png', SRC, '--out', tmp],
                       check=True, capture_output=True)
        png = tmp

    w, h, px = read_png(png)
    cw, ch, mark = crop(px, w, HEAD)

    # Only the tab icons are re-toned; at 180px and up the artwork's own taupe
    # reads fine and the home-screen icons stay true to the printed logo.
    inked = remap_ink(mark, FAVICON_INK)

    rendered = {}
    for name, size, fill in OUTPUTS:
        src = inked if name.startswith('favicon') else mark
        sw, sh, square = pad_square(src, cw, ch, CREAM, fill)
        rendered[name] = resize_box(square, sw, sh, size)
        write_png(os.path.join(DEST, name), size, size, rendered[name])
        print(f'  public/icons/{name}  {size}x{size}  (mark fills {fill:.0%})')

    # Browsers find the tab icon through the <link> tags in index.html, but
    # /favicon.ico is still requested by convention — by search crawlers, by
    # anything bookmarking the app, and by the browser itself when a page 404s
    # before its <head> is parsed.
    ico = []
    for size in ICO_SIZES:
        px = rendered.get(f'favicon-{size}.png')
        if px is None:
            sw, sh, square = pad_square(inked, cw, ch, CREAM, FILL_FAVICON)
            px = resize_box(square, sw, sh, size)
        ico.append((size, png_bytes(size, size, px)))
    write_ico(os.path.join(ROOT, 'public', 'favicon.ico'), ico)
    print(f'  public/favicon.ico  {"+".join(str(s) for s in ICO_SIZES)}')

    if tmp:
        os.remove(tmp)
    print(f'{len(OUTPUTS)} icons written to public/icons/, plus public/favicon.ico')


if __name__ == '__main__':
    main()
