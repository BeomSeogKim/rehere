# Photo surface reconstruction

An offline command that turns one local JPEG or PNG photograph and a
rectangular object box into editable visible surfaces. Depth Anything V2 Small
proposes relative depth; SAM2 Tiny proposes an object mask inside the box. The
output loads with the scene builder in
[`photo-scene.js`](../public/photo-scene.js).

The command does not fetch URLs, check source permissions, or isolate jobs.
The caller must confirm that the person allowed model processing and must give
each job its own output directory.

## Setup

Python 3.12 in an isolated environment:

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

```sh
.venv/bin/python reconstruct.py --image photo.jpg --output jobs/JOB_ID \
  --source-id 3f2b6c1e-8d4a-4b7e-9c2f-1a2b3c4d5e6f --box 490 450 982 781
```

`--box X1 Y1 X2 Y2` is in pixels of the image as stored, before any EXIF
rotation, and must satisfy `0 <= X1 < X2 <= width` and `0 <= Y1 < Y2 <= height`.
`--output` must be an empty or absent directory whose parent exists; existing
files are never overwritten.

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
| `mask.png` | Binary mask at the source resolution |
| `mask-overlay.jpg` | Mask tinted over the texture for review |
| `surface.json` | Surface grid for the scene builder |
| `summary.json` | Hashes, box, orientation, coverage, devices, timings, model revisions |

`summary.json` is written last; its absence means the output set is incomplete.
`surface.json` records the source ID, the SHA-256 of the original input bytes,
the texture's SHA-256, the image size, and the box as object `foreground`.
The original file is not copied; the caller keeps it.

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
- A mask covering under 1% or over 60% of the grid is rejected, as is any
  result where the scene builder would keep no foreground or no background
  triangle after its mask-boundary and depth-span rules. Non-finite or
  constant depth is rejected.
- Depth and mask are model proposals, not confirmed observations of the place.
  Only photographed surfaces exist: there is no closed room, no background fill,
  no object back faces, and no multi-view alignment. Large viewpoint changes
  show distortion and gaps. Triangles across the mask boundary or spanning more
  than 0.35 units of depth are omitted by the scene builder.
- Transformers prints a `sam2_video` to `sam2` configuration advisory for the
  official SAM2 checkpoint; inspect the overlay.

## Tests

The tests cover argument, box, image, grid, depth-range, and mask checks and do
not load models:

```sh
.venv/bin/python -m unittest -v test_reconstruct
```

## Sources

- [Depth Anything V2 Small](https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf)
- [SAM2.1 Hiera Tiny](https://huggingface.co/facebook/sam2.1-hiera-tiny)
- [Pillow decompression bomb protection](https://pillow.readthedocs.io/en/stable/reference/Image.html#PIL.Image.open)
