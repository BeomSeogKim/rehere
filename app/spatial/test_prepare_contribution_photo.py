import builtins
import io
import struct
import subprocess
import sys
import unittest
import unittest.mock
from pathlib import Path
import zlib

import numpy as np
from PIL import Image, PngImagePlugin

import prepare_contribution_photo as photo
import reconstruct


SCRIPT = Path(photo.__file__)
ALLOWED_MARKERS = {0xE0, 0xDB, 0xC0, 0xC4, 0xDD, 0xDA}  # APP0, DQT, baseline SOF0, DHT, DRI, SOS


def encode(image, fmt, **options):
    buffer = io.BytesIO()
    image.save(buffer, fmt, **options)
    return buffer.getvalue()


def private_exif(orientation=1):
    exif = Image.Exif()
    exif[0x0112] = orientation
    exif[0x010F] = "Synthetic camera"
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"
    gps[2] = (1.0, 2.0, 3.0)
    return exif


def halves(width=40, height=20):
    """Dark left half, bright right half, so orientation is visible in the output."""
    pixels = np.zeros((height, width, 3), np.uint8)
    pixels[:, width // 2:] = 255
    return Image.fromarray(pixels)


def jpeg_with_metadata(orientation=1, image=None):
    return encode(image or halves(), "JPEG", exif=private_exif(orientation), icc_profile=b"synthetic-icc" * 4,
                  comment=b"synthetic comment", xmp=b"<x:xmpmeta>synthetic</x:xmpmeta>")


def png_with_metadata():
    info = PngImagePlugin.PngInfo()
    info.add_text("Comment", "synthetic text")
    info.add_itxt("XML:com.adobe.xmp", "<x:xmpmeta>synthetic</x:xmpmeta>")
    return encode(halves(), "PNG", pnginfo=info, icc_profile=b"synthetic-icc" * 4, exif=private_exif())


def png_claiming_size(width, height):
    data = bytearray(encode(Image.new("L", (1, 1)), "PNG"))
    header = b"IHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes(data[24:29])
    data[12:29] = header
    data[29:33] = zlib.crc32(header).to_bytes(4, "big")
    return bytes(data)


def png16(colour_type, pixels, trns=None, trns_after_data=False):
    """A real 16-bit PNG: one 16-bit sample per channel, optional tRNS chunk before or after IDAT."""
    height, width = len(pixels), len(pixels[0])
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[colour_type]

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"".join(struct.pack(">" + "H" * channels, *pixel) for pixel in row) for row in pixels)
    key = chunk(b"tRNS", trns) if trns is not None else b""
    header = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 16, colour_type, 0, 0, 0))
    data = chunk(b"IDAT", zlib.compress(raw))
    return header + (data + key if trns_after_data else key + data) + chunk(b"IEND", b"")


