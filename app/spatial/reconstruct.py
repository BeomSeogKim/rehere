#!/usr/bin/env python3
"""Reconstruct editable visible surfaces from one local JPEG or PNG photograph.

Depth Anything V2 Small proposes relative depth and SAM2 Tiny proposes a mask
inside a caller-validated box. Outputs are model proposals, not confirmed
observations. Models load only from the local Hugging Face cache.
"""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import time
import unicodedata
import uuid
import warnings


DEPTH_MODEL = {"id": "depth-anything/Depth-Anything-V2-Small-hf", "revision": "5426e4f0f36572d16453bbda7a8389317b1bef99", "license": "Apache-2.0"}
MASK_MODEL = {"id": "facebook/sam2.1-hiera-tiny", "revision": "de431c4043854a71d8101e17995dfe596bf101a5", "license": "Apache-2.0"}
MAX_PIXELS = 32_000_000
GRID_WIDTH = 256
MAX_GRID_CELLS = 262_144
NEAR, FAR = 2.0, 5.0
MAX_MASK_COVERAGE = 0.6
MAX_TRIANGLE_DEPTH_SPAN = 0.35
# Two-object scenes (schema_version 2). Region values: -1 void (ambiguous mask
# overlap, never drawn), 0 background, 1 and 2 the objects in request order.
OBJECT_IDS = ("object-1", "object-2")
LABEL_UNITS = 80
MAX_OVERLAP_RATIO = 0.01
OBJECT_COVERAGE_RANGE = (0.01, 0.5)
MAX_COMBINED_COVERAGE = 0.6
MIN_REGION_TRIANGLES = 32
VOID = -1
MASK_LEVELS = {VOID: 63, 0: 0, 1: 127, 2: 255}
OUTPUT_NAMES = ("texture.jpg", "depth-preview.png", "mask.png", "mask-overlay.jpg", "surface.json", "summary.json")

EXIT_INPUT, EXIT_UNAVAILABLE, EXIT_REJECTED, EXIT_WRITE = 2, 3, 4, 5


class InputError(Exception):
    exit_code = EXIT_INPUT


class UnavailableError(Exception):
    exit_code = EXIT_UNAVAILABLE


class ProposalRejected(Exception):
    exit_code = EXIT_REJECTED


class WriteError(Exception):
    exit_code = EXIT_WRITE


def _finite_float(text):
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}") from None
    if not math.isfinite(value):
        raise argparse.ArgumentTypeError(f"not finite: {text!r}")
    return value


def _source_id(text):
    try:
        return str(uuid.UUID(text))
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a UUID: {text!r}") from None


def _objects(text):
    """Parses --objects: exactly two {label, box} entries in request order."""
    try:
        value = json.loads(text)
    except ValueError:
        raise argparse.ArgumentTypeError("objects must be JSON") from None
    if not isinstance(value, list) or len(value) != len(OBJECT_IDS):
        raise argparse.ArgumentTypeError("objects must list exactly two objects")
    objects = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"label", "box"}:
            raise argparse.ArgumentTypeError("each object needs exactly a label and a box")
        label, box = item["label"], item["box"]
        # Labels arrive trimmed by the server and are returned unchanged.
        if (not isinstance(label, str) or not label or label != label.strip() or len(label.encode("utf-16-le")) // 2 > LABEL_UNITS
                or any(unicodedata.category(char) == "Cc" for char in label)):
            raise argparse.ArgumentTypeError("each label must be trimmed, non-blank plain text of at most 80 characters")
        if (not isinstance(box, list) or len(box) != 4
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in box)):
            raise argparse.ArgumentTypeError("each box must be four finite numbers")
        objects.append({"label": label, "box": [float(v) for v in box]})
    if objects[0]["label"].lower() == objects[1]["label"].lower():
        raise argparse.ArgumentTypeError("the two objects need distinct labels")
    return objects


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Reconstruct visible surfaces from one local JPEG or PNG photograph.")
    parser.add_argument("--image", required=True, type=Path, help="local JPEG or PNG file")
    parser.add_argument("--output", required=True, type=Path, help="empty or absent output directory")
    parser.add_argument("--source-id", required=True, type=_source_id, help="caller-assigned source UUID")
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--objects", type=_objects, help='JSON: [{"label": ..., "box": [x1, y1, x2, y2]}, two entries]')
    selection.add_argument("--box", nargs=4, type=_finite_float, metavar=("X1", "Y1", "X2", "Y2"),
                        help="object box in pixels of the decoded image before any EXIF rotation")
    return parser.parse_args(argv)


