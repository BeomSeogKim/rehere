#!/usr/bin/env python3
"""Regenerate a corrected outline from verified local assets, without inference."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys


LEVELS = {-1: 63, 0: 0, 1: 127, 2: 255}
OUTLINE = {"kind": "owner-corrected"}


class Rejected(Exception):
    pass


def triangle_counts(surface):
    width, height = surface["width"], surface["height"]
    depth, regions = surface["depth"], surface["regions"]
    span = surface["assumptions"]["max_triangle_depth_span"]
    counts = {0: 0, 1: 0, 2: 0}
    for y in range(height - 1):
        for x in range(width - 1):
            a = y * width + x
            for points in ((a, a + width, a + 1), (a + 1, a + width, a + width + 1)):
                region = regions[points[0]]
                if region not in counts or any(regions[i] != region for i in points):
                    continue
                values = [depth[i] for i in points]
                if max(values) - min(values) <= span:
                    counts[region] += 1
    return counts


def encode(image, kind, **options):
    out = io.BytesIO()
    image.save(out, kind, **options)
    return out.getvalue()


def corrected_files(input_dir, request):
    from PIL import Image, ImageChops, ImageFilter

    surface = json.loads((input_dir / "surface.json").read_bytes())
    previous = surface["regions"]
    regions, objects = request["regions"], request["objects"]
    target = 1 if request["targetId"] == "object-1" else 2
    if len(regions) != len(previous) or regions == previous:
        raise Rejected()
    for before, after in zip(previous, regions):
        allowed = {-1, target} if before == -1 else {0, target} if before in (0, target) else {before}
        if type(after) is not int or after not in allowed:
            raise Rejected()
    surface = {
        "schema_version": 2, "source": {**surface["source"], "selected_objects": objects},
        "objects": objects, "width": surface["width"], "height": surface["height"],
        "depth": surface["depth"], "regions": regions, "assumptions": surface["assumptions"], "outline": OUTLINE,
    }
    counts = triangle_counts(surface)
    coverage = [regions.count(r) / len(regions) for r in (1, 2)]
    if any(not 0.01 <= c <= 0.5 for c in coverage) or sum(coverage) > 0.6 or min(counts.values()) < 32:
        raise Rejected()

    size = tuple(surface["source"]["image_size"])
    if len(size) != 2 or min(size) < 1 or size[0] * size[1] > 32_000_000:
        raise Rejected()
    grid = Image.frombytes("L", (surface["width"], surface["height"]), bytes(LEVELS[r] for r in regions))
    mask = grid.resize(size, Image.Resampling.NEAREST)
    histogram = mask.histogram()
    void = histogram[LEVELS[-1]]
    smaller = min(histogram[LEVELS[r]] + void for r in (1, 2))
    ratio = void / smaller if smaller else 1
    if ratio > 0.01 or bool(void) != (-1 in regions):
        # Grid voids may be larger than the model's original full-size overlap.
        print(f"outline overlap rejected: void_pixels={void} smaller_mask_pixels={smaller} ratio={ratio}", file=sys.stderr)
        raise Rejected()

    texture = (input_dir / "texture.jpg").read_bytes()
    Image.MAX_IMAGE_PIXELS = 32_000_000
    with Image.open(io.BytesIO(texture), formats=("JPEG",)) as decoded:
        if decoded.size != size:
            raise Rejected()
        rgb = decoded.convert("RGB")
    overlay = rgb.copy()
    for region, tint, line in ((1, (30, 150, 220), (0, 60, 120)), (2, (235, 140, 30), (120, 50, 0))):
        selected = mask.point([255 if v == LEVELS[region] else 0 for v in range(256)])
        overlay.paste(Image.blend(rgb, Image.new("RGB", size, tint), 0.45), mask=selected)
        # Difference of dilation and erosion outlines both sides of the boundary.
        edge = ImageChops.difference(selected.filter(ImageFilter.MaxFilter(3)), selected.filter(ImageFilter.MinFilter(3)))
        overlay.paste(line, mask=edge)
    overlay.paste((255, 255, 255), mask=mask.point([255 if v == LEVELS[-1] else 0 for v in range(256)]))

    source = surface["source"]
    summary = {
        "schema_version": 2, "source_id": source["source_id"], "source_sha256": source["sha256"],
        "texture_sha256": hashlib.sha256(texture).hexdigest(), "image_size": list(size),
        "grid": [surface["width"], surface["height"]],
        "objects": [{**obj, "coverage": coverage[i], "triangles": counts[i + 1]} for i, obj in enumerate(objects)],
        "background_triangles": counts[0], "overlap": {"pixels": void, "ratio": ratio},
        "mask_legend": {str(level): ("void" if r == -1 else "background" if r == 0 else f"object-{r}") for r, level in LEVELS.items()},
        "outline": OUTLINE, "evidence": "Owner-corrected outline; depth remains a model estimate; unseen surfaces remain absent.",
    }
    return {
        "texture.jpg": texture, "depth-preview.png": (input_dir / "depth-preview.png").read_bytes(),
        "mask.png": encode(mask, "PNG"), "mask-overlay.jpg": encode(overlay, "JPEG", quality=90),
        "surface.json": (json.dumps(surface, separators=(",", ":"), ensure_ascii=False) + "\n").encode(),
        "summary.json": (json.dumps(summary, indent=2, ensure_ascii=False) + "\n").encode(),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        files = corrected_files(args.input, json.loads(args.request.read_bytes()))
        args.output.mkdir()
        for name, data in files.items():
            with (args.output / name).open("xb") as out:
                out.write(data)
    except ImportError:
        return 3
    except Rejected:
        return 4
    except (OSError, ValueError, KeyError, TypeError):
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main())
