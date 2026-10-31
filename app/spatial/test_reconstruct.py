import contextlib
import errno
import io
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path
import zlib

import numpy as np
from PIL import Image

import reconstruct


SCRIPT = Path(reconstruct.__file__)
SOURCE_ID = "3f2b6c1e-8d4a-4b7e-9c2f-1a2b3c4d5e6f"


def encode(image, fmt, **options):
    buffer = io.BytesIO()
    image.save(buffer, fmt, **options)
    return buffer.getvalue()


def png_claiming_size(width, height):
    """A tiny valid PNG whose header claims a different size."""
    data = bytearray(encode(Image.new("L", (1, 1)), "PNG"))
    header = b"IHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes(data[24:29])
    data[12:29] = header
    data[29:33] = zlib.crc32(header).to_bytes(4, "big")
    return bytes(data)


class ArgumentTests(unittest.TestCase):
    def parse(self, *extra):
        return reconstruct.parse_args(["--image", "a.jpg", "--output", "out", "--source-id", SOURCE_ID, *extra])

    def test_accepts_numeric_box(self):
        self.assertEqual(self.parse("--box", "1", "2.5", "30", "40").box, [1, 2.5, 30, 40])

    def test_rejects_non_finite_or_missing_box_and_bad_source_id(self):
        for argv in (["--box", "nan", "0", "1", "1"], ["--box", "0", "0", "inf", "1"], ["--box", "0", "0", "1"], []):
            with self.subTest(argv=argv), self.assertRaises(SystemExit), unittest.mock.patch("sys.stderr"):
                self.parse(*argv)
        with self.assertRaises(SystemExit), unittest.mock.patch("sys.stderr"):
            reconstruct.parse_args(["--image", "a", "--output", "o", "--source-id", "not-a-uuid", "--box", "0", "0", "1", "1"])

    def test_box_must_lie_inside_image_with_area(self):
        self.assertEqual(reconstruct.validate_box([0, 0, 100, 50], 100, 50), [0, 0, 100, 50])
        for box in ([-1, 0, 10, 10], [0, 0, 101, 10], [10, 0, 10, 10], [20, 0, 10, 10], [0, 5, 10, 5], [0, 0, 10, 51]):
            with self.subTest(box=box), self.assertRaises(reconstruct.InputError):
                reconstruct.validate_box(box, 100, 50)


class GeometryTests(unittest.TestCase):
    def test_grid_keeps_width_and_proportional_height(self):
        self.assertEqual(reconstruct.grid_size(1007, 801), (256, 204))
        self.assertEqual(reconstruct.grid_size(1000, 4000), (256, 1024))

    def test_grid_rejects_extreme_aspect_ratios(self):
        for size in ((1000, 4010), (300, 1)):
            with self.subTest(size=size), self.assertRaises(reconstruct.InputError):
                reconstruct.grid_size(*size)

    def test_pseudo_depth_is_bounded_and_monotonic(self):
        raw = np.linspace(0, 1, 100).reshape(10, 10)
        depth, _ = reconstruct.pseudo_depth(raw)
        self.assertTrue(np.isfinite(depth).all())
        self.assertGreaterEqual(depth.min(), 2.0)
        self.assertLessEqual(depth.max(), 5.0)
        self.assertGreater(depth[0, 0], depth[-1, -1])

    def test_pseudo_depth_rejects_constant_or_non_finite(self):
        for raw in (np.ones((4, 4)), np.array([[0.0, np.nan], [1.0, 2.0]])):
            with self.subTest(raw=raw), self.assertRaises(reconstruct.ProposalRejected):
                reconstruct.pseudo_depth(raw)


def block_mask(size=20, start=5, stop=12):
    mask = np.zeros((size, size), bool)
    mask[start:stop, start:stop] = True
    return mask


class SurfaceTests(unittest.TestCase):
    smooth = np.linspace(2, 5, 400).reshape(20, 20)

    def test_counts_triangles_the_scene_builder_keeps(self):
        # A 7x7-vertex block holds 6x6 cells of two triangles each.
        background, foreground = reconstruct.surviving_triangles(self.smooth, block_mask())
        self.assertEqual(foreground, 72)
        self.assertGreater(background, 0)
        self.assertAlmostEqual(reconstruct.check_surface(self.smooth, block_mask()), 49 / 400)

    def test_rejects_coverage_outside_range(self):
        for stop in (1, 17):
            with self.subTest(stop=stop), self.assertRaises(reconstruct.ProposalRejected):
                reconstruct.check_surface(self.smooth, block_mask(start=0, stop=stop))

    def test_rejects_regions_whose_triangles_all_exceed_depth_span(self):
        checkerboard = np.where(np.indices((20, 20)).sum(axis=0) % 2, 5.0, 2.0)
        background_only = np.where(block_mask(), self.smooth, checkerboard)
        for name, depth in (("both", checkerboard), ("background", background_only)):
            with self.subTest(name), self.assertRaises(reconstruct.ProposalRejected):
                reconstruct.check_surface(depth, block_mask())

    def test_rejects_mask_without_whole_triangles(self):
        mask = np.zeros((20, 20), bool)
        mask[::2, ::2] = True
        with self.assertRaises(reconstruct.ProposalRejected):
            reconstruct.check_surface(self.smooth, mask)