def validate_box(box, width, height):
    x1, y1, x2, y2 = box
    if not all(math.isfinite(value) for value in box):
        raise InputError("box coordinates must be finite")
    if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
        raise InputError(f"box must satisfy 0 <= x1 < x2 <= {width} and 0 <= y1 < y2 <= {height}")
    return [x1, y1, x2, y2]


def grid_size(width, height):
    grid_height = round(GRID_WIDTH * height / width)
    if grid_height < 2 or GRID_WIDTH * grid_height > MAX_GRID_CELLS:
        raise InputError("image aspect ratio is outside the supported surface grid (height/width between 1/128 and 4)")
    return GRID_WIDTH, grid_height


def decode_image(data):
    """Decode JPEG or PNG bytes without applying EXIF orientation."""
    from PIL import Image, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data), formats=("JPEG", "PNG"))
            width, height = image.size
            if width * height > MAX_PIXELS:
                raise InputError(f"image has {width * height} pixels; the limit is {MAX_PIXELS}")
            image.load()
    except InputError:
        raise
    except UnidentifiedImageError:
        raise InputError("image must be a JPEG or PNG file") from None
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise InputError(f"image exceeds the {MAX_PIXELS}-pixel limit") from None
    except (OSError, SyntaxError, ValueError) as error:
        raise InputError(f"image could not be decoded: {error}") from None
    orientation = image.getexif().get(0x0112)
    return image, image.format, orientation


def rgb_copy(image):
    """Return an RGB copy that carries no EXIF, ICC, or text metadata."""
    from PIL import Image
    import numpy as np

    return Image.fromarray(np.asarray(image.convert("RGB")))


def pseudo_depth(raw):
    """Map relative inverse depth to positive pseudo-depth in [NEAR, FAR]."""
    import numpy as np

    if not np.isfinite(raw).all() or float(raw.max() - raw.min()) <= 0:
        raise ProposalRejected("depth prediction is non-finite or constant; choose a different photograph")
    low, high = np.percentile(raw, [2, 98])
    if not high > low:
        raise ProposalRejected("depth prediction has no usable range; choose a different photograph")
    normalized = np.clip((raw - low) / (high - low), 0, 1)
    return 1 / (1 / FAR + normalized * (1 / NEAR - 1 / FAR)), normalized


def surviving_triangles(depth, grid_mask):
    """Count (background, foreground) triangles that photo-scene.mjs keeps.

    Mirrors its grid split into [a, c, b] and [b, c, d] per cell, where a is the
    top-left vertex and d the bottom-right: a triangle belongs to a region only
    when all three vertices do, and is dropped when its depth span exceeds
    MAX_TRIANGLE_DEPTH_SPAN.
    """
    import numpy as np

    def corners(array):
        return array[:-1, :-1], array[:-1, 1:], array[1:, :-1], array[1:, 1:]

    depth_corners, mask_corners = corners(depth), corners(grid_mask)
    counts = [0, 0]
    for vertices in ((0, 2, 1), (1, 2, 3)):
        values = np.stack([depth_corners[i] for i in vertices])
        flags = np.stack([mask_corners[i] for i in vertices])
        kept = values.max(axis=0) - values.min(axis=0) <= MAX_TRIANGLE_DEPTH_SPAN
        counts[0] += int((kept & ~flags.any(axis=0)).sum())
        counts[1] += int((kept & flags.all(axis=0)).sum())
    return tuple(counts)


def region_triangles(depth, regions):
    """Count triangles photo-scene.js keeps per region (void cells never count)."""
    import numpy as np

    def corners(array):
        return array[:-1, :-1], array[:-1, 1:], array[1:, :-1], array[1:, 1:]

    depth_corners, region_corners = corners(depth), corners(regions)
    counts = {region: 0 for region in range(len(OBJECT_IDS) + 1)}
    for vertices in ((0, 2, 1), (1, 2, 3)):
        values = np.stack([depth_corners[i] for i in vertices])
        labels = np.stack([region_corners[i] for i in vertices])
        kept = (values.max(axis=0) - values.min(axis=0) <= MAX_TRIANGLE_DEPTH_SPAN) & (labels.min(axis=0) == labels.max(axis=0))
        for region in counts:
            counts[region] += int((kept & (labels[0] == region)).sum())
    return counts


