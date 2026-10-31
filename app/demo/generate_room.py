#!/usr/bin/env python3
"""Write a synthetic one-point-perspective room as SVG for relation-change tests.

The drawing is a technical fixture, not a photograph or a memory. It shows one
counter whose visible front is marked by a diagram convention, a window on the
left wall, and a door on the right wall. Region boxes are derived from the same
geometry and must match the frozen expectations file before anything is written.
"""
import argparse
import json
import math
from pathlib import Path
import sys


WIDTH, HEIGHT = 1024, 768
BACK = (312, 180, 712, 460)  # back wall rectangle: x1, y1, x2, y2
EXPECTATIONS = Path(__file__).with_name("expectations.json")


def left_wall(x, fraction):
    """Point on the left wall at canvas x, `fraction` of the wall height below its top edge."""
    top = BACK[1] * x / BACK[0]
    bottom = HEIGHT - (HEIGHT - BACK[3]) * x / BACK[0]
    return x, top + fraction * (bottom - top)


def right_wall(x, fraction):
    t = (WIDTH - x) / (WIDTH - BACK[2])
    top = BACK[1] * t
    bottom = HEIGHT - (HEIGHT - BACK[3]) * t
    return x, top + fraction * (bottom - top)


WINDOW = [left_wall(100, 0.28), left_wall(230, 0.28), left_wall(230, 0.58), left_wall(100, 0.58)]
DOOR = [right_wall(800, 0.3), right_wall(920, 0.3), right_wall(920, 1.0), right_wall(800, 1.0)]
COUNTER_FRONT = (392, 520, 632, 650)
COUNTER_TOP = [(422, 480), (602, 480), (632, 520), (392, 520)]


def bounding_box(points):
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return [math.floor(min(xs)), math.floor(min(ys)), math.ceil(max(xs)), math.ceil(max(ys))]


def counter_box():
    return bounding_box(COUNTER_TOP + [COUNTER_FRONT[:2], COUNTER_FRONT[2:]])


def derived_geometry():
    return {"object": counter_box(), "window": bounding_box(WINDOW), "door": bounding_box(DOOR)}


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def check_expectations(expectations):
    """Return a list of problems; an empty list means the fixture is consistent."""
    problems = []
    if expectations.get("image_size") != [WIDTH, HEIGHT]:
        problems.append("image_size must match the drawing")
    geometry = derived_geometry()
    boxes = {"object": expectations["object"]["box_xyxy"], **{name: region["box_xyxy"] for name, region in expectations["regions"].items()}}
    for name, box in boxes.items():
        if box != geometry.get(name):
            problems.append(f"{name} box {box} does not match drawn geometry {geometry.get(name)}")
        if not (len(box) == 4 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in box)
                and 0 <= box[0] < box[2] <= WIDTH and 0 <= box[1] < box[3] <= HEIGHT):
            problems.append(f"{name} box must be finite and inside the image")
    for name in expectations["regions"]:
        if overlaps(boxes[name], boxes["object"]):
            problems.append(f"{name} region must lie outside the object box")
    if overlaps(boxes["window"], boxes["door"]):
        problems.append("window and door regions must be separate")
    cases = {case["id"]: case for case in expectations["cases"]}
    window, door = cases.get("face-window"), cases.get("face-door")
    if not window or not door or window["text"].replace("window", "door") != door["text"]:
        problems.append("face-window and face-door statements must differ only by window/door")
    for case in expectations["cases"]:
        expected = case["expect"]
        if expected["action"] == "clarify" and expected.get("state_change") is not False:
            problems.append(f"{case['id']}: clarification must not change state")
        if expected["action"] == "face_anchor" and expected.get("anchor_region") not in expectations["regions"]:
            problems.append(f"{case['id']}: anchor region must be a frozen region")
    return problems


def polygon(points, **attributes):
    coords = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    extra = " ".join(f'{key.replace("_", "-")}="{value}"' for key, value in attributes.items())
    return f'<polygon points="{coords}" {extra}/>'


