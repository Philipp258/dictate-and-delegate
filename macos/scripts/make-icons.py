#!/usr/bin/env python3
"""Draws the app icon (the Android launcher's wave on its green) as a macOS .icns and a PNG.
Usage: make-icons.py <out dir>"""
import io, struct, sys
from PIL import Image, ImageDraw

WAVE = [((30, 58), (37, 58), (37, 44), (44, 44)), ((44, 44), (51, 44), (51, 64), (58, 64)),
        ((58, 64), (65, 64), (65, 48), (72, 48)), ((72, 48), (77, 48), (77, 55), (79, 55))]

def points(scale, dx, dy):
    out = []
    for p0, p1, p2, p3 in WAVE:
        for i in range(81):
            t = i / 80
            x = (1-t)**3*p0[0] + 3*(1-t)**2*t*p1[0] + 3*(1-t)*t*t*p2[0] + t**3*p3[0]
            y = (1-t)**3*p0[1] + 3*(1-t)**2*t*p1[1] + 3*(1-t)*t*t*p2[1] + t**3*p3[1]
            out.append((x*scale+dx, y*scale+dy))
    return out

def wave(draw, scale, dx, dy, width, color):
    # Round pen: a disc stamped densely along the curve (PIL's wide lines leave notches).
    pts = points(scale, dx, dy)
    r = width / 2
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        steps = max(1, int(((x1-x0)**2 + (y1-y0)**2) ** 0.5 / (r / 8)))
        for i in range(steps + 1):
            x, y = x0 + (x1-x0)*i/steps, y0 + (y1-y0)*i/steps
            draw.ellipse((x-r, y-r, x+r, y+r), fill=color)

def app_icon(size):
    big = size * 4
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = big * 100 / 1024  # Apple's grid: the body is 824 of 1024.
    d.rounded_rectangle((m, m, big-m, big-m), radius=big*185/1024, fill=(11, 122, 94, 255))
    # The wave spans x 30..79 of 108 (centre 54.5, 56 tall around y 54): fill ~62% of the body.
    body = big - 2*m
    scale = body * 0.56 / 49
    dx = big/2 - 54.5*scale
    dy = big/2 - 54*scale
    wave(d, scale, dx, dy, 6.5*scale, (255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)

def png(img):
    b = io.BytesIO()
    img.save(b, 'PNG')
    return b.getvalue()

def icns(path):
    chunks = b''
    for tag, size in ((b'ic10', 1024), (b'ic09', 512), (b'ic08', 256), (b'ic07', 128),
                      (b'ic13', 256), (b'ic12', 64), (b'ic11', 32)):
        data = png(app_icon(size))
        chunks += tag + struct.pack('>I', len(data) + 8) + data
    open(path, 'wb').write(b'icns' + struct.pack('>I', len(chunks) + 8) + chunks)

out = sys.argv[1]
icns(f'{out}/icon.icns')
app_icon(512).save(f'{out}/icon.png')