def combine_masks(first, second):
    """Full-resolution region image from two object masks.

    A small overlap becomes void: neither object nor background, so no surface
    is guessed under an ambiguous mask. A larger one is rejected.
    """
    import numpy as np

    areas = [int(first.sum()), int(second.sum())]
    if min(areas) == 0:
        raise ProposalRejected("an object mask is empty; choose different boxes")
    overlap = first & second
    pixels = int(overlap.sum())
    ratio = pixels / min(areas)
    if ratio > MAX_OVERLAP_RATIO:
        raise ProposalRejected(f"the two objects overlap by {ratio:.1%} of the smaller one; choose boxes that separate them")
    regions = np.zeros(first.shape, np.int8)
    regions[first] = 1
    regions[second] = 2
    regions[overlap] = VOID
    # The ratio is reported at full precision: rounding could make a real overlap read as zero.
    return regions, {"pixels": pixels, "ratio": ratio}


def mask_levels(regions):
    import numpy as np

    levels = np.zeros(regions.shape, np.uint8)
    for region, level in MASK_LEVELS.items():
        levels[regions == region] = level
    return levels


def grid_regions(levels, grid_width, grid_height):
    """Grid regions from the mask.png levels.

    Regions are sampled by nearest neighbour, which can skip a void pixel. So
    each full-resolution void pixel is also projected onto the grid, where
    vertex (i, j) sits at u = i / (width - 1), and every node of every cell its
    footprint touches becomes void: no drawn triangle can cover an excluded pixel.
    """
    from PIL import Image
    import numpy as np

    grid = np.asarray(Image.fromarray(levels).resize((grid_width, grid_height), Image.Resampling.NEAREST))
    regions = np.zeros(grid.shape, np.int8)
    for region, level in MASK_LEVELS.items():
        regions[grid == level] = region
    height, width = levels.shape
    ys, xs = np.nonzero(levels == MASK_LEVELS[VOID])
    if len(xs):
        x0 = np.clip(np.floor(xs / width * (grid_width - 1)), 0, grid_width - 1).astype(int)
        x1 = np.clip(np.ceil((xs + 1) / width * (grid_width - 1)), 0, grid_width - 1).astype(int)
        y0 = np.clip(np.floor(ys / height * (grid_height - 1)), 0, grid_height - 1).astype(int)
        y1 = np.clip(np.ceil((ys + 1) / height * (grid_height - 1)), 0, grid_height - 1).astype(int)
        for a, b, c, d in set(zip(x0.tolist(), x1.tolist(), y0.tolist(), y1.tolist())):
            regions[c:d + 1, a:b + 1] = VOID
    return regions


def check_regions(depth, regions):
    """Reject two-object proposals that are too small, too large or unreadable."""
    coverages = [float((regions == index + 1).mean()) for index in range(len(OBJECT_IDS))]
    low, high = OBJECT_COVERAGE_RANGE
    for index, coverage in enumerate(coverages):
        if not low <= coverage <= high:
            raise ProposalRejected(f"{OBJECT_IDS[index]} covers {coverage:.1%} of the image, outside {low:.0%}-{high:.0%}; choose a different box")
    if sum(coverages) > MAX_COMBINED_COVERAGE:
        raise ProposalRejected(f"the objects together cover {sum(coverages):.1%} of the image, over {MAX_COMBINED_COVERAGE:.0%}; choose smaller boxes")
    triangles = region_triangles(depth, regions)
    for region, count in triangles.items():
        if count < MIN_REGION_TRIANGLES:
            name = "the background" if region == 0 else OBJECT_IDS[region - 1]
            raise ProposalRejected(f"{name} keeps only {count} renderable triangles, fewer than {MIN_REGION_TRIANGLES}; choose different boxes")
    return coverages, triangles


def two_object_overlay(rgb, regions):
    """Tints each object, outlines it and paints void pixels white; no text."""
    from PIL import Image, ImageFilter
    import numpy as np

    base = np.asarray(rgb).astype(np.float32)
    out = base.copy()
    for region, tint, line in ((1, (30, 150, 220), (0, 60, 120)), (2, (235, 140, 30), (120, 50, 0))):
        inside = regions == region
        out[inside] = base[inside] * 0.55 + np.array(tint) * 0.45
        mask = Image.fromarray(inside.astype(np.uint8) * 255)
        edge = np.asarray(mask.filter(ImageFilter.MaxFilter(3))) != np.asarray(mask.filter(ImageFilter.MinFilter(3)))
        out[edge] = line
    out[regions == VOID] = (255, 255, 255)
    return Image.fromarray(out.clip(0, 255).astype(np.uint8))


