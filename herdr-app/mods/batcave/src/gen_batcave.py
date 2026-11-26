import os, json, random, shutil
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.expanduser("~/.config/herdr-app/mods/batcave")
SCRATCH = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)
random.seed(7)
YEL = (245, 197, 24)

# Silhouette traced from the reference image by trace_bat.py; coordinates normalised to its bbox.
_bat = json.load(open(os.path.join(SCRATCH, "bat_points.json")))
BAT, ASPECT = _bat["pts"], _bat["h"] / _bat["w"]
VW = 1000; VH = round(VW * ASPECT)

def bat_mask(w, h, alpha=255):
    s = 4
    m = Image.new("L", (w*s, h*s), 0)
    ImageDraw.Draw(m).polygon([(x*w*s, y*h*s) for x, y in BAT], fill=alpha)
    return m.resize((w, h), Image.LANCZOS)

def bat_fit(width, alpha=255):
    return bat_mask(width, round(width * ASPECT), alpha)

def vgradient(w, h, stops):
    col = Image.new("RGB", (1, h))
    px = col.load()
    for y in range(h):
        p = y / (h - 1)
        for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
            if p0 <= p <= p1:
                t = (p - p0) / (p1 - p0) if p1 > p0 else 0
                px[0, y] = tuple(round(c0[k] + (c1[k] - c0[k]) * t) for k in range(3))
                break
    return col.resize((w, h))

def glow(w, h, cx, cy, r, amax):
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    for i in range(40, 0, -1):
        rr = r * i / 40
        d.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], fill=int(255 * amax * (1 - i/40) ** 1.6))
    return m.filter(ImageFilter.GaussianBlur(r / 10))

def tint(base, color, mask):
    base.paste(Image.new("RGB", base.size, color), (0, 0), mask)

def scanlines(img, alpha=16, step=4):
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for y in range(0, img.size[1], step):
        d.line([(0, y), (img.size[0], y)], fill=(0, 0, 0, alpha))
    return Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")

def place(mask, W, H, cx, cy):
    return mask.transform((W, H), Image.AFFINE, (1, 0, -(cx - mask.size[0] // 2), 0, 1, -(cy - mask.size[1] // 2)))

# ---------- preview of the emblem alone ----------
pv = Image.new("RGB", (400, 200), (245, 197, 24))
tint(pv, (12, 14, 24), place(bat_fit(360), 400, 200, 200, 100))
pv.save(os.path.join(SCRATCH, "bat-preview.png"))

# ---------- sidebar: Gotham night, bat-signal, skyline ----------
W, H = 460, 1844
sky = vgradient(W, H, [(0, (13, 15, 30)), (0.25, (7, 8, 16)), (0.7, (6, 7, 14)), (1, (9, 11, 22))])
cx, cy, r = 230, 690, 170
beam = Image.new("L", (W, H), 0)
ImageDraw.Draw(beam).polygon([(W + 80, H - 120), (cx - r * 0.85, cy - r * 0.35), (cx + r * 0.75, cy + r * 0.8)], fill=48)
beam = beam.filter(ImageFilter.GaussianBlur(28))
tint(sky, YEL, beam)
tint(sky, YEL, glow(W, H, cx, cy, r, 0.38))
tint(sky, (6, 7, 14), place(bat_fit(230, 235), W, H, cx, cy))

d = ImageDraw.Draw(sky)
def skyline(color, ymin, ymax, win_alpha):
    x = -10
    while x < W:
        bw = random.randint(28, 74); bh = random.randint(ymin, ymax)
        top = H - bh
        d.rectangle([x, top, x + bw, H], fill=color)
        if bh > ymax * 0.8 and random.random() < 0.5:
            d.line([(x + bw // 2, top), (x + bw // 2, top - random.randint(20, 60))], fill=color, width=2)
        for wy in range(top + 10, H - 40, 12):
            for wx in range(x + 5, x + bw - 6, 9):
                if random.random() < 0.16:
                    a = random.randint(*win_alpha)
                    c = YEL if random.random() < 0.8 else (235, 225, 190)
                    d.rectangle([wx, wy, wx + 4, wy + 6], fill=tuple((c[k] * a + color[k] * (255 - a)) // 255 for k in range(3)))
        x += bw + random.randint(2, 10)
skyline((12, 14, 28), 160, 360, (40, 90))
skyline((5, 6, 12), 90, 260, (70, 150))
sky = scanlines(sky, 14)
sky.save(os.path.join(OUT, "sidebar.png"))

# ---------- pane backdrop: HUD grid, radar arcs, bat watermark ----------
W, H = 1658, 1224
grid = vgradient(W, H, [(0, (12, 14, 27)), (1, (8, 10, 19))])
tint(grid, YEL, place(bat_fit(760, 110), W, H, W // 2, H // 2))
ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(ov)
for x in range(0, W, 48): d.line([(x, 0), (x, H)], fill=YEL + (70,))
for y in range(0, H, 48): d.line([(0, y), (W, y)], fill=YEL + (70,))
for x in range(0, W, 240): d.line([(x, 0), (x, H)], fill=YEL + (120,), width=2)
for y in range(0, H, 240): d.line([(0, y), (W, y)], fill=YEL + (120,), width=2)
rcx, rcy = W - 60, H - 60
for rr in range(180, 1100, 150):
    d.ellipse([rcx - rr, rcy - rr, rcx + rr, rcy + rr], outline=YEL + (110,), width=3)
d.pieslice([rcx - 1100, rcy - 1100, rcx + 1100, rcy + 1100], 200, 214, fill=YEL + (55,))
L = 70
for (x0, y0, sx, sy) in [(24, 24, 1, 1), (W - 24, 24, -1, 1), (24, H - 24, 1, -1), (W - 24, H - 24, -1, -1)]:
    d.line([(x0, y0), (x0 + sx * L, y0)], fill=YEL + (230,), width=4)
    d.line([(x0, y0), (x0, y0 + sy * L)], fill=YEL + (230,), width=4)
for _ in range(40):
    x = random.randint(60, W - 60); y = random.randint(60, H - 60)
    d.line([(x, y), (x + random.randint(10, 40), y)], fill=YEL + (random.randint(150, 230),), width=3)
grid = Image.alpha_composite(grid.convert("RGBA"), ov).convert("RGB")
grid = scanlines(grid, 14)
grid.save(os.path.join(OUT, "grid.png"))

# ---------- svgs ----------
pts = " ".join(f"{x*VW:.1f},{y*VH:.1f}" for x, y in BAT)
with open(os.path.join(OUT, "bat.svg"), "w") as f:
    f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VW} {VH}" width="{VW}" height="{VH}"><polygon points="{pts}" fill="currentColor"/></svg>\n')
with open(os.path.join(OUT, "bat-icon.svg"), "w") as f:
    f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VW} {VH}" width="{VW}" height="{VH}"><polygon points="{pts}" fill="#f5c518"/></svg>\n')
shutil.copy(os.path.expanduser("~/.config/herdr-app/mods/traveler-chrome/settings.svg"), os.path.join(OUT, "settings.svg"))
print("ok aspect", round(ASPECT, 3))
