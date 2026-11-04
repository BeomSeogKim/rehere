import copy
import hashlib
import importlib.abc
import json
from pathlib import Path
import sys
import tempfile
import unittest

from correct_outline import Rejected, corrected_files, main, triangle_counts

try:
    from PIL import Image
except ImportError:
    Image = None


@unittest.skipUnless(Image, "Pillow is required")
class OutlineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / "input"
        self.input.mkdir()
        self.objects = [{"id": f"object-{i}", "label": name, "box_xyxy": box} for i, name, box in (
            (1, "Counter", [4, 6, 24, 42]), (2, "Sacks", [36, 6, 62, 42]))]
        self.regions = []
        for y in range(24):
            for x in range(32):
                self.regions.append((1 if 3 <= x <= 10 else 2 if 21 <= x <= 28 else 0) if 4 <= y <= 19 else 0)
        texture = self.input / "texture.jpg"
        Image.new("RGB", (64, 48), (90, 120, 150)).save(texture)
        Image.new("L", (32, 24), 127).save(self.input / "depth-preview.png")
        self.surface = {
            "schema_version": 2,
            "source": {"source_id": "synthetic", "sha256": "a" * 64, "image_size": [64, 48],
                       "texture": {"file": "texture.jpg", "sha256": hashlib.sha256(texture.read_bytes()).hexdigest()},
                       "selected_objects": self.objects},
            "objects": self.objects, "width": 32, "height": 24, "depth": [3] * 768, "regions": self.regions,
            "assumptions": {"horizontal_fov_degrees": 55, "near": 2, "far": 5, "max_triangle_depth_span": 0.35},
        }
        self.request = {"targetId": "object-1", "objects": self.objects, "regions": list(self.regions)}
        for y in range(5, 19):
            self.request["regions"][y * 32 + 11] = 1
        self.save_parent()

    def save_parent(self):
        (self.input / "surface.json").write_text(json.dumps(self.surface))

    def test_exact_mask_summary_and_immutable_inputs(self):
        before = {p.name: p.read_bytes() for p in self.input.iterdir()}
        files = corrected_files(self.input, self.request)
        self.assertEqual(set(files), {"texture.jpg", "depth-preview.png", "surface.json", "mask.png", "mask-overlay.jpg", "summary.json"})
        self.assertEqual({p.name: p.read_bytes() for p in self.input.iterdir()}, before)
        for name in ("texture.jpg", "depth-preview.png"):
            self.assertEqual(files[name], before[name])
        surface = json.loads(files["surface.json"])
        self.assertEqual(surface["depth"], self.surface["depth"])
        self.assertEqual(surface["assumptions"], self.surface["assumptions"])
        self.assertEqual(surface["regions"], self.request["regions"])
        self.assertEqual(surface["objects"][1], self.objects[1])
        self.assertEqual(surface["outline"], {"kind": "owner-corrected"})
        import io
        mask = Image.open(io.BytesIO(files["mask.png"]))
        grid = Image.frombytes("L", (32, 24), bytes({-1: 63, 0: 0, 1: 127, 2: 255}[r] for r in self.request["regions"]))
        self.assertEqual(mask.tobytes(), grid.resize((64, 48), Image.Resampling.NEAREST).tobytes())
        summary = json.loads(files["summary.json"])
        self.assertEqual(summary["objects"][0]["coverage"], self.request["regions"].count(1) / 768)
        self.assertEqual(summary["objects"][1]["triangles"], triangle_counts(surface)[2])
        self.assertEqual(summary["background_triangles"], triangle_counts(surface)[0])
        self.assertEqual(summary["overlap"], {"pixels": 0, "ratio": 0})
        self.assertNotIn("models", summary)
        self.assertNotIn("parentJobId", files["surface.json"].decode())

    def test_target_removal_becomes_context_and_other_labels_stay(self):
        self.request["regions"] = list(self.regions)
        for y in range(4, 20):
            self.request["regions"][y * 32 + 3] = 0
        result = json.loads(corrected_files(self.input, self.request)["surface.json"])
        self.assertEqual(result["regions"], self.request["regions"])
        for i, label in enumerate(self.regions):
            if label == 2:
                self.assertEqual(result["regions"][i], 2)

    def test_void_retained_or_explicitly_added_never_silently_context(self):
        self.regions[48] = -1
        self.save_parent()
        self.request["regions"][48] = -1
        summary = json.loads(corrected_files(self.input, self.request)["summary.json"])
        self.assertEqual(summary["overlap"]["pixels"], 4)
        self.assertAlmostEqual(summary["overlap"]["ratio"], 4 / 516)
        self.request["regions"][48] = 0
        with self.assertRaises(Rejected):
            corrected_files(self.input, self.request)
        self.request["regions"][48] = 1
        summary = json.loads(corrected_files(self.input, self.request)["summary.json"])
        self.assertEqual(summary["overlap"], {"pixels": 0, "ratio": 0})

    def test_preserves_frozen_coverage_overlap_and_triangle_gates(self):
        cases = []
        erased = [0 if r == 1 else r for r in self.regions]
        cases.append(erased)
        oversized = [1 if r == 0 else r for r in self.regions]
        cases.append(oversized)
        tiny = [0 if r == 1 else r for r in self.regions]
        for y in range(4, 7):
            for x in range(3, 6):
                tiny[y * 32 + x] = 1
        cases.append(tiny)
        for regions in cases:
            with self.subTest(regions=regions.count(1)), self.assertRaises(Rejected):
                corrected_files(self.input, {**self.request, "regions": regions})
        self.regions[48] = self.regions[49] = -1
        self.save_parent()
        self.request["regions"][48] = self.request["regions"][49] = -1
        with self.assertRaises(Rejected):
            corrected_files(self.input, self.request)

    def test_rejects_noop_new_void_and_unrelated_object_changes(self):
        for regions in [self.regions, [-1] + self.regions[1:], [0 if r == 2 else r for r in self.regions]]:
            with self.subTest(), self.assertRaises(Rejected):
                corrected_files(self.input, {**self.request, "regions": regions})

    def test_loads_no_inference_dependencies_and_is_deterministic(self):
        class RefuseInference(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname.split(".")[0] in {"numpy", "torch", "transformers", "reconstruct"}:
                    raise AssertionError(f"inference import: {fullname}")
        guard = RefuseInference()
        sys.meta_path.insert(0, guard)
        try:
            self.assertEqual(corrected_files(self.input, self.request), corrected_files(self.input, copy.deepcopy(self.request)))
        finally:
            sys.meta_path.remove(guard)

    def test_cli_writes_only_complete_fixed_assets_and_refuses_overwrite(self):
        request = self.root / "request.json"
        request.write_text(json.dumps(self.request))
        output = self.root / "output"
        args = ["--input", str(self.input), "--request", str(request), "--output", str(output)]
        self.assertEqual(main(args), 0)
        self.assertEqual(sorted(p.name for p in output.iterdir()), sorted(corrected_files(self.input, self.request)))
        before = {p.name: p.read_bytes() for p in output.iterdir()}
        self.assertEqual(main(args), 5)
        self.assertEqual({p.name: p.read_bytes() for p in output.iterdir()}, before)

    def legacy(self, box=(6, 8, 28, 40)):
        from PIL import ImageDraw
        self.surface.pop("schema_version", None)
        self.surface.pop("objects", None)
        self.surface["source"].pop("selected_objects", None)
        self.surface["source"]["selected_object"] = {"id": "foreground", "box_xyxy": [6, 8, 22, 40]}
        self.surface["foreground"] = [int(r == 1) for r in self.surface.pop("regions", self.regions)]
        mask = Image.new("L", (64, 48))
        ImageDraw.Draw(mask).rectangle((box[0], box[1], box[2] - 1, box[3] - 1), fill=255)
        mask.save(self.input / "outline.png")
        self.save_parent()
        (self.input / "summary.json").write_text(json.dumps({"models": {"depth": {"id": "synthetic-depth"}}}))
        foreground = [int(mask.getpixel((int(x * 63 / 31 + .5), int(y * 47 / 23 + .5))) != 0)
                      for y in range(24) for x in range(32)]
        return {"kind": "legacy-outline-repair", "box": list(box), "foreground": foreground,
                "maskSha256": hashlib.sha256((self.input / "outline.png").read_bytes()).hexdigest()}

    def test_legacy_exact_confirmed_mask_grid_and_parent_invariance(self):
        request = self.legacy()
        before = {p.name: p.read_bytes() for p in self.input.iterdir()}
        files = corrected_files(self.input, request)
        surface = json.loads(files["surface.json"])
        self.assertNotIn("schema_version", surface)
        self.assertEqual(surface["foreground"], request["foreground"])
        self.assertEqual(surface["depth"], self.surface["depth"])
        self.assertEqual(surface["assumptions"], self.surface["assumptions"])
        self.assertEqual(surface["source"]["selected_object"]["box_xyxy"], request["box"])
        self.assertEqual(files["mask.png"], before["outline.png"])
        for name in ("texture.jpg", "depth-preview.png"):
            self.assertEqual(files[name], before[name])
        summary = json.loads(files["summary.json"])
        self.assertEqual(summary["models"], {"depth": {"id": "synthetic-depth"}})
        self.assertEqual(summary["foreground_triangles"], triangle_counts(surface)[1])
        self.assertEqual(summary["mask_coverage"], sum(request["foreground"]) / 768)
        self.assertEqual({p.name: p.read_bytes() for p in self.input.iterdir()}, before)
        self.request = request
        self.test_loads_no_inference_dependencies_and_is_deterministic()

    def test_legacy_retains_single_object_coverage_and_depth_gates(self):
        for box in [(0, 0, 64, 48), (0, 0, 3, 3)]:
            with self.subTest(box=box), self.assertRaises(Rejected):
                corrected_files(self.input, self.legacy(box))
        request = self.legacy()
        self.surface["depth"] = [3 if i % 2 else 5 for i in range(768)]
        self.save_parent()
        with self.assertRaises(Rejected):
            corrected_files(self.input, request)

    def test_legacy_rejects_mismatched_mask_grid_schema_and_noop(self):
        request = self.legacy()
        for changed in [{"maskSha256": "0" * 64}, {"foreground": [0] * 768}]:
            with self.subTest(changed=changed), self.assertRaises(Rejected):
                corrected_files(self.input, {**request, **changed})
        self.surface["foreground"] = request["foreground"]
        self.save_parent()
        with self.assertRaises(Rejected):
            corrected_files(self.input, request)
        self.surface["schema_version"] = 1
        self.save_parent()
        with self.assertRaises(Rejected):
            corrected_files(self.input, request)

    def test_legacy_rejects_nonbinary_transparent_and_wrong_size_masks(self):
        request = self.legacy()
        for size, colour in [((64, 48), (128, 128, 128, 255)), ((64, 48), (255, 255, 255, 0)), ((63, 48), (255, 255, 255, 255))]:
            Image.new("RGBA", size, colour).save(self.input / "outline.png")
            changed = {**request, "maskSha256": hashlib.sha256((self.input / "outline.png").read_bytes()).hexdigest()}
            with self.subTest(size=size, colour=colour), self.assertRaises(Rejected):
                corrected_files(self.input, changed)


if __name__ == "__main__":
    unittest.main()