def check_surface(depth, grid_mask):
    """Require a renderable foreground and a non-empty background mesh."""
    coverage = float(grid_mask.mean())
    if coverage > MAX_MASK_COVERAGE:
        raise ProposalRejected(f"mask covers {coverage:.1%} of the image, over {MAX_MASK_COVERAGE:.0%}; choose a different box")
    background, foreground = surviving_triangles(depth, grid_mask)
    if foreground < MIN_REGION_TRIANGLES:
        raise ProposalRejected(f"foreground keeps only {foreground} renderable triangles, fewer than {MIN_REGION_TRIANGLES}; choose a different box or photograph")
    if not background:
        raise ProposalRejected("depth and mask leave no renderable background surface; choose a different box or photograph")
    return coverage, (background, foreground)


def write_outputs(output, files):
    """Create each file exclusively; summary.json goes last as the completion marker."""
    try:
        output.mkdir(exist_ok=True)
        for name in OUTPUT_NAMES:
            with open(output / name, "xb") as handle:
                handle.write(files[name])
    except OSError as error:
        target = error.filename or output
        raise WriteError(f"cannot write {target}: {error.strerror or error}; outputs in {output} are incomplete, discard the directory and retry with an empty one") from None


def check_output(path):
    """Fail before inference unless outputs can be written to an empty directory."""
    try:
        if path.exists():
            if not path.is_dir() or any(path.iterdir()):
                raise InputError(f"output path is not an empty directory: {path}")
        elif not path.parent.is_dir():
            raise InputError(f"output parent directory does not exist: {path.parent}")
    except OSError as error:
        raise InputError(f"cannot inspect output path {path}: {error.strerror or error}") from None


def _load_models():
    # Set before importing transformers so no code path can reach the network.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
    try:
        import numpy  # noqa: F401
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation, Sam2Model, Sam2Processor
    except ImportError as error:
        raise UnavailableError(f"missing dependency ({error.name}); install requirements.txt into an isolated Python 3.12 environment") from None
    return torch, AutoImageProcessor, AutoModelForDepthEstimation, Sam2Model, Sam2Processor


def _pretrained(loader, spec, **kwargs):
    try:
        return loader.from_pretrained(spec["id"], revision=spec["revision"], token=False, local_files_only=True, trust_remote_code=False, **kwargs)
    except OSError:
        raise UnavailableError(f"cached weights for {spec['id']} at revision {spec['revision']} were not found; populate the Hugging Face cache as described in the README") from None


def _encode(image, fmt, **options):
    buffer = io.BytesIO()
    image.save(buffer, fmt, **options)
    return buffer.getvalue()


