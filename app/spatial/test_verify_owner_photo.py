import builtins
import io
import json
import struct
import subprocess
import sys
import unittest
import unittest.mock
from pathlib import Path
import zlib

import numpy as np
from PIL import Image

import verify_owner_photo as checker


SCRIPT = Path(checker.__file__)
FIXED_MESSAGES = {f"error: {message}\n" for message in checker.MESSAGES.values()}


def encode(image, fmt, **options):
    buffer = io.BytesIO()
    image.save(buffer, fmt, **options)
    return buffer.getvalue()


def noise(width=160, height=120, seed=1):
    return Image.fromarray(np.random.default_rng(seed).integers(0, 256, (height, width, 3), np.uint8))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png16(colour_type, width=32, height=16, trns=None, trns_after_data=False):
    channels = {0: 1, 2: 3}[colour_type]
    raw = b"".join(b"\x00" + bytes(width * channels * 2) for _ in range(height))
    key = chunk(b"tRNS", trns) if trns is not None else b""
    data = chunk(b"IDAT", zlib.compress(raw))
    header = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 16, colour_type, 0, 0, 0))
    return header + (data + key if trns_after_data else key + data) + chunk(b"IEND", b"")


def png_claiming_size(width, height):
    data = bytearray(encode(Image.new("L", (1, 1)), "PNG"))
    header = b"IHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes(data[24:29])
    data[12:29] = header
    data[29:33] = zlib.crc32(header).to_bytes(4, "big")
    return bytes(data)


def interlaced_png():
    raw = b""
    for x0, y0, dx, dy in [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]:
        for _ in range(len(range(y0, 8, dy))):
            raw += b"\x00" + bytes([128] * len(range(x0, 8, dx)) * 3)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 1)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def run_main(data, expect):
    stdout = io.BytesIO()
    with unittest.mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
        code = checker.main(["--expect", expect], stdin=io.BytesIO(data), stdout=stdout)
    return code, stdout.getvalue(), stderr.getvalue()