def text(x, y, content, size=18, **attributes):
    extra = " ".join(f'{key.replace("_", "-")}="{value}"' for key, value in attributes.items())
    return f'<text x="{x}" y="{y}" font-family="sans-serif" font-size="{size}" text-anchor="middle" {extra}>{content}</text>'


def render_svg():
    x1, y1, x2, y2 = BACK
    fx1, fy1, fx2, fy2 = COUNTER_FRONT
    centre = (fx1 + fx2) / 2
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">',
        "<title>SYNTHETIC test room: not a photograph or memory</title>",
        polygon([(0, 0), (WIDTH, 0), (x2, y1), (x1, y1)], fill="#e9e6df"),
        polygon([(0, 0), (x1, y1), (x1, y2), (0, HEIGHT)], fill="#cfd8c8"),
        polygon([(WIDTH, 0), (x2, y1), (x2, y2), (WIDTH, HEIGHT)], fill="#c8cfd8"),
        polygon([(x1, y1), (x2, y1), (x2, y2), (x1, y2)], fill="#dcdcd2"),
        polygon([(x1, y2), (x2, y2), (WIDTH, HEIGHT), (0, HEIGHT)], fill="#a8977f"),
        polygon(WINDOW, fill="#9fd3f2", stroke="#3d5566", stroke_width=6),
        polygon([left_wall(165, 0.28), left_wall(165, 0.58)], stroke="#3d5566", stroke_width=4, fill="none"),
        text(165, left_wall(165, 0.58)[1] + 30, "WINDOW", fill="#26343f"),
        polygon(DOOR, fill="#7a4e2d", stroke="#3b2414", stroke_width=6),
        f'<circle cx="{right_wall(900, 0.68)[0]:.1f}" cy="{right_wall(900, 0.68)[1]:.1f}" r="6" fill="#e3c26b"/>',
        text(860, right_wall(860, 0.3)[1] - 14, "DOOR", fill="#26343f"),
        polygon(COUNTER_TOP, fill="#d9b98c", stroke="#4a3520", stroke_width=3),
        polygon([(fx1, fy1), (fx2, fy1), (fx2, fy2), (fx1, fy2)], fill="#b5824f", stroke="#4a3520", stroke_width=3),
        polygon([(fx1, fy2 - 16), (fx2, fy2 - 16), (fx2, fy2), (fx1, fy2)], fill="#f2c230"),
        # Dot in a circle is the diagram convention for a direction toward the viewer.
        f'<circle cx="{centre}" cy="{fy1 + 68}" r="22" stroke="#f2c230" stroke-width="5" fill="none"/>',
        f'<circle cx="{centre}" cy="{fy1 + 68}" r="7" fill="#f2c230"/>',
        text(centre, fy1 + 30, "FRONT (faces viewer)", size=20, fill="#fff7dc", font_weight="bold"),
        text(centre, fy2 + 24, "COUNTER (front marked by diagram convention)", size=15, fill="#2b1d10"),
        f'<rect x="0" y="{HEIGHT - 40}" width="{WIDTH}" height="40" fill="#111"/>',
        text(WIDTH / 2, HEIGHT - 14, "SYNTHETIC TEST FIXTURE - not a photograph, memory, or historical record", size=17, fill="#fff"),
        text(WIDTH / 2, 28, "SYNTHETIC", size=20, fill="#555", font_weight="bold"),
        "</svg>",
    ]
    return "\n".join(parts) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write the synthetic relation-test room as an SVG file.")
    parser.add_argument("--output", required=True, type=Path, help="new SVG file path; an existing file is never overwritten")
    args = parser.parse_args(argv)
    problems = check_expectations(json.loads(EXPECTATIONS.read_text()))
    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        return 1
    try:
        with open(args.output, "x", encoding="utf-8") as handle:
            handle.write(render_svg())
    except OSError as error:
        print(f"error: cannot write output: {error.strerror or error}", file=sys.stderr)
        return 2
    print(json.dumps({"output": str(args.output), "image_size": [WIDTH, HEIGHT], **derived_geometry()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
