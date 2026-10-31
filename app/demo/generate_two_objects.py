#!/usr/bin/env python3
"""Draw the two synthetic two-object room diagrams and verify their frozen hashes.

The drawings are constructed test inputs, not photographs or memories. Output
is checked against frozen hashes using the Pillow version pinned in
../spatial/requirements.txt. A mismatch is reported and the frozen data in
two-object-cases.json is never changed. No model or network call is made.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys

from PIL import Image, ImageDraw, __version__ as PILLOW_VERSION


HERE = Path(__file__).resolve().parent
CASES = HERE / "two-object-cases.json"
DEFAULT_OUTPUT = HERE / "generated" / "two-objects"


def draw_room(name, window, door):
    image = Image.new("RGB", (1024, 768), (230, 220, 202))
    draw = ImageDraw.Draw(image)
    draw.polygon([(0, 768), (170, 380), (850, 380), (1024, 768)], fill=(143, 122, 98))
    draw.polygon([(0, 0), (170, 380), (170, 768), (0, 768)], fill=(190, 174, 153))
    draw.polygon([(1024, 0), (850, 380), (850, 768), (1024, 768)], fill=(176, 194, 190))
    draw.rectangle(window, fill=(80, 146, 183), outline=(54, 55, 57), width=8)
    x1, y1, x2, y2 = window
    draw.line(((x1 + x2) // 2, y1 + 5, (x1 + x2) // 2, y2 - 5), fill=(236, 231, 212), width=7)
    draw.line((x1 + 5, (y1 + y2) // 2, x2 - 5, (y1 + y2) // 2), fill=(236, 231, 212), width=7)
    draw.rectangle(door, fill=(91, 76, 63), outline=(57, 43, 34), width=7)
    # Chair (object-1): back, seat and four legs.
    draw.rectangle((210, 390, 370, 545), fill=(46, 90, 135), outline=(32, 45, 54), width=6)
    draw.polygon([(210, 525), (370, 525), (407, 572), (240, 587)], fill=(65, 119, 168), outline=(32, 45, 54), width=5)
    for leg in [(220, 550, 237, 675), (355, 550, 372, 660), (247, 580, 264, 695), (386, 568, 403, 680)]:
        draw.rectangle(leg, fill=(43, 67, 88))
    # Counter (object-2): top and two visible sides.
    draw.polygon([(575, 495), (812, 454), (895, 517), (650, 566)], fill=(174, 100, 61), outline=(57, 41, 32), width=6)
    draw.polygon([(575, 495), (650, 566), (650, 677), (575, 602)], fill=(119, 66, 42))
    draw.polygon([(650, 566), (895, 517), (895, 630), (650, 677)], fill=(144, 77, 45), outline=(57, 41, 32), width=6)
    draw.text((30, 25), f"SYNTHETIC TWO-OBJECT TEST {name} - NO HISTORICAL CLAIM", fill=(20, 20, 20))
    return image


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write the synthetic two-object room PNGs and check their frozen SHA-256 values.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT, help="output directory; existing image files are never overwritten")
    args = parser.parse_args(argv)
    inputs = json.loads(CASES.read_text())["inputs"]
    targets = [args.output_dir / item["file"] for item in inputs]
    existing = [path for path in targets if path.exists()]
    if existing:
        print(f"error: refusing to overwrite {', '.join(str(path) for path in existing)}", file=sys.stderr)
        return 2
    args.output_dir.mkdir(parents=True, exist_ok=True)
    mismatched = []
    for item, path in zip(inputs, targets):
        buffer = io.BytesIO()
        draw_room(item["id"], tuple(item["windowBox"]), tuple(item["doorBox"])).save(buffer, "PNG")
        data = buffer.getvalue()
        with open(path, "xb") as handle:
            handle.write(data)
        digest = hashlib.sha256(data).hexdigest()
        print(f"{path.name} {digest}")
        if digest != item["sha256"]:
            mismatched.append(path.name)
    if mismatched:
        print(f"error: {', '.join(mismatched)} differ from the frozen hashes with Pillow {PILLOW_VERSION}; "
              "use the Pillow version pinned in app/spatial/requirements.txt. The frozen cases are unchanged.", file=sys.stderr)
        return 1
    print(f"Both rooms match their frozen hashes (Pillow {PILLOW_VERSION}). No model was called.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
