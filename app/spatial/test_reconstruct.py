import contextlib
import errno
import io
import json
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



OBJECTS = '[{"label": "Display counter", "box": [0, 435, 226, 790]}, {"label": "Flour stack", "box": [490, 450, 982, 781]}]'


def two_object_layout(width=40, height=20):
    """Background with object 1 in columns 4-13 and object 2 in columns 24-33, rows 4-15."""
    regions = np.zeros((height, width), np.int8)
    regions[4:16, 4:14] = 1
    regions[4:16, 24:34] = 2
    return np.full((height, width), 3.0), regions


class TwoObjectArgumentTests(unittest.TestCase):
    def parse(self, *extra):
        return reconstruct.parse_args(["--image", "a.jpg", "--output", "out", "--source-id", SOURCE_ID, *extra])

    def test_accepts_two_labelled_boxes_in_order(self):
        args = self.parse("--objects", OBJECTS)
        self.assertIsNone(args.box)
        self.assertEqual(args.objects, [{"label": "Display counter", "box": [0.0, 435.0, 226.0, 790.0]}, {"label": "Flour stack", "box": [490.0, 450.0, 982.0, 781.0]}])
        long_label = "\U0001d11e" * 40
        self.assertEqual(self.parse("--objects", json.dumps([{"label": long_label, "box": [0, 0, 1, 1]}, {"label": "b", "box": [0, 0, 1, 1]}])).objects[0]["label"], long_label)

    def test_rejects_invalid_objects_and_mixed_selection(self):
        good = {"label": "a", "box": [0, 0, 1, 1]}
        invalid = [
            "not json", json.dumps([good]), json.dumps([good, {"label": "b", "box": [0, 0, 1, 1]}, good]),
            json.dumps([good, {"label": "b", "box": [0, 0, 1, 1], "id": "x"}]), json.dumps([good, {"label": " b", "box": [0, 0, 1, 1]}]),
            json.dumps([good, {"label": "", "box": [0, 0, 1, 1]}]), json.dumps([good, {"label": "b\u0007", "box": [0, 0, 1, 1]}]),
            json.dumps([good, {"label": "\U0001d11e" * 41, "box": [0, 0, 1, 1]}]), json.dumps([good, {"label": "A", "box": [0, 0, 1, 1]}]),
            json.dumps([good, {"label": "b", "box": [0, 0, 1]}]), json.dumps([good, {"label": "b", "box": [0, 0, True, 1]}]),
            '[{"label": "a", "box": [0, 0, 1, 1]}, {"label": "b", "box": [0, 0, NaN, 1]}]',
        ]
        for text in invalid:
            with self.subTest(text=text[:40]), self.assertRaises(SystemExit), unittest.mock.patch("sys.stderr"):
                self.parse("--objects", text)
        for extra in ([], ["--box", "0", "0", "1", "1", "--objects", OBJECTS]):
            with self.subTest(extra=extra), self.assertRaises(SystemExit), unittest.mock.patch("sys.stderr"):
                self.parse(*extra)


