#!/usr/bin/env python3
"""Write a metadata-free inspection JPEG of one contributed photo to stdout.

Reads at most 20 MiB of JPEG or PNG bytes from stdin. The image is shown as
it would be displayed (EXIF orientation applied), copied as RGB pixels without
EXIF, XMP, ICC, text or comments, reduced to a long edge of at most 2048
pixels and re-encoded as a baseline JPEG of at most 2 MiB. Transparent and
partly transparent areas (alpha, palette transparency or a PNG tRNS colour key)
are composited onto white, as they would display on a white page, so hidden
colour under transparent pixels is never revealed. A 16-bit PNG with a tRNS
colour key is refused: the decoder reduces it to 8 bits but keeps the 16-bit
key, so the key cannot be applied reliably. Re-encoding changes
pixel values, colour may shift without the ICC profile, and visible people or
text remain: this is not anonymization. No model, network or file path is used.

Exit codes: 0 JPEG written; 2 invalid, empty, oversized or corrupt input;
3 Pillow or NumPy missing; 4 the output size cap cannot be met.
"""
import argparse
import io
import sys

import reconstruct


MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_LONG_EDGE = 2048
JPEG_QUALITIES = (90, 80, 70, 60, 50)
EXIT_OUTPUT = 4


class OutputTooLarge(Exception):
    exit_code = EXIT_OUTPUT


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_bit_depth(data):
    """Bit depth from a PNG header, or None for anything else."""
    if data.startswith(PNG_SIGNATURE) and len(data) >= 26 and data[12:16] == b"IHDR":
        return data[24]
    return None


def flatten_on_white(image):
    """Composites any transparency onto white; opaque images pass through unchanged."""
    from PIL import Image

    if image.mode not in ("RGBA", "LA", "La", "RGBa", "PA", "P") and "transparency" not in image.info:
        return image
    # convert('RGBA') applies per-pixel alpha, palette transparency and tRNS colour keys.
    rgba = image.convert("RGBA")
    return Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("RGB")


def prepare(data):
    """Returns (jpeg_bytes, (width, height)) for JPEG or PNG input bytes."""
    if not isinstance(data, (bytes, bytearray)) or len(data) == 0:
        raise reconstruct.InputError("the photo is empty")
    if len(data) > MAX_INPUT_BYTES:
        raise reconstruct.InputError(f"the photo exceeds {MAX_INPUT_BYTES} bytes")
    try:
        from PIL import Image, ImageOps
        import numpy  # noqa: F401  (rgb_copy needs it)
    except ImportError as error:
        raise reconstruct.UnavailableError(f"missing dependency ({error.name}); use the prepared Python environment") from None
    image, _, _ = reconstruct.decode_image(bytes(data))
    # After a full load Pillow has applied any tRNS chunk, wherever it appears.
    # A 16-bit file is reduced to 8 bits while its key stays 16-bit, so a key
    # Pillow interpreted cannot be applied reliably: refuse it.
    if image.format == "PNG" and png_bit_depth(bytes(data)) == 16 and "transparency" in image.info:
        raise reconstruct.InputError("16-bit PNG files with a transparency colour key are not supported; export the photo as an 8-bit PNG or a JPEG")
    try:
        # Display orientation for people; reconstruction keeps stored pixel order.
        image = ImageOps.exif_transpose(image)
    except (OSError, SyntaxError, ValueError, TypeError, KeyError):
        raise reconstruct.InputError("the photo's orientation data could not be read") from None
    rgb = reconstruct.rgb_copy(flatten_on_white(image))
    del image
    rgb.thumbnail((MAX_LONG_EDGE, MAX_LONG_EDGE), Image.Resampling.LANCZOS)
    for quality in JPEG_QUALITIES:
        buffer = io.BytesIO()
        rgb.save(buffer, "JPEG", quality=quality, progressive=False, optimize=False)
        if buffer.tell() <= MAX_OUTPUT_BYTES:
            return buffer.getvalue(), rgb.size
    raise OutputTooLarge(f"the inspection JPEG exceeds {MAX_OUTPUT_BYTES} bytes at the lowest quality")


def read_stdin(stream):
    data = stream.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise reconstruct.InputError(f"the photo exceeds {MAX_INPUT_BYTES} bytes")
    return data


def main(argv=None, stdin=None, stdout=None):
    argparse.ArgumentParser(description="Read one JPEG or PNG photo (at most 20 MiB) on stdin and write a metadata-free inspection JPEG to stdout.").parse_args(argv)
    stdin = stdin if stdin is not None else sys.stdin.buffer
    stdout = stdout if stdout is not None else sys.stdout.buffer
    try:
        jpeg, _ = prepare(read_stdin(stdin))
    except (reconstruct.InputError, reconstruct.UnavailableError, OutputTooLarge) as error:
        print(f"error: {error}", file=sys.stderr)
        return error.exit_code
    stdout.write(jpeg)
    stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
