"""Build Overhull's geometric SVG, PNG, and Windows icon. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

BUILD = Path(__file__).resolve().parent.parent / "build"
BUILD.mkdir(exist_ok=True)
SIZE = 1024
SCALE = 4
STROKE = "#e6edf3"
STROKE_WIDTH = 25

# Three connected isometric modules represent Design, Implement, and Evaluate.
facets = [
    ([(12, 3), (17, 6), (12, 9), (7, 6)], "#58a6ff"),
    ([(7, 6), (12, 9), (12, 14), (7, 11)], "#161b22"),
    ([(12, 9), (17, 6), (17, 11), (12, 14)], "#21262d"),
    ([(7, 11), (12, 14), (7, 17), (2, 14)], "#30363d"),
    ([(2, 14), (7, 17), (7, 22), (2, 19)], "#161b22"),
    ([(7, 17), (12, 14), (12, 19), (7, 22)], "#21262d"),
    ([(17, 11), (22, 14), (17, 17), (12, 14)], "#30363d"),
    ([(12, 14), (17, 17), (17, 22), (12, 19)], "#161b22"),
    ([(17, 17), (22, 14), (22, 19), (17, 22)], "#21262d"),
]


def transform(point):
    return (152 + 30 * point[0], 137 + 30 * point[1])


polygons = [([transform(point) for point in points], color) for points, color in facets]
edges = sorted({tuple(sorted((points[index], points[(index + 1) % len(points)])))
                for points, _ in polygons for index in range(len(points))})

svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title description">',
    '  <title id="title">Overhull</title>',
    '  <desc id="description">Three connected isometric modules for design, implementation, and evaluation.</desc>',
    '  <rect x="48" y="48" width="928" height="928" rx="208" fill="#0d1117" stroke="#30363d" stroke-width="4"/>',
]
for points, color in polygons:
    svg.append(f'  <polygon points="{" ".join(f"{x},{y}" for x, y in points)}" fill="{color}"/>')
svg.append(f'  <g fill="none" stroke="{STROKE}" stroke-width="{STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">')
for (x1, y1), (x2, y2) in edges:
    svg.append(f'    <path d="M{x1} {y1}L{x2} {y2}"/>')
svg.extend(['  </g>', '</svg>', ''])
(BUILD / "icon.svg").write_text("\n".join(svg), encoding="utf-8")

image = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle(tuple(value * SCALE for value in (48, 48, 976, 976)), radius=208 * SCALE,
                       fill="#0d1117", outline="#30363d", width=4 * SCALE)
for points, color in polygons:
    draw.polygon([(x * SCALE, y * SCALE) for x, y in points], fill=color)
for start, end in edges:
    draw.line([(x * SCALE, y * SCALE) for x, y in (start, end)], fill=STROKE, width=STROKE_WIDTH * SCALE)
for x, y in {point for edge in edges for point in edge}:
    radius = STROKE_WIDTH * SCALE / 2
    draw.ellipse((x * SCALE - radius, y * SCALE - radius, x * SCALE + radius, y * SCALE + radius), fill=STROKE)
image = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
image.save(BUILD / "icon.png", optimize=True)
image.save(BUILD / "icon.ico", format="ICO", sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)])
print("Generated build/icon.svg, build/icon.png (1024px), and build/icon.ico (16–256px).")
