#!/usr/bin/env python3
"""Write a metadata-free JPEG thumbnail of a validated photograph to stdout.

The thumbnail keeps the stored pixel order (EXIF orientation is not applied),
so normalized coordinates on it match the reconstruction's box and grid. The
box is validated against the full image but the whole image is returned.
"""
import argparse
import io
import sys

import reconstruct


MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_LONG_EDGE = 1024
JPEG_QUALITIES = (85, 75, 65, 55, 45)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Write a metadata-free JPEG thumbnail of a local JPEG or PNG photograph to stdout.")
    parser.add_argument("--image", required=True, help="local JPEG or PNG file")
    parser.add_argument("--box", required=True, nargs=4, type=reconstruct._finite_float, metavar=("X1", "Y1", "X2", "Y2"),
                        help="object box in pixels of the image before any EXIF rotation")
    return parser.parse_args(argv)


def read_bounded(path):
    try:
        with open(path, "rb") as handle:
            data = handle.read(MAX_INPUT_BYTES + 1)
    except OSError as error:
        raise reconstruct.InputError(f"cannot read image: {error.strerror or 'read failed'}") from None
    if len(data) > MAX_INPUT_BYTES:
        raise reconstruct.InputError(f"image file exceeds {MAX_INPUT_BYTES} bytes")
    return data


def thumbnail_jpeg(data, box):
    """Return (jpeg_bytes, (width, height)) for a validated JPEG or PNG input."""
    try:
        from PIL import Image
    except ImportError:
        raise reconstruct.UnavailableError("missing dependency (PIL); install requirements.txt into an isolated Python 3.12 environment") from None
    image, _, _ = reconstruct.decode_image(data)
    reconstruct.validate_box(box, *image.size)
    rgb = reconstruct.rgb_copy(image)
    del image
    rgb.thumbnail((MAX_LONG_EDGE, MAX_LONG_EDGE), Image.Resampling.LANCZOS)
    for quality in JPEG_QUALITIES:
        buffer = io.BytesIO()
        rgb.save(buffer, "JPEG", quality=quality)
        if buffer.tell() <= MAX_OUTPUT_BYTES:
            return buffer.getvalue(), rgb.size
    raise reconstruct.ProposalRejected(f"thumbnail exceeds {MAX_OUTPUT_BYTES} bytes at the lowest quality")


def main(argv=None):
    args = parse_args(argv)
    try:
        jpeg, _ = thumbnail_jpeg(read_bounded(args.image), args.box)
    except (reconstruct.InputError, reconstruct.UnavailableError, reconstruct.ProposalRejected) as error:
        print(f"error: {error}", file=sys.stderr)
        return error.exit_code
    sys.stdout.buffer.write(jpeg)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