class TwoObjectRegionTests(unittest.TestCase):
    def test_disjoint_masks_keep_both_objects(self):
        first = np.zeros((10, 10), bool)
        second = np.zeros((10, 10), bool)
        first[:, :4] = True
        second[:, 6:] = True
        regions, overlap = reconstruct.combine_masks(first, second)
        self.assertEqual(overlap, {"pixels": 0, "ratio": 0.0})
        self.assertEqual(set(np.unique(regions)), {0, 1, 2})

    def test_small_overlap_becomes_void_not_background(self):
        first = np.zeros((100, 100), bool)
        second = np.zeros((100, 100), bool)
        first[:, :50] = True
        second[:, 49:] = True
        second[:, 49] = False
        second[0:20, 49] = True  # 20 shared pixels: 0.4% of the smaller mask
        regions, overlap = reconstruct.combine_masks(first, second)
        self.assertEqual(overlap["pixels"], 20)
        self.assertEqual(int((regions == reconstruct.VOID).sum()), 20)
        self.assertTrue((regions[0:20, 49] == reconstruct.VOID).all())
        self.assertEqual(int((regions == 0).sum()), 0)

    def test_reports_a_tiny_positive_overlap_at_full_precision(self):
        first = np.zeros((2000, 4000), bool)
        second = np.zeros((2000, 4000), bool)
        first[:, :1000] = True  # 2,000,000 pixels
        second[:, 2000:3500] = True
        second[0, 999] = True  # one shared pixel
        regions, overlap = reconstruct.combine_masks(first, second)
        self.assertEqual(overlap["pixels"], 1)
        self.assertGreater(overlap["ratio"], 0)
        self.assertEqual(overlap["ratio"], 1 / 2_000_000)  # one pixel of the smaller mask: 5e-7
        self.assertEqual(json.loads(json.dumps(overlap))["ratio"], overlap["ratio"])
        self.assertEqual(int((regions == reconstruct.VOID).sum()), 1)

    def test_applies_the_one_percent_limit_exactly(self):
        first = np.zeros((100, 1000), bool)
        second = np.zeros((100, 1000), bool)
        first[:, :100] = True  # 10,000 pixels, the smaller mask
        second[:, 200:500] = True
        second[0:100, 99] = True  # 100 shared pixels: exactly 1%
        _, overlap = reconstruct.combine_masks(first, second)
        self.assertEqual(overlap, {"pixels": 100, "ratio": 0.01})
        second[0, 98] = True  # 101 shared pixels: just over 1%
        with self.assertRaises(reconstruct.ProposalRejected):
            reconstruct.combine_masks(first, second)

    def test_large_overlap_or_empty_mask_is_rejected(self):
        first = np.zeros((100, 100), bool)
        second = np.zeros((100, 100), bool)
        first[:, :50] = True
        second[:, 45:] = True
        with self.assertRaises(reconstruct.ProposalRejected):
            reconstruct.combine_masks(first, second)
        with self.assertRaises(reconstruct.ProposalRejected):
            reconstruct.combine_masks(first, np.zeros((100, 100), bool))

    def test_mask_levels_round_trip_to_grid_regions(self):
        regions = np.array([[0, 1, 2, 0]], np.int8)
        self.assertEqual(reconstruct.mask_levels(np.array([[0, 1, 2, -1]], np.int8)).tolist(), [[0, 127, 255, 63]])
        self.assertEqual(reconstruct.grid_regions(reconstruct.mask_levels(regions), 4, 1).tolist(), regions.tolist())
        # A void pixel also voids every node of the cells its footprint touches.
        voided = reconstruct.grid_regions(reconstruct.mask_levels(np.array([[0, 1, 2, -1]], np.int8)), 4, 1)
        self.assertEqual(voided.tolist(), [[0, 1, -1, -1]])

    def assert_void_footprints_untouched(self, regions_full, grid):
        """Every grid cell overlapped by a void pixel has only void corners, so no triangle covers it."""
        height, width = regions_full.shape
        grid_height, grid_width = grid.shape
        for y, x in zip(*np.nonzero(regions_full == reconstruct.VOID)):
            gx0, gx1 = x / width * (grid_width - 1), (x + 1) / width * (grid_width - 1)
            gy0, gy1 = y / height * (grid_height - 1), (y + 1) / height * (grid_height - 1)
            for column in range(int(gx0), min(int(np.ceil(gx1)), grid_width - 1)):
                for row in range(int(gy0), min(int(np.ceil(gy1)), grid_height - 1)):
                    corners = grid[row:row + 2, column:column + 2]
                    self.assertTrue((corners == reconstruct.VOID).all(), (y, x, row, column))

    def test_keeps_a_single_void_pixel_that_nearest_sampling_would_drop(self):
        first = np.zeros((512, 512), bool)
        second = np.zeros((512, 512), bool)
        first[0:150, 0:150] = True
        second[200:350, 200:350] = True
        second[80, 80] = True
        regions, overlap = reconstruct.combine_masks(first, second)
        self.assertEqual(overlap["pixels"], 1)
        levels = reconstruct.mask_levels(regions)
        nearest = np.asarray(Image.fromarray(levels).resize((256, 256), Image.Resampling.NEAREST))
        self.assertFalse((nearest == 63).any(), "nearest sampling alone loses this void pixel")
        grid = reconstruct.grid_regions(levels, 256, 256)
        self.assertTrue((grid == reconstruct.VOID).any())
        self.assert_void_footprints_untouched(regions, grid)
        # The footprint straddles a grid line, so the cells on both sides lose their corners: 3 x 3 nodes.
        self.assertEqual(int((grid == reconstruct.VOID).sum()), 9)

    def test_keeps_a_thin_void_boundary_at_production_scale(self):
        first = np.zeros((768, 1024), bool)
        second = np.zeros((768, 1024), bool)
        first[100:700, 100:401] = True
        second[100:700, 400:800] = True
        regions, overlap = reconstruct.combine_masks(first, second)
        self.assertEqual(overlap["pixels"], 600)
        grid = reconstruct.grid_regions(reconstruct.mask_levels(regions), 256, 192)
        self.assert_void_footprints_untouched(regions, grid)
        depth = np.full(grid.shape, 3.0)
        counts = reconstruct.region_triangles(depth, grid)
        self.assertGreater(counts[1], 0)
        self.assertGreater(counts[2], 0)

    def test_accepts_readable_regions_and_counts_their_triangles(self):
        depth, regions = two_object_layout()
        coverages, triangles = reconstruct.check_regions(depth, regions)
        self.assertEqual(coverages, [0.15, 0.15])
        self.assertEqual([triangles[1], triangles[2]], [2 * 9 * 11, 2 * 9 * 11])
        regions[5, 5] = reconstruct.VOID
        voided = reconstruct.region_triangles(depth, regions)
        self.assertEqual(voided[0], triangles[0])
        self.assertLess(voided[1], triangles[1])

    def test_rejects_small_large_or_unreadable_regions(self):
        depth, regions = two_object_layout()
        tiny = regions.copy()
        tiny[tiny == 2] = 0
        tiny[4:6, 24:27] = 2
        large = regions.copy()
        large[:, 0:22] = 1  # 55% of the grid
        combined = np.zeros((20, 40), np.int8)
        combined[:, 0:13] = 1
        combined[:, 13:26] = 2
        broken = depth.copy()
        broken[4:16, 24:34] = np.where(np.indices((12, 10)).sum(axis=0) % 2, 2.0, 5.0)
        for name, case_depth, case_regions in (("tiny", depth, tiny), ("large", depth, large), ("combined", depth, combined), ("unreadable", broken, regions)):
            with self.subTest(name), self.assertRaises(reconstruct.ProposalRejected):
                reconstruct.check_regions(case_depth, case_regions)

if __name__ == "__main__":
    unittest.main()