def reconstruct(image_path, output, source_id, box=None, objects=None):
    started = time.perf_counter()
    try:
        data = image_path.read_bytes()
    except OSError as error:
        raise InputError(f"cannot read image: {error.strerror}") from None
    try:
        from PIL import Image
        import numpy as np
    except ImportError as error:
        raise UnavailableError(f"missing dependency ({error.name}); install requirements.txt into an isolated Python 3.12 environment") from None
    image, source_format, orientation = decode_image(data)
    width, height = image.size
    if objects is None:
        box = validate_box(box, width, height)
    else:
        objects = [{"id": OBJECT_IDS[index], "label": item["label"], "box_xyxy": validate_box(item["box"], width, height)} for index, item in enumerate(objects)]
    grid_width, grid_height = grid_size(width, height)
    check_output(output)
    rgb = rgb_copy(image)
    del image

    torch, AutoImageProcessor, AutoModelForDepthEstimation, Sam2Model, Sam2Processor = _load_models()
    depth_device = "mps" if torch.backends.mps.is_available() else "cpu"
    processor = _pretrained(AutoImageProcessor, DEPTH_MODEL)
    model = _pretrained(AutoModelForDepthEstimation, DEPTH_MODEL, use_safetensors=True).to(depth_device).eval()
    inputs = processor(images=rgb, return_tensors="pt").to(depth_device)
    depth_started = time.perf_counter()
    with torch.inference_mode():
        disparity = model(**inputs).predicted_depth.cpu()
    if depth_device == "mps":
        torch.mps.synchronize()
    depth_seconds = time.perf_counter() - depth_started
    del model, inputs
    raw = torch.nn.functional.interpolate(disparity.unsqueeze(1), size=(grid_height, grid_width), mode="bicubic", align_corners=False)[0, 0].numpy()
    depth, normalized = pseudo_depth(raw)
    if objects is not None:
        return _reconstruct_objects(
            torch=torch, Sam2Model=Sam2Model, Sam2Processor=Sam2Processor, rgb=rgb, objects=objects, data=data, output=output,
            source_id=source_id, source_format=source_format, orientation=orientation, grid=(grid_width, grid_height),
            depth=depth, normalized=normalized, depth_device=depth_device, depth_seconds=depth_seconds, started=started,
        )

    mask_processor = _pretrained(Sam2Processor, MASK_MODEL)
    mask_model = _pretrained(Sam2Model, MASK_MODEL, use_safetensors=True).eval()
    mask_inputs = mask_processor(images=rgb, input_boxes=[[box]], return_tensors="pt")
    mask_started = time.perf_counter()
    with torch.inference_mode():
        result = mask_model(**mask_inputs, multimask_output=False)
    mask = mask_processor.post_process_masks(result.pred_masks.cpu(), mask_inputs["original_sizes"].cpu())[0][0, 0].numpy()
    mask_seconds = time.perf_counter() - mask_started
    del mask_model, mask_inputs
    mask_image = Image.fromarray(mask.astype("uint8") * 255)
    grid_mask = np.asarray(mask_image.resize((grid_width, grid_height), Image.Resampling.NEAREST)) > 0
    rounded_depth = np.round(depth, 6)
    coverage, (background_triangles, foreground_triangles) = check_surface(rounded_depth, grid_mask)

    texture = _encode(rgb, "JPEG", quality=92)
    overlay = Image.composite(Image.blend(rgb, Image.new("RGB", rgb.size, (30, 150, 220)), 0.45), rgb, mask_image)
    source_sha256 = hashlib.sha256(data).hexdigest()
    texture_sha256 = hashlib.sha256(texture).hexdigest()
    source = {
        "source_id": source_id,
        "sha256": source_sha256,
        "format": source_format,
        "image_size": [width, height],
        "texture": {"file": "texture.jpg", "sha256": texture_sha256, "derivation": "RGB re-encode without metadata"},
        "selected_object": {"id": "foreground", "box_xyxy": box, "selection_kind": "caller-supplied box; segmentation is a model proposal"},
    }
    surface = {
        "source": source,
        "width": grid_width,
        "height": grid_height,
        "depth": rounded_depth.ravel().tolist(),
        "foreground": grid_mask.astype("uint8").ravel().tolist(),
        "assumptions": {
            "horizontal_fov_degrees": 55,
            "near": NEAR,
            "far": FAR,
            "units": "arbitrary; not metric depth",
            "depth_kind": "model-inferred relative inverse depth mapped to bounded pseudo-depth",
            "unseen_geometry": "absent; no background inpainting or object back-face generation",
            "max_triangle_depth_span": MAX_TRIANGLE_DEPTH_SPAN,
        },
    }
    summary = {
        "source_id": source_id,
        "source_sha256": source_sha256,
        "texture_sha256": texture_sha256,
        "image_size": [width, height],
        "exif_orientation": orientation,
        "orientation_applied": False,
        "box_xyxy": box,
        "grid": [grid_width, grid_height],
        "mask_coverage": round(coverage, 5),
        "foreground_triangles": foreground_triangles,
        "background_triangles": background_triangles,
        "evidence": "model proposals; not human-confirmed observations",
        "depth_device": depth_device,
        "mask_device": "cpu",
        "depth_inference_seconds": round(depth_seconds, 3),
        "mask_inference_seconds": round(mask_seconds, 3),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "models": {"depth": DEPTH_MODEL, "mask": MASK_MODEL},
        "versions": {"torch": torch.__version__, "numpy": np.__version__},
    }
    files = {
        "texture.jpg": texture,
        "depth-preview.png": _encode(Image.fromarray((normalized * 255).astype("uint8")), "PNG"),
        "mask.png": _encode(mask_image, "PNG"),
        "mask-overlay.jpg": _encode(overlay, "JPEG", quality=90),
        "surface.json": (json.dumps(surface, separators=(",", ":")) + "\n").encode(),
        "summary.json": (json.dumps(summary, indent=2) + "\n").encode(),
    }
    write_outputs(output, files)
    return summary


def _assumptions():
    return {
        "horizontal_fov_degrees": 55,
        "near": NEAR,
        "far": FAR,
        "units": "arbitrary; not metric depth",
        "depth_kind": "model-inferred relative inverse depth mapped to bounded pseudo-depth",
        "unseen_geometry": "absent; no background inpainting or object back-face generation",
        "max_triangle_depth_span": MAX_TRIANGLE_DEPTH_SPAN,
    }


