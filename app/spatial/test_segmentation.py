"""SAM 3.1 selection files: what the worker accepts before any mask is used.

Synthetic masks only, encoded with the pinned parser's own one_bit encoder.
No model, network or provider output is involved.
"""
import builtins
import contextlib
import io
import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import numpy as np

import reconstruct

WIDTH, HEIGHT = 10, 8
OBJECTS = [
    {"id": "object-1", "label": "rocking chair", "box_xyxy": [1.0, 1.0, 5.0, 4.0]},
    {"id": "object-2", "label": "wicker chest", "box_xyxy": [6.0, 2.0, 10.0, 8.0]},
]
RULE = "owner box vs returned instance box: IoU >= 0.5 and runner-up at least 0.15 lower; otherwise refused"


def one_bit(raster, width, height):
    from meta_sam_parser import _mask_codec
    return _mask_codec._encode_raster(list(raster), width, height)


def record(number, box, raster=None, size=(WIDTH, HEIGHT), mask_size=None):
    x1, y1, x2, y2 = box
    width, height = mask_size or (x2 - x1 + 1, y2 - y1 + 1)
    raster = raster if raster is not None else [1] * (width * height)
    return (f"{number}<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={size[0]};h={size[1]};c=0.9|>"
            f"<|mask;x=0;y=0;c=0.9;data={height},{width},{one_bit(raster, width, height)}|>")


def entry(item, number, box, **overrides):
    x1, y1, x2, y2 = box
    selection = {"rule": RULE, "ownerBox": item["box_xyxy"], "instances": 2, "selectedInstance": number,
                 "selectedBox": [x1, y1, x2 + 1, y2 + 1], "iou": 0.9, "runnerUpIou": None, "modelConfidence": 0.9}
    provenance = {"id": item["id"], "mode": "recorded", "responseId": "resp_synthetic", "requestDigest": "0" * 64,
                  "recordedAt": "2026-11-04T00:00:00.000Z", "selection": selection}
    value = {"id": item["id"], "prompt": item["label"], "record": record(number, box), "provenance": provenance}
    value.update(overrides)
    return value


def document(*entries):
    return {"model": "sam-3.1", "label": "SAM 3.1 (Meta Model API)", "objects": list(entries)}


GOOD_BOXES = [(3, [1, 1, 4, 3]), (5, [6, 2, 9, 7])]


def good():
    return document(*(entry(item, number, box) for item, (number, box) in zip(OBJECTS, GOOD_BOXES)))


class SegmentationFileTests(unittest.TestCase):
    def load(self, data, raw=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "segmentation.json"
            path.write_bytes(raw if raw is not None else json.dumps(data).encode())
            return reconstruct.load_segmentation(path, OBJECTS, WIDTH, HEIGHT)

    def test_places_each_selected_mask_at_its_box_and_returns_provenance(self):
        masks, provenance = self.load(good())
        self.assertEqual([mask.shape for mask in masks], [(HEIGHT, WIDTH)] * 2)
        expected = np.zeros((HEIGHT, WIDTH), bool)
        expected[1:4, 1:5] = True
        np.testing.assert_array_equal(masks[0], expected)
        self.assertEqual(int(masks[1].sum()), 4 * 6)
        self.assertEqual([item["selection"]["selectedInstance"] for item in provenance], [3, 5])

    def test_keeps_the_decoded_shape_not_the_box(self):
        raster = [0, 1, 1, 0] + [1, 1, 1, 1] + [0, 0, 0, 0]
        data = good()
        data["objects"][0]["record"] = record(3, [1, 1, 4, 3], raster=raster)
        masks, _ = self.load(data)
        self.assertEqual(int(masks[0].sum()), 6)
        self.assertFalse(masks[0][1, 1])

    def test_rejects_records_that_do_not_fit_this_photo(self):
        cases = {
            "another frame size": lambda d: d["objects"][0].update(record=record(3, [1, 1, 4, 3], size=(20, 16))),
            "box outside the photo": lambda d: d["objects"][1].update(record=record(5, [6, 2, 10, 7])),
            "raster unlike its box": lambda d: d["objects"][0].update(record=record(3, [1, 1, 4, 3], mask_size=(3, 3))),
            "two records": lambda d: d["objects"][0].update(record=record(3, [1, 1, 4, 3]) + "," + record(4, [1, 1, 4, 3])),
            "frame marker inside": lambda d: d["objects"][0].update(record="<0f>" + record(3, [1, 1, 4, 3])),
            "corrupt payload": lambda d: d["objects"][0].update(record=record(3, [1, 1, 4, 3])[:-6] + "zzzz|>"),
        }
        for name, change in cases.items():
            data = good()
            change(data)
            with self.subTest(name), self.assertRaises(reconstruct.InputError):
                self.load(data)

    def test_rejects_a_selection_other_than_the_record(self):
        cases = {
            "other instance": lambda s: s.update(selectedInstance=4),
            "other box": lambda s: s.update(selectedBox=[1, 1, 5, 5]),
            "other owner box": lambda s: s.update(ownerBox=[0.0, 0.0, 5.0, 4.0]),
        }
        for name, change in cases.items():
            data = good()
            change(data["objects"][0]["provenance"]["selection"])
            with self.subTest(name), self.assertRaises(reconstruct.InputError):
                self.load(data)

    def test_rejects_a_file_for_another_build(self):
        cases = {
            "other model": lambda d: d.update(model="sam-2"),
            "other label": lambda d: d.update(label="local model"),
            "extra key": lambda d: d.update(path="/etc/passwd"),
            "one object": lambda d: d["objects"].pop(),
            "swapped objects": lambda d: d["objects"].reverse(),
            "prompt is not the label": lambda d: d["objects"][0].update(prompt="Rocking chair"),
            "extra entry key": lambda d: d["objects"][0].update(file="mask.png"),
            "provenance for another object": lambda d: d["objects"][0]["provenance"].update(id="object-2"),
        }
        for name, change in cases.items():
            data = good()
            change(data)
            with self.subTest(name), self.assertRaises(reconstruct.InputError):
                self.load(data)

    def test_rejects_unreadable_or_oversized_files(self):
        for name, raw in (("not JSON", b"{"), ("too large", b" " * (reconstruct.MAX_SEGMENTATION_BYTES + 1))):
            with self.subTest(name), self.assertRaises(reconstruct.InputError):
                self.load(None, raw=raw)

    def test_never_prints_provider_text_when_a_record_fails(self):
        data = good()
        data["objects"][0]["record"] = record(3, [1, 1, 4, 3])[:-6] + "zzzz|>"
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), self.assertRaises(reconstruct.InputError) as caught:
            self.load(data)
        self.assertNotIn("zzzz", str(caught.exception) + stdout.getvalue() + stderr.getvalue())

    def test_missing_parser_is_an_unavailable_runtime(self):
        real_import = builtins.__import__

        def refuse(name, *args, **kwargs):
            if name == "meta_sam_parser":
                raise ImportError(name="meta_sam_parser")
            return real_import(name, *args, **kwargs)

        data = good()
        with unittest.mock.patch("builtins.__import__", refuse), self.assertRaises(reconstruct.UnavailableError):
            self.load(data)

    def test_segmentation_needs_two_objects(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            reconstruct.parse_args(["--image", "a.jpg", "--output", "out", "--source-id", "3f2b6c1e-8d4a-4b7e-9c2f-1a2b3c4d5e6f",
                                    "--box", "0", "0", "2", "2", "--segmentation", "s.json"])
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
