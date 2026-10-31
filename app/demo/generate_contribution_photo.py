#!/usr/bin/env python3
"""Draw a synthetic leftward-counter reference for manual contribution review.

The diagram uses the same backdrop and chair as room A. Only its notice and
counter drawing change. Pixels do not establish scene units, camera calibration,
historical truth or a person's memory. No model or network is used.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys

from generate_two_objects import CASES, HERE, PILLOW_VERSION, draw_room


COUNTER_DX = -80


def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Draw a synthetic reference for the contributor-photo workflow; no inference.")
    parser.add_argument("--output-dir", type=Path, default=HERE / "generated" / "contributor-photo")
    args = parser.parse_args(argv)
    targets = [args.output_dir / name for name in ["baseline.png", "counter-left.png", "fixture.json"]]
    if any(target.exists() for target in targets):
        print("error: refusing to overwrite existing fixture output", file=sys.stderr)
        return 2
    base = next(item for item in json.loads(CASES.read_text())["inputs"] if item["id"] == "A")
    baseline = png_bytes(draw_room("A", tuple(base["windowBox"]), tuple(base["doorBox"])))
    if hashlib.sha256(baseline).hexdigest() != base["sha256"]:
        print(f"error: baseline differs from frozen room A with Pillow {PILLOW_VERSION}; use the pinned environment", file=sys.stderr)
        return 1
    reference = png_bytes(draw_room("C - COUNTER LEFT", tuple(base["windowBox"]), tuple(base["doorBox"]), counter_dx=COUNTER_DX))
    original_box = next(item["box"] for item in base["objects"] if item["label"] == "Counter")
    moved_box = [value + (COUNTER_DX if i % 2 == 0 else 0) for i, value in enumerate(original_box)]
    manifest = {
        "synthetic": True, "notPhotographicEvidence": True, "modelCalled": False,
        "imageSize": base["imageSize"], "counterShiftPixels": [COUNTER_DX, 0],
        "baselineCounterBox": original_box, "referenceCounterBox": moved_box,
        "inputs": [
            {"file": targets[0].name, "sha256": hashlib.sha256(baseline).hexdigest()},
            {"file": targets[1].name, "sha256": hashlib.sha256(reference).hexdigest()},
        ],
        "interpretation": "Owner chooses a qualitative leftward alternative; no pixel-to-scene-unit measurement.",
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for target, data in zip(targets, [baseline, reference, (json.dumps(manifest, indent=2) + "\n").encode()]):
        with open(target, "xb") as handle:
            handle.write(data)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
