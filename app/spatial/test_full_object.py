"""Synthetic tests; no reconstruction models or weights are imported."""
import contextlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

import full_object as worker


VERTICES = [[-1, 0, -1], [1, 0, -1], [0, 1, 1]]
FACES = [[0, 1, 2]]
COLORS = [[.25, .5, 1]] * 3


class FullObjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = self.root / "source.png"
        Image.new("RGB", (7, 5), (201, 33, 19)).save(self.image)
        self.mask = self.root / "mask.png"
        self.save_mask([(2, 1), (3, 1), (2, 2), (3, 2), (2, 3), (3, 3)])
        self.parent = {
            "source": {"sha256": worker.file_sha(self.image), "image_size": [7, 5],
                       "selected_object": {"id": "foreground"}},
            "width": 4, "height": 3, "depth": [3.] * 12,
            "foreground": [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
            "assumptions": {"horizontal_fov_degrees": 55, "near": 2, "far": 5}}
        self.parent_path = self.root / "surface.json"
        self.output = self.root / "output"
        self.output.mkdir()
        self.write_parent()

    def write_parent(self):
        self.parent_path.write_text(json.dumps(self.parent))

    def save_mask(self, points, mode="L"):
        image = Image.new("L", (7, 5))
        for point in points:
            image.putpixel(point, 255)
        image.convert(mode).save(self.mask)

    def validate(self):
        return worker.validate_outline(self.mask, 7, 5, 4, 3)

    def build(self, generate=None):
        return worker.build(self.image, self.mask, self.parent_path, self.output,
                            generate or (lambda _: (VERTICES, FACES, COLORS)))

    def test_mask_receipt_modes_hash_bounds_and_grid_ties(self):
        for mode in ("1", "L", "RGB", "RGBA"):
            with self.subTest(mode=mode):
                self.save_mask([(1, 1), (2, 2), (6, 4)], mode)
                receipt, mask = self.validate()
                self.assertEqual(receipt, {
                    "width": 7, "height": 5, "maskSha256": worker.file_sha(self.mask),
                    "bounds": [1, 1, 7, 5], "selectedPixels": 3,
                    "gridWidth": 4, "gridHeight": 3, "coveredGridIndices": [5, 11]})
                self.assertEqual(sum(bool(v) for v in mask), 3)
        self.assertEqual(list(worker.grid_pixels(4, 2, 3, 2)),
                         [(0, 0), (2, 0), (3, 0), (0, 1), (2, 1), (3, 1)])

    def test_empty_grid_support_valid_outline_but_build_rejects_before_generator(self):
        self.save_mask([(1, 1)])
        self.assertEqual(self.validate()[0]["coveredGridIndices"], [])
        with self.assertRaisesRegex(worker.Refused, "usable geometry"), patch.object(worker, "generate_mesh") as generate:
            self.build(generate)
        generate.assert_not_called()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_reject_invalid_png_pixels_and_variants(self):
        for value in (0, 255, 17):
            Image.new("L", (7, 5), value).save(self.mask)
            with self.subTest(value=value), self.assertRaises(worker.Refused):
                self.validate()
        for pixel in ((255, 0, 255, 255), (255, 255, 255, 254)):
            image = Image.new("RGBA", (7, 5), (0, 0, 0, 255))
            image.putpixel((2, 2), pixel)
            image.save(self.mask)
            with self.subTest(pixel=pixel), self.assertRaises(worker.Refused):
                self.validate()
        for mode in ("P", "I;16"):
            Image.new(mode, (7, 5)).save(self.mask)
            with self.subTest(mode=mode), self.assertRaises(worker.Refused):
                self.validate()
        Image.new("L", (7, 5)).save(self.mask, "JPEG")
        with self.assertRaises(worker.Refused):
            self.validate()

    def test_reject_truncation_crc_animated_and_wrong_dimensions(self):
        data = self.mask.read_bytes()
        for payload in (data[:-12], data[:45] + bytes([data[45] ^ 1]) + data[46:]):
            self.mask.write_bytes(payload)
            with self.assertRaises(worker.Refused):
                self.validate()
        Image.new("L", (7, 5)).save(self.mask, save_all=True,
            append_images=[Image.new("L", (7, 5), 255)], duration=100)
        with self.assertRaises(worker.Refused):
            self.validate()
        Image.new("L", (8, 5)).save(self.mask)
        with self.assertRaises(worker.Refused):
            self.validate()

    def test_dimension_and_wire_limits(self):
        for args in ((0, 5, 4, 3), (7, 5, 1, 3), (8000, 8000, 4, 3), (7, 5, 1024, 1024)):
            with self.subTest(args=args), self.assertRaises(worker.Refused):
                worker.validate_outline(self.mask, *args)
        with patch.object(worker, "MAX_MASK_BYTES", 1), self.assertRaises(worker.Refused):
            self.validate()

    def test_validator_cli_is_model_free_and_failure_has_no_success_json(self):
        script = ("import sys; import full_object; "
                  "code=full_object.main(sys.argv[1:]); "
                  "assert not any(n.split('.')[0] in {'torch','tsr','transformers','numpy'} for n in sys.modules); "
                  "sys.exit(code)")
        args = [sys.executable, "-B", "-c", script, "--validate-outline", str(self.mask),
                "--width", "7", "--height", "5", "--grid-width", "4", "--grid-height", "3"]
        result = subprocess.run(args, capture_output=True, text=True, cwd=Path(worker.__file__).parent, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["coveredGridIndices"], [5])
        self.assertEqual(result.stderr, "")
        self.mask.write_bytes(b"not a PNG")
        result = subprocess.run(args, capture_output=True, text=True, cwd=Path(worker.__file__).parent, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), worker.MESSAGES["input"])

    def test_inclusive_crop_preserves_last_row_column_and_gray_padding(self):
        receipt, mask = self.validate()
        with Image.open(self.image) as image:
            cutout = worker.preprocess(image, mask, receipt["bounds"])
        self.assertEqual(cutout.size, (3, 3))
        self.assertEqual(cutout.tobytes().count(bytes((201, 33, 19))), 6)
        self.assertEqual(cutout.tobytes().count(bytes((127, 127, 127))), 3)

    def test_parent_identity_schema_and_depth_refusals(self):
        for mutate in (
            lambda p: p.update(schema_version=2), lambda p: p.update(schema_version=3),
            lambda p: p["source"].update(sha256="0" * 64),
            lambda p: p["source"].update(image_size=[8, 5]),
            lambda p: p["source"].update(selected_object={"id": "other"}),
            lambda p: p["depth"].__setitem__(0, float("nan")),
            lambda p: p["depth"].__setitem__(0, 0),
            lambda p: p["assumptions"].update(horizontal_fov_degrees=180),
        ):
            parent = json.loads(json.dumps(self.parent))
            mutate(parent)
            with self.subTest(parent=parent), self.assertRaises(worker.Refused):
                worker.validate_parent(parent, worker.file_sha(self.image), (7, 5))

    def test_pose_uses_ordinary_mask_covered_median_and_model_z_height(self):
        outline, _ = self.validate()
        outline["coveredGridIndices"] = [1, 4, 5, 9]
        self.parent["depth"] = [5, 2, 5, 5, 3, 4, 5, 5, 5, 5, 5, 5]
        pose = worker.initial_pose(self.parent, outline, [[-2, -8, -1], [4, 4, 1]])
        self.assertEqual(pose["position"][2], -3.5)
        self.assertEqual(pose["modelPivot"], [1, -2, 0])
        self.assertEqual(pose["quaternion"], [-.5, -.5, -.5, .5])
        self.assertGreater(pose["scale"], 0)

    def test_pose_bounds_inclusive_and_no_clamping(self):
        outline, _ = self.validate()
        self.parent["assumptions"]["horizontal_fov_degrees"] = 90
        self.parent["depth"] = [10.] * 12
        base = worker.initial_pose(self.parent, outline, [[0, 0, 0], [1, 1, 2]])
        self.assertEqual(base["position"][2], -10)
        height = base["scale"] * 2
        for scale in (.05, 5):
            # Freeze tan(45deg) at its actual binary64 value in both formulas.
            pose = worker.initial_pose(self.parent, outline, [[0, 0, 0], [1, 1, height / scale]])
            self.assertAlmostEqual(pose["scale"], scale)
        for h in (height / .049, height / 5.01):
            with self.assertRaisesRegex(worker.Refused, "scene bounds"):
                worker.initial_pose(self.parent, outline, [[0, 0, 0], [1, 1, h]])
        self.parent["depth"] = [10.001] * 12
        with self.assertRaisesRegex(worker.Refused, "scene bounds"):
            worker.initial_pose(self.parent, outline, [[0, 0, 0], [1, 1, 2]])

    def test_glb_internal_single_mesh_stored_bounds_and_linear_colours(self):
        vertices = [[-1.00000001, 0, -1], [1, 0, -1], [0, 1, 1]]
        glb, bounds = worker.make_glb(vertices, FACES, COLORS)
        self.assertEqual(struct.unpack("<4sII", glb[:12]), (b"glTF", 2, len(glb)))
        length, kind = struct.unpack("<I4s", glb[12:20])
        self.assertEqual(kind, b"JSON")
        document = json.loads(glb[20:20 + length])
        self.assertEqual(bounds[0][0], -1.)
        self.assertEqual(document["accessors"][0]["min"], bounds[0])
        self.assertEqual(len(document["meshes"]), 1)
        self.assertEqual(document["meshes"][0]["primitives"][0]["mode"], 4)
        self.assertFalse(any(key in document for key in ("extensionsUsed", "images", "animations", "skins")))
        self.assertNotIn("uri", document["buffers"][0])
        binary = glb[28 + length:]
        color_offset = document["bufferViews"][1]["byteOffset"]
        self.assertEqual(struct.unpack_from("<3f", binary, color_offset), (.25, .5, 1.))
        self.assertEqual(struct.unpack_from("<3I", binary, document["bufferViews"][2]["byteOffset"]), (0, 1, 2))

    def test_glb_invalid_geometry_rejected(self):
        for v, f, c in (([], FACES, COLORS), (VERTICES, [[0, 1, 3]], COLORS),
                        (VERTICES, FACES, [[2, 0, 0]] * 3),
                        ([[float("nan"), 0, 0]] * 3, FACES, COLORS)):
            with self.subTest(v=v, f=f), self.assertRaises(worker.Refused):
                worker.make_glb(v, f, c)

    def test_build_receipt_exact_bytes_inputs_and_single_injected_generation(self):
        calls = []
        def generate(image):
            calls.append(image.size)
            return VERTICES, FACES, COLORS
        receipt = self.build(generate)
        self.assertEqual(len(calls), 1)
        self.assertEqual({p.name for p in self.output.iterdir()}, {"object.json", "object.glb"})
        self.assertEqual(json.loads((self.output / "object.json").read_text()), receipt)
        self.assertEqual(receipt["sha256"], worker.file_sha(self.output / "object.glb"))
        self.assertEqual(receipt["bytes"], (self.output / "object.glb").stat().st_size)
        self.assertEqual(receipt["input"], {"sourceSha256": worker.file_sha(self.image),
            "outlineSha256": worker.file_sha(self.mask), "parentSurfaceSha256": worker.file_sha(self.parent_path)})
        self.assertEqual(receipt["model"], worker.MODEL)

    def test_nonempty_output_and_changed_input_fail_without_overwrite(self):
        sentinel = self.output / "object.glb"
        sentinel.write_bytes(b"existing")
        with self.assertRaises(worker.Refused):
            self.build()
        self.assertEqual(sentinel.read_bytes(), b"existing")
        sentinel.unlink()
        def generate(_):
            self.mask.write_bytes(b"changed")
            return VERTICES, FACES, COLORS
        with self.assertRaises(worker.Refused):
            self.build(generate)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_generator_and_pose_refusal_leave_no_partial_candidate(self):
        def broken(_):
            raise worker.Refused("geometry")
        with self.assertRaises(worker.Refused):
            self.build(broken)
        with self.assertRaises(worker.Refused):
            self.build(lambda _: ([[0, 0, 0], [1, 0, 0], [0, 1, 0]], FACES, COLORS))
        self.assertEqual(list(self.output.iterdir()), [])

    def test_failed_second_output_write_removes_only_own_file(self):
        original = Path.open
        def fail(path, *args, **kwargs):
            if path == self.output / "object.json":
                raise OSError("synthetic disk failure")
            return original(path, *args, **kwargs)
        with patch.object(Path, "open", fail), self.assertRaisesRegex(worker.Refused, "could not be saved"):
            self.build()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_guarded_forward_and_no_second_attempt_or_fallback(self):
        class Torch:
            no_grad = staticmethod(contextlib.nullcontext)
        class Model:
            def __init__(self, repeat=False):
                self.entries, self.repeat = 0, repeat
                self.renderer = self
            def set_chunk_size(self, size):
                self.chunk = size
            def forward(self, images, device):
                self.entries += 1
                return "codes"
            def __call__(self, *args, **kwargs):
                return self.forward(*args, **kwargs)
            def extract_mesh(self, codes, colors, resolution):
                self.resolution = resolution
                if self.repeat:
                    self.forward([], device="cpu")
                return ["mesh"]
        model = Model()
        self.assertEqual(worker.infer_once(model, "image", Torch), ["mesh"])
        self.assertEqual((model.entries, model.chunk, model.resolution), (1, 8192, 256))
        model = Model(repeat=True)
        with self.assertRaises(worker.Refused):
            worker.infer_once(model, "image", Torch)
        self.assertEqual(model.entries, 1)

    def test_missing_pins_refuse_without_model_import(self):
        with patch.dict(worker.os.environ, {}, clear=True), self.assertRaises(worker.Refused):
            worker.generate_mesh(None)
        self.assertNotIn("torch", sys.modules)


if __name__ == "__main__":
    unittest.main()
