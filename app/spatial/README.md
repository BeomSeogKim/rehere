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

## Full-object estimate worker

`full_object.py` is a separate offline worker for a confirmed full-source
outline and a one-photo, one-object legacy parent surface. It does not check
permissions, publish jobs, or grant permission to run a model. The caller owns
source grants, immutable inputs, no-network process isolation, timeout, memory
supervision and atomic publication. Missing runtime or mismatched pins fail
without downloads or retries. Development tests use synthetic geometry only.

Pillow alone is sufficient for the model-free validator:

```sh
python app/spatial/full_object.py --validate-outline "$OUTLINE" \
  --width "$WIDTH" --height "$HEIGHT" \
  --grid-width "$GRID_WIDTH" --grid-height "$GRID_HEIGHT"
```

The outline path is absolute. PNG bytes are capped at 32 MiB and dimensions at
32 million pixels. A complete, single-frame PNG must decode to opaque pixels
with equal RGB channels at 0 or 255. Admitted formats are grayscale 1/2/4/8-bit,
RGB or RGBA 8/16-bit, and grayscale with alpha 16-bit, including Adam7
interlace. Admitted 16-bit samples use their high byte before binary
validation. Palette, 16-bit grayscale and 8-bit grayscale with alpha are
refused. Any transparent or nonbinary decoded pixel rejects, as do empty/full
masks. Success prints one JSON receipt with
`width`, `height`, `maskSha256`, exclusive `bounds`, `selectedPixels`,
`gridWidth`, `gridHeight` and strictly ascending `coveredGridIndices`.
Grid dimensions are at least two with at most 262144 nodes. Grid node `(i,j)`
maps to source pixel `floor(i*(W-1)/(GW-1)+.5)`,
`floor(j*(H-1)/(GH-1)+.5)`. An empty grid selection is valid validation output
but cannot produce an object. No source pixels leave the validator.

The separately admitted build command is:

```sh
python app/spatial/full_object.py --image "$ORIGINAL" --mask "$OUTLINE" \
  --parent-surface "$PARENT_SURFACE" --output "$EMPTY_OUTPUT_DIRECTORY"
```

Only `object.glb` and `object.json` are written into an existing empty output
directory. The receipt binds actual source, outline, parent and GLB hashes.
Inputs are rehashed before output. A successful worker is still an estimate,
not verified object identity, visual quality or historical geometry; the
application must independently validate and publish the result.

The exact foreground crop includes the maximum selected row and column.
Padding centres it in a square with floor-half on the leading side, then uses
`int(squareSize/.85)` with the same remainder placement. Binary alpha is
composited against `.5` gray, truncated to byte 127; no morphology or mask
inference is performed. The pinned model performs its own input resize.

Model loading is lazy. An already provisioned compatible CPU environment must
include PyTorch, NumPy, Pillow, OmegaConf, Transformers, Trimesh, the pinned
TripoSR dependencies and its compiled CPU torchmcubes extension. The photo
worker requirements are not a substitute for that separate environment.
Configure `FULL_OBJECT_TRIPOSR_SOURCE`, `FULL_OBJECT_MODEL_DIR` and
`FULL_OBJECT_DINO_CONFIG` to existing local files/directories. No private
machine paths belong in source. The worker verifies the source files at
TripoSR commit `107cefdc244c39106fa830359024f6a2f1c78871`, model revision
`5b521936b01fbe1890f6f9baed0254ab6351c04a`, checkpoint/config hashes and DINO
config revision `f205d5d8e640a89a2b8ef0369670dfc37cc07fc2` against embedded
hashes before loading and after extraction. Extra Python source in the
TripoSR package rejects. Its only DINO hub lookup resolves to the pinned
local config. Offline flags and forced weights-only loading are set before
model imports, the unsafe override is removed, and `torch.load` explicitly
uses `weights_only=True`. There is no unsafe fallback. Inference uses CPU
FP32, four intra-op threads and one inter-op thread, one guarded top-level
forward, chunk 8192 and extraction resolution 256.

