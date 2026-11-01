#!/usr/bin/env python3
"""Build a static photo-album comparison page from the contributor-photo fixture.

The page presents the fixed synthetic fixture's two diagrams and two statements
as a photo album would: full images, captions, attribution and unknown time. It
shows no model answer, proposal outcome or reconstruction.
Python 3 standard library only; no model or network is used.
"""
import argparse
import base64
import hashlib
import html
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys


HERE = Path(__file__).resolve().parent
# SHA-256 of the fixture.json written by generate_contribution_photo.py with the
# pinned Pillow. It lists both PNG hashes, so it pins the exact images too.
FIXTURE_SHA256 = "c1af8c95acb33caa095602a3db3480be75bb0dcde878666553b2d6ad66392aa4"
GENERATOR = "app/demo/generate_contribution_photo.py"
TURN_INPUT = "Turn the photographed side of this counter toward the window."
CONTRIBUTION = (
    "SYNTHETIC DEMONSTRATION. In this fictional recollection the counter was farther left. "
    "The generated reference is an illustration, not a historical photo or measured position. "
    "The time is unknown."
)
CONTRIBUTOR = "Synthetic reference contributor"
UNKNOWNS = [
    "Time: unknown for both images. File dates are not capture dates.",
    "Both images are procedural synthetic diagrams, not photographs of a real place.",
    "Neither image is verified history. The 80-pixel drawing shift is not a measured movement.",
    "Building this album makes no model call and shows no model answer or proposal outcome.",
]
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def read_regular(path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"{path.name} is not a regular file")
    return path.read_bytes()


def png_size(data):
    if data[:8] != PNG_SIGNATURE or data[12:16] != b"IHDR":
        raise ValueError("not a PNG file")
    return list(struct.unpack(">II", data[16:24]))


def load_inputs(input_dir):
    fixture_bytes = read_regular(input_dir / "fixture.json")
    if hashlib.sha256(fixture_bytes).hexdigest() != FIXTURE_SHA256:
        raise ValueError("fixture.json differs from the frozen generator output")
    fixture = json.loads(fixture_bytes)
    room_a = next(item for item in json.loads((HERE / "two-object-cases.json").read_text())["inputs"] if item["id"] == "A")
    images = {}
    for entry in fixture["inputs"]:
        data = read_regular(input_dir / entry["file"])
        if hashlib.sha256(data).hexdigest() != entry["sha256"] or png_size(data) != fixture["imageSize"]:
            raise ValueError(f"{entry['file']} differs from fixture.json")
        images[entry["file"]] = data
    if hashlib.sha256(images["baseline.png"]).hexdigest() != room_a["sha256"]:
        raise ValueError("baseline.png differs from frozen room A")
    return fixture, images


def figure(name, data, size, heading, attribution, statement_label, statement):
    uri = "data:image/png;base64," + base64.b64encode(data).decode()
    return f"""<figure>
<h2>{html.escape(heading)}</h2>
<img src="{uri}" width="{size[0]}" height="{size[1]}" alt="{html.escape(heading)}: procedural synthetic diagram">
<figcaption>
<p><strong>{html.escape(statement_label)}</strong></p>
<blockquote>{html.escape(statement)}</blockquote>
<p>{html.escape(attribution)}</p>
<p>Time: unknown. File: {html.escape(name)}, {len(data)} bytes, SHA-256 <code>{hashlib.sha256(data).hexdigest()}</code>.</p>
</figcaption>
</figure>"""


def build(fixture, images):
    size = fixture["imageSize"]
    figures = [
        figure("baseline.png", images["baseline.png"], size, "Place image",
               f"Image: procedural synthetic diagram (room A), drawn by {GENERATOR}. Not a photograph.",
               "Synthetic proposed-turn input. A scripted test sentence, not a person's request or memory:",
               TURN_INPUT),
        figure("counter-left.png", images["counter-left.png"], size, "Contributed reference",
               f"Provider: {CONTRIBUTOR}, a synthetic contributor account, not a real person. Image: procedural "
               f"synthetic diagram drawn by {GENERATOR} with the counter {abs(fixture['counterShiftPixels'][0])} "
               "pixels left; its drawn notice label also differs.",
               f"Synthetic contribution from {CONTRIBUTOR}:", CONTRIBUTION),
    ]
    unknowns = "\n".join(f"<li>{html.escape(line)}</li>" for line in UNKNOWNS)
    source = html.escape(json.dumps(fixture, indent=2))
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Synthetic album comparison</title>
<style>
body {{ margin: 0 auto; padding: 16px; max-width: 2160px; font: 16px/1.5 system-ui, sans-serif; background: #fff; color: #111; }}
img {{ display: block; max-width: 100%; height: auto; border: 1px solid #888; }}
.album {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr)); gap: 24px; align-items: start; }}
figure {{ margin: 0 0 32px; min-width: 0; }}
blockquote {{ margin: 8px 0; padding-left: 12px; border-left: 4px solid #888; }}
pre {{ white-space: pre-wrap; overflow-wrap: anywhere; }}
code {{ overflow-wrap: anywhere; }}
</style>
</head>
<body>
<h1>Synthetic album comparison</h1>
<p><strong>SYNTHETIC DEMONSTRATION. Procedurally generated diagrams and fictional statements; no real place, person or history.</strong></p>
<div class="album">
{figures[0]}
{figures[1]}
</div>
<h2>Unknowns and limits</h2>
<ul>
{unknowns}
</ul>
<h2>Source inputs</h2>
<p>Generator: {html.escape(GENERATOR)}. fixture.json SHA-256 <code>{FIXTURE_SHA256}</code>:</p>
<pre>{source}</pre>
</body>
</html>
"""


def write_new(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build a static album comparison page; no inference.")
    parser.add_argument("--input-dir", type=Path, default=HERE / "generated" / "contributor-photo")
    parser.add_argument("--output-dir", type=Path, default=HERE / "generated" / "album-comparison")
    args = parser.parse_args(argv)
    if os.path.lexists(args.output_dir):
        print("error: refusing to use an existing output directory", file=sys.stderr)
        return 2
    try:
        fixture, images = load_inputs(args.input_dir)
    except (OSError, ValueError, KeyError, StopIteration) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    page = build(fixture, images).encode()
    os.mkdir(args.output_dir, 0o700)
    for name, data in images.items():
        write_new(args.output_dir / name, data)
    write_new(args.output_dir / "album.html", page)
    # Read back so a short write or altered copy fails instead of being shown.
    written = (args.output_dir / "album.html").read_bytes()
    embedded = [base64.b64decode(value) for value in re.findall(rb"data:image/png;base64,([A-Za-z0-9+/=]+)", written)]
    copies = [(args.output_dir / name).read_bytes() for name in images]
    if written != page or embedded != list(images.values()) or copies != list(images.values()):
        print("error: written output differs from the verified inputs", file=sys.stderr)
        return 1
    print(f"wrote {args.output_dir / 'album.html'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