class WriteTests(unittest.TestCase):
    files = {name: name.encode() for name in reconstruct.OUTPUT_NAMES}

    def test_injected_write_failure_leaves_no_completion_marker(self):
        real_open = open
        calls = []

        def failing_open(path, mode="r", *args, **kwargs):
            calls.append(path)
            if len(calls) == 3:
                raise OSError(errno.ENOSPC, "No space left on device", str(path))
            return real_open(path, mode, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "job"
            with unittest.mock.patch("builtins.open", failing_open), self.assertRaises(reconstruct.WriteError) as caught:
                reconstruct.write_outputs(output, self.files)
            self.assertIn("No space left on device", str(caught.exception))
            self.assertEqual(sorted(path.name for path in output.iterdir()), sorted(reconstruct.OUTPUT_NAMES[:2]))

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root ignores directory permissions")
    def test_unwritable_directory_is_a_write_error(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "job"
            output.mkdir(mode=0o500)
            try:
                with self.assertRaises(reconstruct.WriteError):
                    reconstruct.write_outputs(output, self.files)
            finally:
                output.chmod(0o700)

    def test_main_reports_write_error_as_one_line(self):
        stderr = io.StringIO()
        error = reconstruct.WriteError("cannot write out/mask.png: Permission denied")
        argv = ["--image", "a.jpg", "--output", "out", "--source-id", SOURCE_ID, "--box", "0", "0", "1", "1"]
        with unittest.mock.patch.object(reconstruct, "reconstruct", side_effect=error), contextlib.redirect_stderr(stderr):
            self.assertEqual(reconstruct.main(argv), reconstruct.EXIT_WRITE)
        self.assertEqual(stderr.getvalue(), "error: cannot write out/mask.png: Permission denied\n")


class ImageTests(unittest.TestCase):
    def test_rejects_other_formats_and_garbage(self):
        image = Image.new("RGB", (8, 8))
        for data in (encode(image, "GIF"), encode(image, "WEBP"), encode(image, "BMP"), b"not an image", encode(image, "JPEG")[:40]):
            with self.subTest(data=data[:8]), self.assertRaises(reconstruct.InputError):
                reconstruct.decode_image(data)

    def test_rejects_decompression_bombs_before_decoding(self):
        for size in ((8000, 4001), (100_000, 100_000)):
            with self.subTest(size=size), self.assertRaises(reconstruct.InputError):
                reconstruct.decode_image(png_claiming_size(*size))

    def test_keeps_stored_pixel_order_and_reports_orientation(self):
        exif = Image.Exif()
        exif[0x0112] = 6
        data = encode(Image.new("RGB", (40, 20)), "JPEG", exif=exif)
        image, fmt, orientation = reconstruct.decode_image(data)
        self.assertEqual((image.size, fmt, orientation), ((40, 20), "JPEG", 6))

    def test_rgb_copy_strips_metadata(self):
        exif = Image.Exif()
        exif[0x0112] = 6
        exif[0x010F] = "Camera"
        source, _, _ = reconstruct.decode_image(encode(Image.new("RGBA", (16, 8), (10, 20, 30, 128)), "PNG", exif=exif, icc_profile=b"profile"))
        texture = Image.open(io.BytesIO(encode(reconstruct.rgb_copy(source), "JPEG")))
        self.assertEqual(texture.mode, "RGB")
        self.assertEqual(dict(texture.getexif()), {})
        self.assertNotIn("icc_profile", texture.info)
        self.assertNotIn("exif", texture.info)


class CommandTests(unittest.TestCase):
    def run_cli(self, *argv):
        return subprocess.run([sys.executable, str(SCRIPT), *argv], capture_output=True, text=True, timeout=60)

    def test_help_does_not_import_models(self):
        code = "import sys, reconstruct; assert 'torch' not in sys.modules and 'transformers' not in sys.modules"
        subprocess.run([sys.executable, "-c", code], check=True, cwd=SCRIPT.parent)
        self.assertEqual(self.run_cli("--help").returncode, 0)

    def test_rejects_bad_inputs_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jpeg, gif = root / "photo.jpg", root / "photo.gif"
            jpeg.write_bytes(encode(Image.new("RGB", (64, 48)), "JPEG"))
            gif.write_bytes(encode(Image.new("RGB", (64, 48)), "GIF"))
            occupied = root / "occupied"
            occupied.mkdir()
            (occupied / "summary.json").write_text("{}")
            cases = {
                "box": (jpeg, root / "a", ["0", "0", "65", "10"]),
                "format": (gif, root / "b", ["0", "0", "10", "10"]),
                "missing": (root / "absent.png", root / "c", ["0", "0", "10", "10"]),
                "occupied": (jpeg, occupied, ["0", "0", "10", "10"]),
                "parent": (jpeg, root / "absent" / "out", ["0", "0", "10", "10"]),
                "file": (jpeg, jpeg, ["0", "0", "10", "10"]),
            }
            for name, (image, output, box) in cases.items():
                with self.subTest(name):
                    result = self.run_cli("--image", str(image), "--output", str(output), "--source-id", SOURCE_ID, "--box", *box)
                    self.assertEqual(result.returncode, reconstruct.EXIT_INPUT, result.stderr)
                    self.assertTrue(result.stderr.startswith("error: "))
                    self.assertTrue(output in (occupied, jpeg) or not output.exists())
            self.assertEqual([path.name for path in occupied.iterdir()], ["summary.json"])


if __name__ == "__main__":
    unittest.main()
