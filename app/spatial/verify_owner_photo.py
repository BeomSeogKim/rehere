#!/usr/bin/env python3
"""Verify one owner photo read from stdin; never writes or transforms it.

Usage: verify_owner_photo.py --expect jpeg|png < photo

Reads at most 20 MiB. The bytes must be the expected format (JPEG or PNG),
have positive dimensions of at most 32,000,000 stored-order pixels, and decode
completely with Pillow. A PNG is also checked with Pillow's verify() on a
separate open, and every PNG chunk up to and including a zero-length IEND must
be complete with a matching CRC. Multi-frame (animated) PNGs and 16-bit
PNGs with a tRNS transparency key are refused. On success stdout is exactly
{"width":W,"height":H} in stored pixel order (EXIF orientation is not applied).

Limits: Pillow tolerates some JPEG damage (for example a premature end marker
or corrupted scan data decodes without error) and ignores bytes after the JPEG
or PNG end (bytes after a valid IEND are not inspected). Passing is therefore
"decodes with Pillow", not forensic integrity.

Exit codes: 0 verified; 2 content or unsupported variant; 3 runtime
unavailable; 4 pixel limit. Error messages are fixed and carry no decoder text.
"""
import argparse
import io
import json
import struct
import sys
import warnings
import zlib

import reconstruct


MAX_INPUT_BYTES = 20 * 1024 * 1024
EXIT_CONTENT, EXIT_UNAVAILABLE, EXIT_PIXELS = 2, 3, 4
FORMATS = {"jpeg": "JPEG", "png": "PNG"}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

MESSAGES = {
    "content": "the photo could not be read as a complete JPEG or PNG image",
    "animated": "animated PNG files are not supported; export a single still image as JPEG or 8-bit PNG",
    "colour-key": "16-bit PNG files with a transparency colour key are not supported; export the photo as JPEG or 8-bit PNG",
    "pixels": f"the photo has more than {reconstruct.MAX_PIXELS} pixels; save a smaller copy",
    "unavailable": "the photo checker is not available on this computer",
}


class Refused(Exception):
    def __init__(self, reason, exit_code=EXIT_CONTENT):
        super().__init__(MESSAGES[reason])
        self.exit_code = exit_code


def png_bit_depth(data):
    if data.startswith(PNG_SIGNATURE) and len(data) >= 26 and data[12:16] == b"IHDR":
        return data[24]
    return None


def png_chunks_complete(data):
    """True when every chunk from the signature to a zero-length IEND is complete
    with a matching CRC. Bytes after that IEND are ignored."""
    view = memoryview(data)
    if bytes(view[:8]) != PNG_SIGNATURE:
        return False
    offset = 8
    while offset + 12 <= len(view):
        length, kind = struct.unpack(">I4s", view[offset:offset + 8])
        end = offset + 12 + length
        if length > 0x7FFFFFFF or end > len(view):
            return False
        stored = struct.unpack(">I", view[end - 4:end])[0]
        if zlib.crc32(view[offset + 4:end - 4]) & 0xFFFFFFFF != stored:
            return False
        if kind == b"IEND":
            return length == 0
        offset = end
    return False


def verify(data, expect):
    """Returns (width, height) or raises Refused."""
    if expect not in FORMATS:
        raise Refused("content")
    if not isinstance(data, (bytes, bytearray)) or not 0 < len(data) <= MAX_INPUT_BYTES:
        raise Refused("content")
    data = bytes(data)
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError:
        raise Refused("unavailable", EXIT_UNAVAILABLE) from None

    # Header only: the pixel limit is checked before any pixel data is decoded.
    Image.MAX_IMAGE_PIXELS = reconstruct.MAX_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            header = Image.open(io.BytesIO(data), formats=(FORMATS[expect],))
            width, height = header.size
            frames = getattr(header, "n_frames", 1)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise Refused("pixels", EXIT_PIXELS) from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError):
        raise Refused("content") from None
    if width <= 0 or height <= 0:
        raise Refused("content")
    if width * height > reconstruct.MAX_PIXELS:
        raise Refused("pixels", EXIT_PIXELS)
    if frames != 1:
        raise Refused("animated")

    if expect == "png":
        if not png_chunks_complete(data):
            raise Refused("content")
        # verify() invalidates its image, so it gets its own open.
        try:
            Image.open(io.BytesIO(data), formats=("PNG",)).verify()
        except Exception:
            raise Refused("content") from None

    try:
        image, detected, _ = reconstruct.decode_image(data)
    except reconstruct.InputError:
        raise Refused("content") from None
    if detected != FORMATS[expect] or image.size != (width, height):
        raise Refused("content")
    # After a full load Pillow has applied any tRNS chunk, wherever it appears;
    # a 16-bit image is reduced to 8 bits while its key stays 16-bit.
    if detected == "PNG" and png_bit_depth(data) == 16 and "transparency" in image.info:
        raise Refused("colour-key")
    if getattr(image, "n_frames", 1) != 1:
        raise Refused("animated")
    return width, height


def main(argv=None, stdin=None, stdout=None):
    parser = argparse.ArgumentParser(description="Verify one owner JPEG or PNG photo read from stdin (at most 20 MiB); prints its stored-order width and height.")
    parser.add_argument("--expect", required=True, choices=sorted(FORMATS))
    args = parser.parse_args(argv)
    stdin = stdin if stdin is not None else sys.stdin.buffer
    stdout = stdout if stdout is not None else sys.stdout.buffer
    data = stdin.read(MAX_INPUT_BYTES + 1)
    try:
        width, height = verify(data, args.expect)
    except Refused as refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return refusal.exit_code
    stdout.write(json.dumps({"width": width, "height": height}, separators=(",", ":")).encode())
    stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