def _reconstruct_objects(*, torch, Sam2Model, Sam2Processor, rgb, objects, data, output, source_id, source_format, orientation,
                         grid, depth, normalized, depth_device, depth_seconds, started):
    """Second half of reconstruct() for two objects: one batched SAM2 pass."""
    from PIL import Image
    import numpy as np

    grid_width, grid_height = grid
    mask_processor = _pretrained(Sam2Processor, MASK_MODEL)
    mask_model = _pretrained(Sam2Model, MASK_MODEL, use_safetensors=True).eval()
    mask_inputs = mask_processor(images=rgb, input_boxes=[[item["box_xyxy"] for item in objects]], return_tensors="pt")
    mask_started = time.perf_counter()
    with torch.inference_mode():
        result = mask_model(**mask_inputs, multimask_output=False)
    masks = mask_processor.post_process_masks(result.pred_masks.cpu(), mask_inputs["original_sizes"].cpu())[0][:, 0].numpy().astype(bool)
    mask_seconds = time.perf_counter() - mask_started
    del mask_model, mask_inputs
    regions_full, overlap = combine_masks(masks[0], masks[1])
    levels = mask_levels(regions_full)
    regions = grid_regions(levels, grid_width, grid_height)
    rounded_depth = np.round(depth, 6)
    coverages, triangles = check_regions(rounded_depth, regions)

    texture = _encode(rgb, "JPEG", quality=92)
    source_sha256 = hashlib.sha256(data).hexdigest()
    texture_sha256 = hashlib.sha256(texture).hexdigest()
    width, height = rgb.size
    surface = {
        "schema_version": 2,
        "source": {
            "source_id": source_id,
            "sha256": source_sha256,
            "format": source_format,
            "image_size": [width, height],
            "texture": {"file": "texture.jpg", "sha256": texture_sha256, "derivation": "RGB re-encode without metadata"},
            "selected_objects": [dict(item) for item in objects],
        },
        "objects": [dict(item) for item in objects],
        "width": grid_width,
        "height": grid_height,
        "depth": rounded_depth.ravel().tolist(),
        "regions": regions.ravel().tolist(),
        "assumptions": _assumptions(),
    }
    summary = {
        "schema_version": 2,
        "source_id": source_id,
        "source_sha256": source_sha256,
        "texture_sha256": texture_sha256,
        "image_size": [width, height],
        "exif_orientation": orientation,
        "orientation_applied": False,
        "grid": [grid_width, grid_height],
        "objects": [{**item, "coverage": round(coverages[index], 5), "triangles": triangles[index + 1]} for index, item in enumerate(objects)],
        "background_triangles": triangles[0],
        "overlap": overlap,
        "mask_legend": {str(level): ("void" if region == VOID else "background" if region == 0 else OBJECT_IDS[region - 1]) for region, level in MASK_LEVELS.items()},
        "evidence": "model proposals; not human-confirmed observations",
        "depth_device": depth_device,
        "mask_device": "cpu",
        "depth_inference_seconds": round(depth_seconds, 3),
        "mask_inference_seconds": round(mask_seconds, 3),
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "models": {"depth": DEPTH_MODEL, "mask": MASK_MODEL},
        "versions": {"torch": torch.__version__, "numpy": np.__version__},
    }
    files = {
        "texture.jpg": texture,
        "depth-preview.png": _encode(Image.fromarray((normalized * 255).astype("uint8")), "PNG"),
        "mask.png": _encode(Image.fromarray(levels), "PNG"),
        "mask-overlay.jpg": _encode(two_object_overlay(rgb, regions_full), "JPEG", quality=90),
        "surface.json": (json.dumps(surface, separators=(",", ":"), ensure_ascii=False) + "\n").encode(),
        "summary.json": (json.dumps(summary, indent=2, ensure_ascii=False) + "\n").encode(),
    }
    write_outputs(output, files)
    return summary


def main(argv=None):
    args = parse_args(argv)
    try:
        summary = reconstruct(args.image, args.output, args.source_id, box=args.box, objects=args.objects)
    except (InputError, UnavailableError, ProposalRejected, WriteError) as error:
        print(f"error: {error}", file=sys.stderr)
        return error.exit_code
    if summary["exif_orientation"] not in (None, 1):
        print(f"warning: EXIF orientation {summary['exif_orientation']} was not applied; outputs follow stored pixel order", file=sys.stderr)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
