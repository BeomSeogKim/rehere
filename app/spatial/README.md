# Photo surface reconstruction

An offline command that turns one local JPEG or PNG photograph and a
rectangular object box into editable visible surfaces. Depth Anything V2 Small
proposes relative depth; SAM2 Tiny proposes an object mask inside the box. The
output loads with the scene builder in
[`photo-scene.js`](../public/photo-scene.js). With `--objects` it instead
segments exactly two named objects; see [two objects](../OBJECTS.md) for the
confirmation and editing flow around that output.

The command does not fetch URLs, check source permissions, or isolate jobs.
The caller must confirm that the person allowed model processing and must give
each job its own output directory.

## Photo checking only

Saving owner photographs needs Pillow, without reconstruction models or
weights. Keep an existing suitable environment, or create one from the
repository root with `uv` and Python 3.12 available:

```sh
uv venv --python 3.12 app/spatial/.venv
uv pip install --python app/spatial/.venv/bin/python pillow==13.0.0
```

This uses the Pillow version pinned in `requirements.txt`. The app uses
`app/spatial/.venv/bin/python` by default; `PHOTO_PYTHON` can select another
Python environment with Pillow. Restart the server after changing that
setting, then save again. Text-only input needs neither Python nor weights.
Recording checks separately need FFmpeg.

This recipe enables owner photo checking, not reconstruction or every
contributor/model image helper. For those, use the full environment below.

## Reconstruction setup

Run from the repository root. If the photo-checking environment already
exists, skip its creation and install the full requirements into it:

```sh
cd app/spatial
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

The command loads models only from the local Hugging Face cache and never
downloads. Populate the cache once, on a machine allowed to download about
255 MB of public weights:

```sh
.venv/bin/hf download depth-anything/Depth-Anything-V2-Small-hf \
  --revision 5426e4f0f36572d16453bbda7a8389317b1bef99 \
  --include "*.json" --include model.safetensors
.venv/bin/hf download facebook/sam2.1-hiera-tiny \
  --revision de431c4043854a71d8101e17995dfe596bf101a5 \
  --include "*.json" --include model.safetensors
```

Both checkpoints are Apache-2.0 safetensors files loaded without remote code
or account tokens. Set `HF_HUB_CACHE` if the cache lives elsewhere.

## Usage

These commands run from `app/spatial`, as above. Use your permitted image
and a fresh job directory; its parent must exist:

```sh
mkdir -p jobs
.venv/bin/python reconstruct.py --image photo.jpg --output jobs/JOB_ID \
  --source-id 3f2b6c1e-8d4a-4b7e-9c2f-1a2b3c4d5e6f --box 490 450 982 781
```

`--box X1 Y1 X2 Y2` is in pixels of the image as stored, before any EXIF
rotation, and must satisfy `0 <= X1 < X2 <= width` and `0 <= Y1 < Y2 <= height`.
`--output` must be an empty or absent directory whose parent exists; existing
files are never overwritten.

For two objects, replace `--box` with `--objects` (the two are mutually
exclusive):

```sh
.venv/bin/python reconstruct.py --image photo.jpg --output jobs/JOB_ID \
  --source-id 3f2b6c1e-8d4a-4b7e-9c2f-1a2b3c4d5e6f \
  --objects '[{"label": "Chair", "box": [195, 385, 415, 700]},
             {"label": "Counter", "box": [565, 445, 905, 685]}]'
