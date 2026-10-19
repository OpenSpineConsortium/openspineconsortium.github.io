"""tools/app_icons.py: draw the control panel's Home Screen icons.

    python -X utf8 tools/app_icons.py        # rewrite the four PNGs under assets/img/ where they differ

The control panel installs as an app of its own from a phone's browser (Safari's "Add to Home
Screen", Chrome's "Install app"), and a Home Screen wants a raster icon, which an SVG in the page's
head is not. The mark is Symphony's, as the Symphony browser extension draws it in its
public/icon.svg: a ring of eight players, the small orange circles, around the conductor's warm
white point, on a dark slate tile. It is drawn here from the same geometry with the standard library
alone, each pixel shaded by how much of it a shape covers (its signed distance, clamped to one
pixel), so no image library is needed and the pixels come out the same on every machine. The
compressed bytes are the same only where the zlib is: zlib-ng, which Python 3.14's Windows builds
and Fedora's zlib-ng-compat put behind the zlib module, packs the same rows into other bytes. So a
file is rewritten only when its decoded pixel rows differ from the drawing, never because its bytes
do, and a run under one zlib leaves alone what a run under the other wrote.

Four files, each for the place that asks for it:
- symphony-app-180.png: Apple's touch icon. iOS rounds the corners itself and fills anything
  transparent with black, so the slate runs to the edges.
- symphony-app-192.png and symphony-app-512.png: the manifest's icons for any use, the rounded tile
  on a transparent ground as the extension's icon is.
- symphony-app-maskable-512.png: the manifest's maskable icon. Android may cut it to a circle, a
  squircle or a teardrop, keeping only the middle 80% for sure, so the slate runs to the edges and
  the ring is drawn at 80% of its size.
"""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "img"

SLATE = (0x1F, 0x23, 0x28)
ORANGE = (0xD9, 0x77, 0x57)
WHITE = (0xFF, 0xF4, 0xEC)

# public/icon.svg's geometry, on its 128-unit canvas
TILE = (4, 4, 124, 124, 28)
RING = [(64, 22), (93.7, 34.3), (106, 64), (93.7, 93.7), (64, 106), (34.3, 93.7), (22, 64), (34.3, 34.3)]
PLAYER = 9
POINT = 13
POINT_HOLE = 5


def circle(cx, cy, r):
    return lambda x, y: math.hypot(x - cx, y - cy) - r


def rounded_rect(x0, y0, x1, y1, r):
    def d(x, y):
        qx = abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - r)
        qy = abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r)
        return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r
    return d


def layers(size, full_bleed, scale):
    """The shapes back to front, in pixels: each a colour and a signed distance."""
    unit = size / 128

    def at(v):
        return (64 + (v - 64) * scale) * unit

    tile = (lambda x, y: -1.0) if full_bleed else rounded_rect(*(v * unit for v in TILE[:4]), TILE[4] * unit)
    shapes = [(SLATE, tile)]
    shapes += [(ORANGE, circle(at(cx), at(cy), PLAYER * scale * unit)) for cx, cy in RING]
    shapes.append((WHITE, circle(at(64), at(64), POINT * scale * unit)))
    shapes.append((SLATE, circle(at(64), at(64), POINT_HOLE * scale * unit)))
    return shapes


def coverage(d):
    return min(1.0, max(0.0, 0.5 - d))


def pixel(shapes, x, y):
    """Premultiplied colour and alpha of one pixel, the shapes laid over each other."""
    r = g = b = a = 0.0
    for colour, dist in shapes:
        c = coverage(dist(x + 0.5, y + 0.5))
        if c <= 0:
            continue
        r, g, b = r * (1 - c) + colour[0] * c, g * (1 - c) + colour[1] * c, b * (1 - c) + colour[2] * c
        a = a * (1 - c) + c
    return r, g, b, a


def draw(size, full_bleed=False, scale=1.0):
    """The icon's pixel rows as a PNG holds them before compression: each row a filter byte of 0, then
    red, green, blue and alpha for each pixel."""
    shapes = layers(size, full_bleed, scale)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            r, g, b, a = pixel(shapes, x, y)
            if a > 0:
                r, g, b = r / a, g / a, b / a
            row += bytes((round(r), round(g), round(b), round(a * 255)))
        rows.append(bytes(row))
    return b"".join(rows)


SIGNATURE = b"\x89PNG\r\n\x1a\n"


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def header(size):
    """The signature and the IHDR chunk: a square of 8-bit RGBA, not interlaced."""
    return SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))


def png(size, raw):
    return header(size) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def pixel_rows(data):
    """The rows a PNG's IDAT chunks hold, decompressed, or None where they cannot be read."""
    idat, at = [], len(SIGNATURE)
    while at + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[at:at + 8])
        if kind == b"IDAT":
            idat.append(data[at + 8:at + 8 + length])
        at += 12 + length
    try:
        return zlib.decompress(b"".join(idat))
    except zlib.error:
        return None


def same_pixels(path, size, raw):
    """Whether the file on disk is this script's PNG of these rows, whatever zlib compressed them."""
    if not path.exists():
        return False
    data = path.read_bytes()
    return data.startswith(header(size)) and pixel_rows(data) == raw


ICONS = {
    "symphony-app-180.png": dict(size=180, full_bleed=True),
    "symphony-app-192.png": dict(size=192),
    "symphony-app-512.png": dict(size=512),
    "symphony-app-maskable-512.png": dict(size=512, full_bleed=True, scale=0.8),
}


def main():
    for name, how in ICONS.items():
        raw = draw(**how)
        path = OUT / name
        if not same_pixels(path, how["size"], raw):
            path.write_bytes(png(how["size"], raw))
            print("wrote", path.relative_to(ROOT).as_posix())


if __name__ == "__main__":
    main()
