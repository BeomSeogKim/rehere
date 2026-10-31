import io
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import numpy as np
from PIL import Image

import prepare_model_image as helper
import reconstruct


SCRIPT = Path(helper.__file__)


def encode(image, fmt, **options):
    buffer = io.BytesIO()
    image.save(buffer, fmt, **options)
    return buffer.getvalue()


def oriented_jpeg(size=(1600, 800)):
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x010F] = "Camera"
    # Left half dark, right half bright, so a rotation would be visible.
    pixels = np.zeros((size[1], size[0], 3), np.uint8)
    pixels[:, size[0] // 2:] = 255
    return encode(Image.fromarray(pixels), "JPEG", exif=exif, icc_profile=b"profile")


class ThumbnailTests(unittest.TestCase):
    def test_bounds_long_edge_and_keeps_stored_orientation_without_metadata(self):
        jpeg, size = helper.thumbnail_jpeg(oriented_jpeg(), [0, 0, 100, 100])
        thumbnail = Image.open(io.BytesIO(jpeg))
        self.assertEqual((thumbnail.format, thumbnail.mode, thumbnail.size, size), ("JPEG", "RGB", (1024, 512), (1024, 512)))
        self.assertEqual(dict(thumbnail.getexif()), {})
        self.assertFalse({"exif", "icc_profile"} & set(thumbnail.info))
        pixels = np.asarray(thumbnail)
        self.assertLess(pixels[:, :400].mean(), 20)
        self.assertGreater(pixels[:, -400:].mean(), 235)

    def test_small_png_is_not_upscaled(self):
        jpeg, size = helper.thumbnail_jpeg(encode(Image.new("RGBA", (300, 200), (1, 2, 3, 0)), "PNG"), [10, 10, 300, 200])
        self.assertEqual(size, (300, 200))
        self.assertEqual(Image.open(io.BytesIO(jpeg)).size, (300, 200))

    def test_noisy_image_stays_under_output_cap(self):
        noise = np.random.default_rng(1).integers(0, 256, (1024, 1024, 3), np.uint8)
        jpeg, _ = helper.thumbnail_jpeg(encode(Image.fromarray(noise), "PNG"), [0, 0, 1, 1])
        self.assertLessEqual(len(jpeg), helper.MAX_OUTPUT_BYTES)

    def test_lowers_quality_to_fit_cap_or_fails(self):
        noise = encode(Image.fromarray(np.random.default_rng(1).integers(0, 256, (512, 512, 3), np.uint8)), "PNG")
        with unittest.mock.patch.object(helper, "MAX_OUTPUT_BYTES", 150_000):
            jpeg, _ = helper.thumbnail_jpeg(noise, [0, 0, 1, 1])
            self.assertLessEqual(len(jpeg), 150_000)
        with unittest.mock.patch.object(helper, "MAX_OUTPUT_BYTES", 1000), self.assertRaises(reconstruct.ProposalRejected):
            helper.thumbnail_jpeg(noise, [0, 0, 1, 1])

    def test_rejects_box_outside_stored_image(self):
        # 1600x800 as stored; the same box would fit an EXIF-rotated 800x1600 view.
        with self.assertRaises(reconstruct.InputError):
            helper.thumbnail_jpeg(oriented_jpeg(), [0, 0, 700, 1500])

    def test_rejects_other_formats(self):
        with self.assertRaises(reconstruct.InputError):
            helper.thumbnail_jpeg(encode(Image.new("RGB", (8, 8)), "GIF"), [0, 0, 1, 1])


class CommandTests(unittest.TestCase):
    def run_cli(self, *argv):
        return subprocess.run([sys.executable, str(SCRIPT), *argv], capture_output=True, timeout=60)

    def test_help_does_not_import_image_or_model_libraries(self):
        code = "import sys, prepare_model_image; assert not {'PIL', 'numpy', 'torch', 'transformers'} & set(sys.modules)"
        subprocess.run([sys.executable, "-c", code], check=True, cwd=SCRIPT.parent)
        self.assertEqual(self.run_cli("--help").returncode, 0)

    def test_writes_only_jpeg_to_stdout(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "photo.jpg"
            image.write_bytes(oriented_jpeg())
            result = self.run_cli("--image", str(image), "--box", "10", "10", "200", "200")
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        self.assertEqual(Image.open(io.BytesIO(result.stdout)).size, (1024, 512))

    def test_failures_are_one_line_without_paths_or_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            photo, gif, large = root / "photo.jpg", root / "photo.gif", root / "large.jpg"
            photo.write_bytes(oriented_jpeg())
            gif.write_bytes(encode(Image.new("RGB", (8, 8)), "GIF"))
            with open(large, "wb") as handle:
                handle.truncate(helper.MAX_INPUT_BYTES + 1)
            cases = {
                "box": (photo, ["0", "0", "1601", "10"], reconstruct.EXIT_INPUT),
                "format": (gif, ["0", "0", "1", "1"], reconstruct.EXIT_INPUT),
                "missing": (root / "absent.png", ["0", "0", "1", "1"], reconstruct.EXIT_INPUT),
                "size": (large, ["0", "0", "1", "1"], reconstruct.EXIT_INPUT),
                "non-finite": (photo, ["0", "0", "nan", "1"], 2),
            }
            for name, (image, box, code) in cases.items():
                with self.subTest(name):
                    result = self.run_cli("--image", str(image), "--box", *box)
                    stderr = result.stderr.decode()
                    self.assertEqual(result.returncode, code)
                    self.assertEqual(result.stdout, b"")
                    self.assertNotIn(directory, stderr)
                    if name != "non-finite":
                        self.assertRegex(stderr, r"\Aerror: [^\n]+\n\Z")


if __name__ == "__main__":
    unittest.main()