def split(left, right, width=128, height=64):
    return [[left if x < width // 2 else right for x in range(width)] for _ in range(height)]


def jpeg_markers(data):
    """Marker codes before the scan data, plus the baseline frame size."""
    assert data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9"
    markers, size, offset = [], None, 2
    while offset < len(data):
        assert data[offset] == 0xFF
        marker = data[offset + 1]
        length = int.from_bytes(data[offset + 2:offset + 4], "big")
        markers.append(marker)
        if marker in (0xC0, 0xC2):
            size = (int.from_bytes(data[offset + 7:offset + 9], "big"), int.from_bytes(data[offset + 5:offset + 7], "big"))
        if marker == 0xDA:
            break
        offset += 2 + length
    return markers, size


def run_main(data):
    stdout = io.BytesIO()
    with unittest.mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
        code = photo.main([], stdin=io.BytesIO(data), stdout=stdout)
    return code, stdout.getvalue(), stderr.getvalue()


class MetadataTests(unittest.TestCase):
    def assert_clean(self, jpeg):
        markers, size = jpeg_markers(jpeg)
        self.assertTrue(set(markers) <= ALLOWED_MARKERS, [hex(marker) for marker in markers])
        self.assertIn(0xC0, markers)
        output = Image.open(io.BytesIO(jpeg))
        self.assertEqual(size, output.size)
        self.assertTrue(set(output.info) <= {"jfif", "jfif_version", "jfif_unit", "jfif_density", "dpi"}, output.info)
        self.assertEqual(dict(output.getexif()), {})
        for marker in (b"Synthetic camera", b"synthetic comment", b"xmpmeta", b"synthetic-icc", b"synthetic text"):
            self.assertNotIn(marker, jpeg)

    def test_strips_jpeg_exif_gps_xmp_icc_and_comment(self):
        source = jpeg_with_metadata()
        given = Image.open(io.BytesIO(source))
        self.assertEqual(dict(given.getexif().get_ifd(0x8825))[1], "N")
        self.assertTrue({"xmp", "icc_profile", "comment"} <= set(given.info))
        jpeg, size = photo.prepare(source)
        self.assertEqual(size, (40, 20))
        self.assert_clean(jpeg)

    def test_strips_png_text_xmp_icc_and_exif(self):
        source = png_with_metadata()
        given = Image.open(io.BytesIO(source))
        given.load()
        self.assertTrue({"Comment", "xmp", "icc_profile", "exif"} <= set(given.info))
        jpeg, _ = photo.prepare(source)
        self.assert_clean(jpeg)


class OrientationTests(unittest.TestCase):
    def test_applies_exif_orientation_6_for_display(self):
        jpeg, size = photo.prepare(jpeg_with_metadata(orientation=6))
        self.assertEqual(size, (20, 40))
        pixels = np.asarray(Image.open(io.BytesIO(jpeg)).convert("L")).astype(float)
        # Rotating 90 degrees clockwise puts the stored left (dark) half on top.
        self.assertLess(pixels[:20].mean(), 30)
        self.assertGreater(pixels[20:].mean(), 225)

    def test_leaves_unknown_orientation_values_in_stored_order(self):
        _, size = photo.prepare(jpeg_with_metadata(orientation=9))
        self.assertEqual(size, (40, 20))


def region_mean(jpeg, box):
    x0, y0, x1, y1 = box
    return np.asarray(Image.open(io.BytesIO(jpeg)).convert("RGB")).astype(float)[y0:y1, x0:x1].mean(axis=(0, 1))


class TransparencyTests(unittest.TestCase):
    """Transparent pixels become white, as displayed; hidden colour never shows."""

    def assert_near(self, actual, expected, tolerance=6):
        self.assertTrue(all(abs(a - e) <= tolerance for a, e in zip(actual, expected)), (list(actual), expected))

    def test_rgba_hidden_colour_stays_white_and_partial_alpha_composites(self):
        pixels = np.zeros((64, 192, 4), np.uint8)
        pixels[:, :64] = (255, 0, 0, 0)  # fully transparent, hidden red
        pixels[:, 64:128] = (0, 0, 255, 255)  # opaque blue
        pixels[:, 128:] = (0, 0, 0, 128)  # half-transparent black
        jpeg, _ = photo.prepare(encode(Image.fromarray(pixels, "RGBA"), "PNG"))
        self.assert_near(region_mean(jpeg, (8, 8, 56, 56)), (255, 255, 255))
        self.assert_near(region_mean(jpeg, (72, 8, 120, 56)), (0, 0, 255))
        expected = 255 * (1 - 128 / 255)
        self.assert_near(region_mean(jpeg, (136, 8, 184, 56)), (expected, expected, expected))

    def test_palette_transparency_stays_white(self):
        image = Image.new("P", (128, 64), 1)
        image.putpalette([255, 0, 0, 0, 160, 0] + [0] * (254 * 3))
        image.paste(0, (0, 0, 64, 64))  # index 0: hidden red, marked transparent
        jpeg, _ = photo.prepare(encode(image, "PNG", transparency=0))
        self.assert_near(region_mean(jpeg, (8, 8, 56, 56)), (255, 255, 255))
        self.assert_near(region_mean(jpeg, (72, 8, 120, 56)), (0, 160, 0))

    def test_rgb_trns_colour_key_stays_white(self):
        image = Image.new("RGB", (128, 64), (0, 160, 0))
        image.paste((255, 0, 0), (0, 0, 64, 64))
        source = encode(image, "PNG", transparency=(255, 0, 0))
        self.assertEqual(Image.open(io.BytesIO(source)).info.get("transparency"), (255, 0, 0))
        jpeg, _ = photo.prepare(source)
        self.assert_near(region_mean(jpeg, (8, 8, 56, 56)), (255, 255, 255))
        self.assert_near(region_mean(jpeg, (72, 8, 120, 56)), (0, 160, 0))

    def test_refuses_16bit_png_colour_keys_wherever_the_key_appears(self):
        hidden = (4608, 13312, 22016)
        cases = {
            "rgb": png16(2, split(hidden, (0, 40960, 0)), struct.pack(">HHH", *hidden)),
            "rgb-key-after-image-data": png16(2, split(hidden, (0, 40960, 0)), struct.pack(">HHH", *hidden), trns_after_data=True),
            "rgb-low-key": png16(2, split((1, 2, 3), (0, 40960, 0)), struct.pack(">HHH", 1, 2, 3)),
            "gray": png16(0, split((4608,), (40960,)), struct.pack(">H", 4608)),
            "gray-key-after-image-data": png16(0, split((4608,), (40960,)), struct.pack(">H", 4608), trns_after_data=True),
            "gray-low-key": png16(0, split((1,), (40960,)), struct.pack(">H", 1)),
        }
        late = Image.open(io.BytesIO(cases["rgb-key-after-image-data"]))
        late.load()
        self.assertEqual(late.info.get("transparency"), hidden, "Pillow interprets a key placed after the image data")
        for name, data in cases.items():
            with self.subTest(name):
                code, stdout, stderr = run_main(data)
                self.assertEqual((code, stdout), (2, b""))
                self.assertIn("8-bit PNG or a JPEG", stderr)

    def test_16bit_png_without_a_colour_key_or_with_alpha_is_handled(self):
        jpeg, _ = photo.prepare(png16(2, split((65535, 0, 0), (0, 0, 65535))))
        self.assert_near(region_mean(jpeg, (8, 8, 56, 56)), (255, 0, 0))
        jpeg, _ = photo.prepare(png16(6, split((65535, 0, 0, 0), (0, 0, 65535, 65535))))
        self.assert_near(region_mean(jpeg, (8, 8, 56, 56)), (255, 255, 255))
        self.assert_near(region_mean(jpeg, (72, 8, 120, 56)), (0, 0, 255))

    def test_opaque_images_are_not_altered_by_flattening(self):
        image = halves(64, 32)
        self.assertIs(photo.flatten_on_white(image), image)


class SizeTests(unittest.TestCase):
    def test_bounds_the_long_edge_without_enlarging(self):
        _, size = photo.prepare(encode(Image.new("RGB", (3000, 1500), (90, 60, 30)), "JPEG"))
        self.assertEqual(size, (2048, 1024))
        _, small = photo.prepare(encode(Image.new("RGB", (300, 200)), "PNG"))
        self.assertEqual(small, (300, 200))

    def test_noisy_photo_fits_the_output_cap(self):
        noise = np.random.default_rng(3).integers(0, 256, (2048, 2048, 3), np.uint8)
        jpeg, size = photo.prepare(encode(Image.fromarray(noise), "PNG"))
        self.assertLessEqual(len(jpeg), photo.MAX_OUTPUT_BYTES)
        self.assertEqual(size, (2048, 2048))

    def test_steps_down_quality_then_fails_with_exit_4(self):
        source = encode(Image.fromarray(np.random.default_rng(4).integers(0, 256, (400, 400, 3), np.uint8)), "PNG")
        sizes = {quality: len(encode(Image.open(io.BytesIO(source)).convert("RGB"), "JPEG", quality=quality)) for quality in (90, 50)}
        cap = (sizes[90] + sizes[50]) // 2
        with unittest.mock.patch.object(photo, "MAX_OUTPUT_BYTES", cap):
            jpeg, _ = photo.prepare(source)
            self.assertLessEqual(len(jpeg), cap)
        with unittest.mock.patch.object(photo, "MAX_OUTPUT_BYTES", 1000):
            code, stdout, stderr = run_main(source)
        self.assertEqual((code, stdout), (4, b""))
        self.assertRegex(stderr, r"\Aerror: [^\n]+\n\Z")


class FailureTests(unittest.TestCase):
    def test_invalid_input_exits_2_with_empty_stdout(self):
        truncated = jpeg_with_metadata()[:200]
        cases = {
            "empty": b"",
            "oversize": b"\xff\xd8" + b"\x00" * photo.MAX_INPUT_BYTES,
            "gif": encode(Image.new("RGB", (8, 8)), "GIF"),
            "webp": encode(Image.new("RGB", (8, 8)), "WEBP"),
            "truncated": truncated,
            "bomb": png_claiming_size(8000, 4001),
            "garbage": b"not an image at all",
        }
        for name, data in cases.items():
            with self.subTest(name):
                code, stdout, stderr = run_main(data)
                self.assertEqual((code, stdout), (2, b""))
                self.assertRegex(stderr, r"\Aerror: [^\n]+\n\Z")

    def test_missing_pillow_exits_3(self):
        real_import = builtins.__import__

        def no_pillow(name, *args, **kwargs):
            if name == "PIL" or name.startswith("PIL."):
                raise ImportError(name=name)
            return real_import(name, *args, **kwargs)

        with unittest.mock.patch("builtins.__import__", no_pillow):
            code, stdout, _ = run_main(encode(Image.new("RGB", (8, 8)), "PNG"))
        self.assertEqual((code, stdout), (3, b""))
        self.assertTrue(issubclass(reconstruct.UnavailableError, Exception))


class ProcessTests(unittest.TestCase):
    def run_cli(self, *argv, data=None, timeout=60):
        return subprocess.run([sys.executable, str(SCRIPT), *argv], input=data, capture_output=True, timeout=timeout)

    def test_cli_writes_only_jpeg_to_stdout(self):
        result = self.run_cli(data=jpeg_with_metadata(orientation=6))
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        self.assertEqual(Image.open(io.BytesIO(result.stdout)).size, (20, 40))
        self.assertEqual(jpeg_markers(result.stdout)[1], (20, 40))

    def test_help_exits_without_reading_stdin(self):
        process = subprocess.Popen([sys.executable, str(SCRIPT), "--help"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # stdin stays open: a CLI that read it would never exit, and wait() would time out.
            self.assertEqual(process.wait(timeout=30), 0)
            self.assertIn(b"usage", process.stdout.read())
        finally:
            process.stdin.close()
            process.kill()
            process.stdout.close()
            process.stderr.close()

    def test_rejects_unexpected_arguments(self):
        self.assertEqual(self.run_cli("photo.jpg", data=b"").returncode, 2)

    def test_never_imports_model_libraries(self):
        code = (
            "import io, sys; import prepare_contribution_photo as p; from PIL import Image; "
            "b = io.BytesIO(); Image.new('RGB', (64, 48)).save(b, 'JPEG'); p.prepare(b.getvalue()); "
            "assert not {'torch', 'transformers', 'huggingface_hub'} & set(sys.modules), sorted(m for m in sys.modules if 'torch' in m)"
        )
        subprocess.run([sys.executable, "-c", code], check=True, cwd=SCRIPT.parent, timeout=60)


if __name__ == "__main__":
    unittest.main()