The GLB contains one internal triangle mesh and linear vertex colours, with
no images, URIs, extensions, animation, skins or morphs, capped at 128 MiB.
No additional sRGB transfer is applied to the extractor's colours. Bounds
and pivot are computed from persisted float32 positions. Parent-grid depth
uses the ordinary median of all mask-covered node depths. Missing support
rejects. The exclusive outline bbox centre and height set estimated position
and uniform scale using the parent horizontal FOV. The model's +Z-up frame
maps by `(x,y,z) -> (y,z,x)`, quaternion `[-.5,-.5,-.5,.5]`. The child uses
`scale * R(vertex-modelPivot)` inside a group at `initial.position + offset`;
camera-Y yaw belongs to that group. Position components must be within
`[-10,10]` and scale within `[.05,5]`, inclusive; outside values reject without
clamping. These support limits do not establish physical validity or a floor
contact. Source-camera placement is nonmetric and has no claimed physical front.

Exit codes are 0 success, 2 unsupported input, 3 unavailable runtime,
4 unusable geometry/unsupported pose bounds and 5 output failure. Failures
have fixed public messages and no success JSON. Run the focused no-model
tests from `app/spatial` with `python -B -m unittest test_full_object`.

The supervisor's dummy-process tests also need `psutil`, pinned separately in
`requirements-test.txt` because no model or production photo path uses it.
Install both files, then run `python -B -m unittest test_full_object_supervisor
test_proof_publication`. Without `psutil` the supervisor test module cannot be
imported, so a requirements-only run does not cover it.

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

With `--objects`, `--segmentation FILE` replaces local SAM2 with outlines the
server already selected from SAM 3.1 (Meta Model API) responses. The worker
never calls an API: it reads one server-written JSON file (at most 16 MiB)
naming each object's prompt, its one selected record and its provenance,
checks that each record lies in this photo's frame, that its mask raster
matches its box, and that the recorded selection, owner box and object label
match, then decodes the mask with the pinned `meta-sam-parser`. That package
is imported only on this path and is listed in `requirements.txt` under its
SAM License (see the third-party notices). Parser diagnostics are never
printed, because they quote provider text. Depth still comes from the local
model, and `summary.json` then names `SAM 3.1 (Meta Model API)` as the mask
model and carries the selection. Run `python -B -m unittest test_segmentation`
for the focused checks; they use synthetic masks only.

The server side is off by default. `REHERE_SEGMENTATION=sam-3.1` plus either
`REHERE_SEGMENTATION_REPLAY=<file>` (stored responses, used only for a
byte-identical request; a mismatch sends nothing and fails) or
`REHERE_SEGMENTATION_LIVE=1` with `MODEL_API_KEY` enables it. Live requests are
reserved in `app/data/segmentation-budget.json` before sending, at $0.0025 per
image, and an uncertain request keeps its reservation. An incomplete setting
stops the server at startup. Stored response files contain provider output
and must stay private, outside Git.

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

`correct_outline.py` is a separate deterministic producer used by the server
for reviewed outline corrections. Its legacy one-foreground mode consumes an
already audited full-source binary PNG, preserves its exact bytes as
`mask.png`, and reuses the parent's depth, texture and depth preview. It maps
grid nodes with the audited outline validator's nearest source-pixel rule,
checks the existing single-object coverage and triangle limits, and writes a
complete new output set. It imports Pillow and the standard library only;
there is no depth, segmentation or object-model call. The server owns source,
grant, parent/version and hash checks and atomic child publication. This
worker does not approve an outline or replace the parent.

Run `python -B -m unittest test_correct_outline` for synthetic deterministic
correction tests, including unchanged schema-2 behavior and legacy gates.

The tests cover argument, box, image, grid, depth-range, mask, two-object
argument, overlap, unassigned-pixel and region checks and do not load models:

```sh
.venv/bin/python -m unittest -v test_reconstruct test_prepare_model_image
```

## Sources

- [Depth Anything V2 Small](https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf)
- [SAM2.1 Hiera Tiny](https://huggingface.co/facebook/sam2.1-hiera-tiny)
- [Pillow decompression bomb protection](https://pillow.readthedocs.io/en/stable/reference/Image.html#PIL.Image.open)
