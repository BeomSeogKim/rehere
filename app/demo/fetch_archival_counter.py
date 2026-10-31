#!/usr/bin/env python3
"""Fetch one pinned public archival display JPEG; never runs a model."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


IMAGE_URL = "https://tile.loc.gov/storage-services/service/pnp/fsa/8c52000/8c52400/8c52415v.jpg"
CONTEXT_URL = "https://www.loc.gov/free-to-use/advertising-food/"
SHA256 = "6e108b8aee0a21ea523ba140146aaf7d70e9dbb798c0fb680bd531a2019f4819"
SIZE = 371_993


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).parent / "generated/archival-counter")
    args = parser.parse_args()
    if args.output_dir.exists():
        parser.error("the output directory already exists; choose a new directory")
    request = urllib.request.Request(IMAGE_URL, headers={"User-Agent": "Rehere archival demonstration fixture"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(2 * 1024 * 1024 + 1)
    except OSError:
        parser.error("the official image could not be downloaded; nothing was written")
    if len(data) != SIZE or hashlib.sha256(data).hexdigest() != SHA256:
        parser.error("the official image differs from the pinned file; nothing was written")
    manifest = {
        "file": "source.jpg", "type": "image/jpeg", "size": SIZE, "sha256": SHA256,
        "imageSize": [1024, 820], "source": IMAGE_URL, "reuseContext": CONTEXT_URL,
        "resource": "fsa.8c52415", "title": "General store interior. Moundville, Alabama",
        "creator": "Walker Evans", "collection": "Farm Security Administration",
        "catalogAttributedYear": 1936, "captureDay": None,
        "exampleBox": [12, 440, 240, 805],
        "selection": "Manually chosen visible wooden counter portion at the left frame edge, including its leg",
        "limits": "Official display derivative, not the preservation master. No personal recollection, second viewpoint, historical dimensions or present-day shop-loss claim. Any manual movement is hypothetical.",
    }
    args.output_dir.mkdir(parents=True, exist_ok=False)
    with (args.output_dir / "source.jpg").open("xb") as output:
        output.write(data)
    with (args.output_dir / "fixture.json").open("x", encoding="utf-8") as output:
        output.write(json.dumps(manifest, indent=2) + "\n")
    print(f"Saved the pinned display photograph and fixture.json in {args.output_dir}")


if __name__ == "__main__":
    main()
