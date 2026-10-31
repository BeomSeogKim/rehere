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
import uuid
import warnings


DEPTH_MODEL = {"id": "depth-anything/Depth-Anything-V2-Small-hf", "revision": "5426e4f0f36572d16453bbda7a8389317b1bef99", "license": "Apache-2.0"}
MASK_MODEL = {"id": "facebook/sam2.1-hiera-tiny", "revision": "de431c4043854a71d8101e17995dfe596bf101a5", "license": "Apache-2.0"}
MAX_PIXELS = 32_000_000
GRID_WIDTH = 256
MAX_GRID_CELLS = 262_144
NEAR, FAR = 2.0, 5.0
COVERAGE_RANGE = (0.01, 0.6)
MAX_TRIANGLE_DEPTH_SPAN = 0.35
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


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Reconstruct visible surfaces from one local JPEG or PNG photograph.")
    parser.add_argument("--image", required=True, type=Path, help="local JPEG or PNG file")
    parser.add_argument("--output", required=True, type=Path, help="empty or absent output directory")
    parser.add_argument("--source-id", required=True, type=_source_id, help="caller-assigned source UUID")
    parser.add_argument("--box", required=True, nargs=4, type=_finite_float, metavar=("X1", "Y1", "X2", "Y2"),
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


def check_surface(depth, grid_mask):
    """Reject proposals the scene builder cannot turn into two non-empty meshes."""
    coverage = float(grid_mask.mean())
    low, high = COVERAGE_RANGE
    if not low <= coverage <= high:
        raise ProposalRejected(f"mask covers {coverage:.1%} of the image, outside {low:.0%}-{high:.0%}; choose a different box")
    background, foreground = surviving_triangles(depth, grid_mask)
    if not background or not foreground:
        raise ProposalRejected("depth and mask leave no renderable foreground or background surface; choose a different box or photograph")
    return coverage


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


def reconstruct(image_path, output, source_id, box):
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
    box = validate_box(box, width, height)
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
    coverage = check_surface(rounded_depth, grid_mask)

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


def main(argv=None):
    args = parse_args(argv)
    try:
        summary = reconstruct(args.image, args.output, args.source_id, args.box)
    except (InputError, UnavailableError, ProposalRejected, WriteError) as error:
        print(f"error: {error}", file=sys.stderr)
        return error.exit_code
    if summary["exif_orientation"] not in (None, 1):
        print(f"warning: EXIF orientation {summary['exif_orientation']} was not applied; outputs follow stored pixel order", file=sys.stderr)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