class AcceptedTests(unittest.TestCase):
    def assert_verified(self, data, expect, size):
        before = bytes(data)
        code, stdout, stderr = run_main(data, expect)
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout, json.dumps({"width": size[0], "height": size[1]}, separators=(",", ":")).encode())
        self.assertEqual(data, before)

    def test_accepts_supported_jpeg_variants(self):
        image = noise()
        for name, data in {
            "baseline": encode(image, "JPEG"),
            "progressive": encode(image, "JPEG", progressive=True),
            "grayscale": encode(image.convert("L"), "JPEG"),
            "cmyk": encode(image.convert("CMYK"), "JPEG"),
        }.items():
            with self.subTest(name):
                self.assert_verified(data, "jpeg", (160, 120))

    def test_accepts_supported_png_variants(self):
        image = noise()
        cases = {
            "rgb": (encode(image, "PNG"), (160, 120)),
            "palette": (encode(image.convert("P"), "PNG"), (160, 120)),
            "rgba": (encode(image.convert("RGBA"), "PNG"), (160, 120)),
            "interlaced": (interlaced_png(), (8, 8)),
            "16-bit without key": (png16(2), (32, 16)),
        }
        for name, (data, size) in cases.items():
            with self.subTest(name):
                self.assert_verified(data, "png", size)

    def test_reports_stored_order_dimensions_without_applying_exif_orientation(self):
        exif = Image.Exif()
        exif[0x0112] = 6
        self.assert_verified(encode(noise(40, 20), "JPEG", exif=exif), "jpeg", (40, 20))

    def test_documented_limits_tolerant_jpeg_damage_and_trailing_bytes_pass(self):
        data = encode(noise(), "JPEG", quality=90)
        scan = data.index(b"\xff\xda")
        premature_end = data[: scan + (len(data) - scan) // 2] + b"\xff\xd9"
        self.assert_verified(premature_end, "jpeg", (160, 120))
        self.assert_verified(data + b"trailing" * 10, "jpeg", (160, 120))
        self.assert_verified(encode(noise(), "PNG") + b"trailing" * 10, "png", (160, 120))
        # Bytes after a valid IEND are ignored, even if they look like a damaged chunk.
        self.assert_verified(encode(noise(), "PNG") + chunk(b"IEND", b"")[:-1] + b"\x00", "png", (160, 120))


class RefusedTests(unittest.TestCase):
    def assert_refused(self, data, expect, code, reason):
        actual, stdout, stderr = run_main(data, expect)
        self.assertEqual((actual, stdout), (code, b""))
        self.assertEqual(stderr, f"error: {checker.MESSAGES[reason]}\n")
        self.assertIn(stderr, FIXED_MESSAGES)

    def test_content_failures_exit_2_with_fixed_messages(self):
        jpeg = encode(noise(), "JPEG")
        png = encode(noise(), "PNG")
        idat = png.index(b"IDAT")
        length = struct.unpack(">I", png[idat - 4:idat])[0]
        bad_crc = bytearray(png)
        bad_crc[idat + 4 + length] ^= 0xFF
        cases = {
            "empty": (b"", "png"),
            "oversize": (b"\x89PNG" + bytes(checker.MAX_INPUT_BYTES), "png"),
            "garbage": (b"not an image", "jpeg"),
            "gif": (encode(Image.new("RGB", (8, 8)), "GIF"), "png"),
            "webp": (encode(Image.new("RGB", (8, 8)), "WEBP"), "jpeg"),
            "jpeg declared png": (jpeg, "png"),
            "png declared jpeg": (png, "jpeg"),
            "jpeg truncated": (jpeg[: len(jpeg) // 2], "jpeg"),
            "png truncated": (png[: len(png) // 2], "png"),
            "png bad idat crc": (bytes(bad_crc), "png"),
            "png corrupted idat": (png[: idat + 104] + bytes(b ^ 0x55 for b in png[idat + 104: idat + 2000]) + png[idat + 2000:], "png"),
        }
        for name, (data, expect) in cases.items():
            with self.subTest(name):
                self.assert_refused(data, expect, 2, "content")

    def test_refuses_damaged_or_missing_iend(self):
        png = encode(noise(), "PNG")
        iend = png.rindex(b"IEND") - 4
        self.assertEqual(png[iend:], chunk(b"IEND", b""), "the generated PNG ends with a valid IEND")
        body = png[:iend]
        cases = {
            "bad IEND CRC": body + png[iend:-4] + bytes(b ^ 0xFF for b in png[-4:]),
            "IEND CRC missing": body + png[iend:-4],
            "IEND CRC cut short": body + png[iend:-2],
            "IEND missing": body,
            "IEND missing with trailing bytes": body + b"trailing" * 10,
            "IEND with data": body + chunk(b"IEND", b"x"),
        }
        for name, data in cases.items():
            with self.subTest(name):
                self.assert_refused(data, "png", 2, "content")

    def test_refuses_a_bad_crc_in_any_chunk(self):
        png = encode(noise(), "PNG", pnginfo=None)
        for kind in (b"IHDR", b"IDAT"):
            index = png.index(kind)
            length = struct.unpack(">I", png[index - 4:index])[0]
            damaged = bytearray(png)
            damaged[index + 4 + length] ^= 0x01
            with self.subTest(kind=kind):
                self.assert_refused(bytes(damaged), "png", 2, "content")

    def test_refuses_animated_png(self):
        image = noise()
        data = encode(image, "PNG", save_all=True, append_images=[image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)])
        self.assertEqual(Image.open(io.BytesIO(data)).n_frames, 2)
        self.assert_refused(data, "png", 2, "animated")

    def test_refuses_16bit_png_colour_keys_wherever_they_appear(self):
        cases = {
            "rgb": png16(2, trns=struct.pack(">HHH", 4608, 13312, 22016)),
            "rgb after image data": png16(2, trns=struct.pack(">HHH", 4608, 13312, 22016), trns_after_data=True),
            "rgb low key": png16(2, trns=struct.pack(">HHH", 1, 2, 3)),
            "gray": png16(0, trns=struct.pack(">H", 4608)),
            "gray after image data": png16(0, trns=struct.pack(">H", 4608), trns_after_data=True),
        }
        for name, data in cases.items():
            with self.subTest(name):
                self.assert_refused(data, "png", 2, "colour-key")

    def test_pixel_limit_and_bombs_exit_4_before_decoding(self):
        with unittest.mock.patch.object(checker.reconstruct, "decode_image", side_effect=AssertionError("decoded")):
            for size in ((8000, 4001), (100_000, 100_000)):
                with self.subTest(size=size):
                    self.assert_refused(png_claiming_size(*size), "png", 4, "pixels")

    def test_missing_pillow_exits_3(self):
        real_import = builtins.__import__

        def no_pillow(name, *args, **kwargs):
            if name == "PIL" or name.startswith("PIL."):
                raise ImportError(name=name)
            return real_import(name, *args, **kwargs)

        with unittest.mock.patch("builtins.__import__", no_pillow):
            self.assert_refused(encode(Image.new("RGB", (8, 8)), "PNG"), "png", 3, "unavailable")


class ProcessTests(unittest.TestCase):
    def test_cli_prints_only_the_dimensions(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--expect", "jpeg"], input=encode(noise(), "JPEG"), capture_output=True, timeout=60)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'{"width":160,"height":120}', b""))

    def test_requires_a_known_expected_format(self):
        for argv in ([], ["--expect", "gif"], ["--expect", "png", "photo.png"]):
            with self.subTest(argv=argv):
                result = subprocess.run([sys.executable, str(SCRIPT), *argv], input=b"", capture_output=True, timeout=60)
                self.assertEqual((result.returncode, result.stdout), (2, b""))

    def test_help_exits_without_reading_stdin(self):
        process = subprocess.Popen([sys.executable, str(SCRIPT), "--help"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(process.wait(timeout=30), 0)
            self.assertIn(b"usage", process.stdout.read())
        finally:
            process.stdin.close()
            process.kill()
            process.stdout.close()
            process.stderr.close()

    def test_never_imports_model_libraries(self):
        code = (
            "import io, sys; import verify_owner_photo as v; from PIL import Image; "
            "b = io.BytesIO(); Image.new('RGB', (64, 48)).save(b, 'PNG'); v.verify(b.getvalue(), 'png'); "
            "assert not {'torch', 'transformers', 'huggingface_hub'} & set(sys.modules)"
        )
        subprocess.run([sys.executable, "-c", code], check=True, cwd=SCRIPT.parent, timeout=60)


if __name__ == "__main__":
    unittest.main()