```

The JSON lists exactly two `{label, box}` entries. Labels must already be
trimmed, non-blank, at most 80 UTF-16 units, free of control characters and
different ignoring case; they are returned unchanged as `object-1` and
`object-2` in that order. Boxes follow the `--box` rules and may overlap.

Exit codes: `0` success, `2` invalid arguments, image, or output path, `3`
missing dependency or cached weights, `4` unusable model proposal (choose a
different box or photograph), `5` an output file could not be written (for
example a permission or disk-space error). Errors are one `error:` line on
standard error. After exit `5` the directory may hold some outputs but no
`summary.json`; discard it and retry with an empty directory.

## Outputs

| File | Content |
|---|---|
| `texture.jpg` | RGB re-encode of the decoded pixels without EXIF, ICC, or text metadata |
| `depth-preview.png` | Normalized depth on the surface grid |
| `mask.png` | Mask at the source resolution: binary, or for two objects 0 background, 63 unassigned, 127 object 1, 255 object 2 |
| `mask-overlay.jpg` | Mask tinted over the texture for review; two objects get two tints, outlines and white unassigned pixels, with no text |
| `surface.json` | Surface grid for the scene builder |
| `summary.json` | Hashes, box, orientation, mask coverage, surviving foreground/background triangles, devices, timings, model revisions |

`summary.json` is written last; its absence means the output set is incomplete.
`surface.json` records the source ID, the SHA-256 of the original input bytes,
the texture's SHA-256, the image size, and the box as object `foreground`.
The original file is not copied; the caller keeps it.

A two-object run writes `surface.json` with `schema_version: 2`: `objects`
and `source.selected_objects` hold each ID, label and box, and `regions` gives
every grid cell `-1` (unassigned), `0` (background), `1` or `2` instead of a
binary `foreground`. `summary.json` adds per-object coverage and triangle
counts, background triangles, the overlap pixel count and full-precision ratio,
and the `mask.png` legend. A single-object summary records `mask_coverage`,
`foreground_triangles` and `background_triangles` beside its unchanged binary
`foreground` surface.

## Method and limits

- Only JPEG and PNG are accepted, up to 32 million pixels; the size is read
  from the header before decoding. Images with height/width outside 1/128 to 4
  are rejected because the surface grid would be degenerate or too large.
  PNG transparency is discarded.
- EXIF orientation is not applied, so box coordinates match the stored pixels.
  A phone photo stored sideways stays sideways; `summary.json` records the
  orientation tag and a warning is printed. Rotate the image before calling if
  an upright result is needed.
- Depth uses MPS when available and CPU otherwise; SAM2 runs on CPU. Inference
  is sequential with no retries.
- The 2nd-98th percentiles of relative inverse depth map to pseudo-depth from 2
  to 5 arbitrary units on a 256-column grid with a 55-degree horizontal field of
  view. This is not metric or calibrated depth.
- A single-object mask covering over 60% of the grid is rejected. Its foreground
  must keep at least 32 triangles and its background at least one after the
  scene builder's mask-boundary and depth-span rules; there is no lower
  percentage requirement. Non-finite or constant depth is rejected.
- Two objects: depth runs once and SAM2 once with both boxes. Pixels in both
  masks become unassigned rather than background; an overlap above 1% of the
  smaller mask is rejected. An unassigned pixel also unassigns every grid node
  of the cells it touches, so no drawn triangle covers it. Each object must
  cover 1-50% of the grid, both together at most 60%, and each object and the
  background must keep at least 32 renderable triangles. The outlines are model
  proposals: a person must confirm both objects before the app uses them.
- Depth and mask are model proposals, not confirmed observations of the place.
  Only photographed surfaces exist: there is no closed room, no background fill,
  no object back faces, and no multi-view alignment. Large viewpoint changes
  show distortion and gaps. Triangles across the mask boundary or spanning more
  than 0.35 units of depth are omitted by the scene builder.
- Transformers prints a `sam2_video` to `sam2` configuration advisory for the
  official SAM2 checkpoint; inspect the overlay.

## Hosted-planning thumbnail

`prepare_model_image.py` prepares the whole selected photograph for a hosted
planner without loading depth or segmentation models:

```sh
.venv/bin/python prepare_model_image.py --image photo.jpg \
  --box 490 450 982 781 > thumbnail.jpg
```

The box is validated against the stored pixels, but does not crop the image.
The metadata-free RGB JPEG keeps that pixel orientation, has a long edge of at
most 1024 pixels and is capped at 1 MiB. Small images are not enlarged. Inputs
are limited to 20 MiB and the reconstruction decoder's image bounds. Standard
output contains only JPEG bytes; errors use standard error and leave standard
output empty. The helper needs Pillow, makes no network calls and does not
receive API credentials. The caller remains responsible for permissions and
explicit consent before transmission.

## Tests

The tests cover argument, box, image, grid, depth-range, mask, two-object
argument, overlap, unassigned-pixel and region checks and do not load models:

```sh
.venv/bin/python -m unittest -v test_reconstruct test_prepare_model_image
```

## Sources

- [Depth Anything V2 Small](https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf)
- [SAM2.1 Hiera Tiny](https://huggingface.co/facebook/sam2.1-hiera-tiny)
- [Pillow decompression bomb protection](https://pillow.readthedocs.io/en/stable/reference/Image.html#PIL.Image.open)
