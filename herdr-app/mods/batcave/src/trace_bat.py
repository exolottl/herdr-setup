import json, os
from PIL import Image, ImageDraw

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference.png")
HERE = os.path.dirname(os.path.abspath(__file__))

im = Image.open(SRC).convert("L")
ImageDraw.Draw(im).ellipse([10, 335, 125, 450], fill=255)  # the camera-lens button
w, h = im.size
px = im.load()

# Largest dark blob reachable from the centre of the image = the bat.
comp = bytearray(w * h)
stack = [(w // 2, h // 2)]
assert px[stack[0]] < 110, "seed is not inside the silhouette"
while stack:
    x, y = stack.pop()
    i = y * w + x
    if comp[i] or px[x, y] >= 110:
        continue
    comp[i] = 1
    if x > 0: stack.append((x - 1, y))
    if x < w - 1: stack.append((x + 1, y))
    if y > 0: stack.append((x, y - 1))
    if y < h - 1: stack.append((x, y + 1))

cols = {}
for y in range(h):
    for x in range(w):
        if comp[y * w + x]:
            lo, hi = cols.get(x, (y, y))
            cols[x] = (min(lo, y), max(hi, y))
xs = sorted(cols)
minx, maxx = xs[0], xs[-1]
miny = min(v[0] for v in cols.values()); maxy = max(v[1] for v in cols.values())

# The silhouette has no overhangs, so top edge left-to-right + bottom edge right-to-left closes it.
top = [(x, cols[x][0]) for x in xs]
bottom = [(x, cols[x][1] + 1) for x in reversed(xs)]
poly = top + bottom

def dp(pts, eps):
    if len(pts) < 3: return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    dx, dy = x1 - x0, y1 - y0
    L = (dx*dx + dy*dy) ** 0.5 or 1
    idx, best = 0, -1
    for i in range(1, len(pts) - 1):
        d = abs(dy * (pts[i][0] - x0) - dx * (pts[i][1] - y0)) / L
        if d > best: idx, best = i, d
    if best > eps:
        return dp(pts[:idx + 1], eps)[:-1] + dp(pts[idx:], eps)
    return [pts[0], pts[-1]]

poly = dp(poly, 0.9)
bw, bh = maxx - minx + 1, maxy - miny + 1
out = {"w": bw, "h": bh, "pts": [[round((x - minx) / bw, 4), round((y - miny) / bh, 4)] for x, y in poly]}
json.dump(out, open(os.path.join(HERE, "bat_points.json"), "w"))
print("bbox", bw, "x", bh, "points", len(poly))
