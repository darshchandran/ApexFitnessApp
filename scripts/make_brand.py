"""Generate APEX brand assets (SVG variants + app icon / splash / favicon PNGs).

Geometry mirrors src/ui/Brand.tsx — change both together.
Run from the repo root:  python scripts/make_brand.py   (needs Pillow + numpy)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "assets" / "images"
BRAND = ROOT / "assets" / "brand"
FONT = ROOT / "node_modules" / "@expo-google-fonts" / "inter" / "500Medium" / "Inter_500Medium.ttf"

BG = (10, 10, 11)
TEXT = (244, 244, 245)
MUTED = (168, 168, 176)

# mark, in a 128 x 100 box
UPPER = [(64, 0), (128, 100), (101, 100), (62.6, 40), (30.7, 52)]
FACET = [(64, 0), (30.7, 52), (62.6, 40)]
LOWER = [(26.9, 57.9), (62.5, 44.5), (24, 100), (0, 100)]
METAL = [(0.0, (255, 255, 255)), (0.38, (228, 228, 232)), (0.72, (162, 162, 169)), (1.0, (108, 108, 115))]
SS = 4  # supersampling


def metal(size):
    """Gradient image across the mark box, top-right (light) → bottom-left (dark)."""
    w, h = size
    ys, xs = np.mgrid[0:h, 0:w]
    ux, uy = xs / w * 128, ys / h * 100
    a, b = np.array([110.0, 0.0]), np.array([10.0, 100.0])
    d = b - a
    t = np.clip(((ux - a[0]) * d[0] + (uy - a[1]) * d[1]) / (d @ d), 0, 1)
    out = np.zeros((h, w, 3))
    for (t0, c0), (t1, c1) in zip(METAL, METAL[1:]):
        m = (t >= t0) & (t <= t1)
        k = ((t - t0) / (t1 - t0))[m][:, None]
        out[m] = np.array(c0) * (1 - k) + np.array(c1) * k
    return Image.fromarray(out.astype(np.uint8), "RGB")


def draw_mark(canvas, x, y, height, style="metal"):
    """Paste the mark onto an RGBA canvas at (x, y) with the given height (px)."""
    s = height / 100 * SS
    w, h = int(128 * s), int(100 * s)
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    for poly in (UPPER, LOWER):
        d.polygon([(px * s, py * s) for px, py in poly], fill=255)
    if style == "metal":
        fill = metal((w, h))
        shade = Image.new("L", (w, h), 0)
        ImageDraw.Draw(shade).polygon([(px * s, py * s) for px, py in FACET], fill=51)  # 20% black
        fill = Image.composite(Image.new("RGB", (w, h), (0, 0, 0)), fill, shade)
    else:
        fill = Image.new("RGB", (w, h), style)
    layer = Image.new("RGBA", (w, h))
    layer.paste(fill, (0, 0), mask)
    layer = layer.resize((int(w / SS), int(h / SS)), Image.LANCZOS)
    canvas.alpha_composite(layer, (int(x), int(y)))
    return layer.size


def offset_polyline(pts, half):
    """Thick open polyline with miter joins and butt caps, as a polygon."""
    pts = [np.array(p, float) for p in pts]
    normals = []
    for p, q in zip(pts, pts[1:]):
        v = (q - p) / np.linalg.norm(q - p)
        normals.append(np.array([-v[1], v[0]]))

    def side(sign):
        out = [pts[0] + sign * half * normals[0]]
        for i in range(1, len(pts) - 1):
            n = normals[i - 1] + normals[i]
            n /= np.linalg.norm(n)
            out.append(pts[i] + sign * n * half / max(0.2, n @ normals[i]))
        out.append(pts[-1] + sign * half * normals[-1])
        return out

    return side(1) + side(-1)[::-1]


def draw_wordmark(canvas, x, y, width, color):
    """Λ P Ξ X on a 170 x 30 box."""
    s = width / 170 * SS
    w, h = int(170 * s), int(30 * s)
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    half = 1.6
    P = lambda pts: [(px * s, py * s) for px, py in pts]
    d.polygon(P(offset_polyline([(1.5, 27), (14.5, 3), (27.5, 27)], half)), fill=255)
    for a, b in [((52, 27), (52, 3)), ((52, 3), (66, 3)), ((52, 19), (66, 19)),
                 ((94, 4.5), (120, 4.5)), ((94, 15), (116, 15)), ((94, 25.5), (120, 25.5)),
                 ((142, 3), (168, 27)), ((168, 3), (142, 27))]:
        d.polygon(P(offset_polyline([a, b], half)), fill=255)
    # P bowl: half-ring centred (66, 11), r = 8
    r_out, r_in = (8 + half) * s, (8 - half) * s
    cx, cy = 66 * s, 11 * s
    ring = Image.new("L", (w, h), 0)
    rd = ImageDraw.Draw(ring)
    rd.ellipse((cx - r_out, cy - r_out, cx + r_out, cy + r_out), fill=255)
    rd.ellipse((cx - r_in, cy - r_in, cx + r_in, cy + r_in), fill=0)
    rd.rectangle((0, 0, cx, h), fill=0)
    mask = Image.fromarray(np.maximum(np.array(mask), np.array(ring)))
    layer = Image.new("RGBA", (w, h), color + (0,))
    layer.putalpha(mask)
    layer = layer.resize((int(w / SS), int(h / SS)), Image.LANCZOS)
    canvas.alpha_composite(layer, (int(x), int(y)))
    return layer.size


def draw_tagline(canvas, cx, y, size, color, text="TRAIN · ADAPT · PERFORM", tracking=0.38):
    font = ImageFont.truetype(str(FONT), size)
    d = ImageDraw.Draw(canvas)
    widths = [d.textlength(ch, font=font) for ch in text]
    total = sum(widths) + tracking * size * (len(text) - 1)
    x = cx - total / 2
    for ch, cw in zip(text, widths):
        d.text((x, y), ch, font=font, fill=color + (255,))
        x += cw + tracking * size


def stacked(width, mark_h, bg=None):
    word_w = mark_h * 1.9
    h = int(mark_h * (1 + 0.28) + word_w * 30 / 170 + mark_h * 0.22 + mark_h * 0.16)
    img = Image.new("RGBA", (width, h), (bg + (255,)) if bg else (0, 0, 0, 0))
    draw_mark(img, (width - mark_h * 1.28) / 2, 0, mark_h)
    wy = mark_h * 1.28
    draw_wordmark(img, (width - word_w) / 2, wy, word_w, TEXT)
    draw_tagline(img, width / 2, wy + word_w * 30 / 170 + mark_h * 0.22, int(mark_h * 0.12), MUTED)
    return img


def png_assets():
    IMG.mkdir(parents=True, exist_ok=True)
    # iOS / store icon: full-bleed dark square, platform applies the mask
    icon = Image.new("RGBA", (1024, 1024), BG + (255,))
    mh = 1024 * 0.47
    draw_mark(icon, (1024 - mh * 1.28) / 2, (1024 - mh) / 2 + 12, mh)
    icon.convert("RGB").save(IMG / "icon.png")
    # Android adaptive foreground: keep inside the 66% safe zone
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    mh = 1024 * 0.3
    draw_mark(fg, (1024 - mh * 1.28) / 2, (1024 - mh) / 2 + 8, mh)
    fg.save(IMG / "android-icon-foreground.png")
    mono = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    draw_mark(mono, (1024 - mh * 1.28) / 2, (1024 - mh) / 2 + 8, mh, style=(255, 255, 255))
    mono.save(IMG / "android-icon-monochrome.png")
    stacked(880, 300).save(IMG / "splash-icon.png")
    fav = Image.new("RGBA", (192, 192), (0, 0, 0, 0))
    ImageDraw.Draw(fav).rounded_rectangle((0, 0, 191, 191), radius=40, fill=BG + (255,))
    mh = 192 * 0.44
    draw_mark(fav, (192 - mh * 1.28) / 2, (192 - mh) / 2 + 3, mh)
    fav.resize((48, 48), Image.LANCZOS).save(IMG / "favicon.png")
    # preview sheet of the lockups (handy for review, not used by the app)
    sheet = Image.new("RGBA", (1200, 560), BG + (255,))
    sheet.alpha_composite(stacked(560, 220), (20, 60))
    draw_mark(sheet, 640, 210, 120)
    draw_wordmark(sheet, 820, 228, 330, TEXT)
    draw_tagline(sheet, 985, 300, 17, MUTED)
    sheet.convert("RGB").save(BRAND / "apex-lockups-preview.png")


# ---------- SVG ----------

def path(poly):
    return "M" + "L".join(f"{x:g} {y:g}" for x, y in poly) + "Z"


WORD = "M1.5 27L14.5 3L27.5 27M52 27V3H66a8 8 0 0 1 0 16H52M94 4.5H120M94 15H116M94 25.5H120M142 3L168 27M168 3L142 27"
GRAD = ('<defs><linearGradient id="m" x1="110" y1="0" x2="10" y2="100" gradientUnits="userSpaceOnUse">'
        + "".join(f'<stop offset="{t}" stop-color="#{r:02X}{g:02X}{b:02X}"/>' for t, (r, g, b) in METAL)
        + "</linearGradient></defs>")


def mark_svg(fill, metal_shade=False):
    shade = f'<path d="{path(FACET)}" fill="#000" opacity="0.2"/>' if metal_shade else ""
    return f'<path d="{path(UPPER)}" fill="{fill}"/>{shade}<path d="{path(LOWER)}" fill="{fill}"/>'


def svg(w, h, body, bg=None):
    rect = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{rect}{body}</svg>\n'


def svg_assets():
    BRAND.mkdir(parents=True, exist_ok=True)
    tag = lambda x, y, size, fill, anchor="middle": (
        f'<text x="{x}" y="{y}" fill="{fill}" font-family="Inter, Helvetica, Arial, sans-serif" font-weight="500" '
        f'font-size="{size}" letter-spacing="{size * 0.38:g}" text-anchor="{anchor}">TRAIN · ADAPT · PERFORM</text>')
    word = lambda tx, ty, sc, color: f'<path transform="translate({tx} {ty}) scale({sc})" d="{WORD}" stroke="{color}" stroke-width="3.2" fill="none"/>'
    files = {
        "apex-mark.svg": svg(128, 100, GRAD + mark_svg("url(#m)", True)),
        "apex-mark-light.svg": svg(128, 100, mark_svg("#F4F4F5")),
        "apex-mark-dark.svg": svg(128, 100, mark_svg("#0A0A0B")),
        "apex-icon.svg": svg(1024, 1024, f'<rect width="1024" height="1024" rx="224" fill="#0A0A0B"/>{GRAD}'
                             f'<g transform="translate(237 297) scale(4.3)">{mark_svg("url(#m)", True)}</g>'),
        "apex-lockup-horizontal.svg": svg(560, 140, GRAD + f'<g transform="translate(20 20)">{mark_svg("url(#m)", True)}</g>'
                                          + word(184, 42, 1.95, "#F4F4F5") + tag(184, 120, 12, "#A8A8B0", "start"), bg="#0A0A0B"),
        "apex-lockup-horizontal-dark-on-light.svg": svg(560, 140, f'<g transform="translate(20 20)">{mark_svg("#0A0A0B")}</g>'
                                                         + word(184, 42, 1.95, "#0A0A0B") + tag(184, 120, 12, "#55555C", "start"), bg="#FFFFFF"),
        "apex-lockup-stacked.svg": svg(400, 330, GRAD + f'<g transform="translate(136 30)">{mark_svg("url(#m)", True)}</g>'
                                       + word(100, 170, 1.18, "#F4F4F5") + tag(200, 250, 12, "#A8A8B0"), bg="#0A0A0B"),
    }
    for name, content in files.items():
        (BRAND / name).write_text(content, encoding="utf-8")


if __name__ == "__main__":
    svg_assets()
    png_assets()
    print("brand assets written to", BRAND, "and", IMG)
