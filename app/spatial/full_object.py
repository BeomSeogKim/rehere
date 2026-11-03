"""Offline object estimate and a separate Pillow-only outline validator."""
import argparse
from array import array
import contextlib
import hashlib
import io
import json
import math
import os
from pathlib import Path
import statistics
import struct
import sys


# Both CLI modes read runtime/source inputs without creating bytecode caches.
sys.dont_write_bytecode = True
MAX_PIXELS = 32_000_000
MAX_MASK_BYTES = 32 * 1024**2
MAX_GLB_BYTES = 128 * 1024**2
MODEL = {
    "id": "stabilityai/TripoSR",
    "revision": "5b521936b01fbe1890f6f9baed0254ab6351c04a",
    "checkpointSha256": "429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee",
}
CONFIG_SHA = "74ca708ce086bf68e97709ea6b3d91f14717921c04691e84043f0eb8fcc68e62"
DINO_REVISION = "f205d5d8e640a89a2b8ef0369670dfc37cc07fc2"
DINO_SHA = "b87c0270b97db085fd82cf114a761fd0f62ae7914fbd407c752a2260646b689c"
SOURCE_COMMIT = "107cefdc244c39106fa830359024f6a2f1c78871"
SOURCE_HASHES = {
    ".gitignore": "0d1298d99b9fc0bb1b2590e90bce9c6b90b3879ed531b8d8685f506099b62d96",
    "gradio_app.py": "966639162b0e54b8d02748968e77c90aec38bbc123aa5db2d1d81eb92fda9f80",
    "LICENSE": "ade0a66629bdd7e01e46b3296b3851cff0fd27989bca53da470ad6e96ed620fb",
    "README.md": "ed40f078c5e451c58eae716187e0128f0ce8575e467aab2440b4ed9c75e490b9",
    "requirements.txt": "741408247598c63e9f08cdb5f6fc753d78ac9185bb961cbe7ba8c5c0132aae48",
    "run.py": "bc1c124b3439f8ceb00ebd441848487ae7650af71053a80b266ae5db15784282",
    "tsr/bake_texture.py": "931d066c25d5943dc7b71469b63c308df3f37b8e7f6df558ee5e348d7936d5b7",
    "tsr/models/isosurface.py": "94c9a2ec27f8fe3c2fb57558ef28be253eb77074d2c171d49a41cf73d95d6f5e",
    "tsr/models/nerf_renderer.py": "afe8c12c964078b2c6bb3922d2e30969aa59f7edbacb8cb73d2c3df839dc785f",
    "tsr/models/network_utils.py": "b3d48e86be9ca3f3abc1bfd774f640fd350e4365843d804e2a3145e7692e1419",
    "tsr/models/tokenizers/image.py": "f6da23124dfabe6a1f8d0d27693d0cece6574de68be15487a77781b6a9d73195",
    "tsr/models/tokenizers/triplane.py": "44811fbd53013d6f49e229ecfd0717f89dd8ebeb71608aeb1f8e5ed1d5e8e378",
    "tsr/models/transformer/attention.py": "347c1a707257cb4eb664ebe9ecd16db7b6006131e74925c049245d2c0101ba7e",
    "tsr/models/transformer/basic_transformer_block.py": "ced8ce4c5c5bbc13368130bc15dee1717cc6bc7f35699f64d03aeec185b1198e",
    "tsr/models/transformer/transformer_1d.py": "fd83a71d59d04ef0a45dbadcc63f9d56d354ebc011a40f5589eb1786a1dd15f4",
    "tsr/system.py": "7aec93e421394ad7c746b6d63a0189532b57b26af9a199fc75ac3bb7c993c94f",
    "tsr/utils.py": "d9d1a645fef7ea489615bff3471fd01a4941a2c0e138c5dff5daae619563279b",
}
MESSAGES = {
    "input": "The source, outline or parent surface is not supported.",
    "unavailable": "The offline object worker is not available on this computer.",
    "geometry": "The object estimate has no usable geometry or source-camera pose.",
    "bounds": "The estimated object pose is outside the supported scene bounds.",
    "write": "The object output could not be saved to an empty directory.",
}


class Refused(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(MESSAGES[reason])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024**2), b""):
            digest.update(block)
    return digest.hexdigest()


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def finite(value):
    return type(value) in (float, int) and math.isfinite(value)


def dimensions(width, height, grid_width, grid_height):
    if (not integer(width, 1, MAX_PIXELS) or not integer(height, 1, MAX_PIXELS)
            or width * height > MAX_PIXELS
            or not integer(grid_width, 2, 262144) or not integer(grid_height, 2, 262144)
            or grid_width * grid_height > 262144):
        raise Refused("input")


def grid_pixels(width, height, grid_width, grid_height):
    # Integer arithmetic implements floor(endpoint + .5), without a float tie.
    for j in range(grid_height):
        y = (2 * j * (height - 1) + grid_height - 1) // (2 * (grid_height - 1))
        for i in range(grid_width):
            x = (2 * i * (width - 1) + grid_width - 1) // (2 * (grid_width - 1))
            yield x, y


def validate_outline(path, width, height, grid_width, grid_height):
    dimensions(width, height, grid_width, grid_height)
    if not Path(path).is_absolute() or Path(path).stat().st_size > MAX_MASK_BYTES:
        raise Refused("input")
    data = Path(path).read_bytes()
    if len(data) > MAX_MASK_BYTES:
        raise Refused("input")
    try:
        from PIL import Image
        from verify_owner_photo import png_chunks_complete
    except ImportError:
        raise Refused("unavailable") from None
    if not png_chunks_complete(data):
        raise Refused("input")
    try:
        with Image.open(io.BytesIO(data), formats=("PNG",)) as header:
            if (header.size != (width, height) or getattr(header, "n_frames", 1) != 1
                    or header.mode not in ("1", "L", "RGB", "RGBA")):
                raise Refused("input")
            header.verify()
        with Image.open(io.BytesIO(data), formats=("PNG",)) as image:
            image.load()
            rgba = image.convert("RGBA")
        mask = bytearray(width * height)
        count, x1, y1, x2, y2 = 0, width, height, 0, 0
        pixels = rgba.tobytes()
        for index in range(width * height):
            r, g, b, a = pixels[index * 4:index * 4 + 4]
            if a != 255 or r != g or r != b or r not in (0, 255):
                raise Refused("input")
            if r:
                mask[index] = 255
                count += 1
                y, x = divmod(index, width)
                x1, y1, x2, y2 = min(x1, x), min(y1, y), max(x2, x + 1), max(y2, y + 1)
        if count in (0, width * height):
            raise Refused("input")
    except Refused:
        raise
    except Exception:
        raise Refused("input") from None
    indices = [index for index, (x, y) in enumerate(grid_pixels(width, height, grid_width, grid_height))
               if mask[y * width + x]]
    return ({"width": width, "height": height, "maskSha256": sha(data),
             "bounds": [x1, y1, x2, y2], "selectedPixels": count,
             "gridWidth": grid_width, "gridHeight": grid_height, "coveredGridIndices": indices}, mask)


def validate_parent(parent, source_sha, size):
    source = parent.get("source", {})
    gw, gh = parent.get("width"), parent.get("height")
    dimensions(*size, gw, gh)
    if ("schema_version" in parent or "objects" in parent or "regions" in parent
            or source.get("sha256") != source_sha or source.get("image_size") != list(size)
            or source.get("selected_object", {}).get("id") != "foreground"):
        raise Refused("input")
    depth, foreground = parent.get("depth"), parent.get("foreground")
    assumptions = parent.get("assumptions", {})
    fov, near, far = (assumptions.get(key) for key in ("horizontal_fov_degrees", "near", "far"))
    if (not all(finite(value) for value in (fov, near, far)) or not 0 < fov < 180 or not 0 < near < far
            or not isinstance(depth, list) or len(depth) != gw * gh
            or not all(finite(d) and near <= d <= far for d in depth)
            or not isinstance(foreground, list) or len(foreground) != gw * gh
            or not all(type(v) is int and v in (0, 1) for v in foreground)
            or not 0 < sum(foreground) < gw * gh):
        raise Refused("input")


def preprocess(image, mask, bounds):
    from PIL import Image

    rgba = image.convert("RGB").convert("RGBA")
    rgba.putalpha(Image.frombytes("L", image.size, bytes(mask)))
    crop = rgba.crop(tuple(bounds))
    size = max(crop.size)
    padded_size = int(size / .85)
    square_offset = ((size - crop.width) // 2, (size - crop.height) // 2)
    outer = (padded_size - size) // 2
    padded = Image.new("RGB", (padded_size, padded_size), (127, 127, 127))
    # Binary alpha means the canonical float32 .5 composite truncates to 127.
    padded.paste(crop.convert("RGB"), (outer + square_offset[0], outer + square_offset[1]), crop.getchannel("A"))
    return padded


def initial_pose(parent, outline, bounds):
    indices = outline["coveredGridIndices"]
    if not indices:
        raise Refused("geometry")
    depth = statistics.median(parent["depth"][index] for index in indices)
    width, height = outline["width"], outline["height"]
    x1, y1, x2, y2 = outline["bounds"]
    low, high = bounds
    model_height = high[2] - low[2]
    if not finite(model_height) or model_height <= 0:
        raise Refused("geometry")
    t = math.tan(math.radians(parent["assumptions"]["horizontal_fov_degrees"]) / 2)
    position = [((x1 + x2) / (2 * width) - .5) * 2 * t * depth,
                (.5 - (y1 + y2) / (2 * height)) * 2 * t * depth * height / width, -depth]
    scale = ((y2 - y1) / height) * 2 * t * depth * (height / width) / model_height
    if not all(finite(value) for value in position + [scale]):
        raise Refused("geometry")
    if any(abs(value) > 10 for value in position) or not .05 <= scale <= 5:
        raise Refused("bounds")
    return {"position": position, "quaternion": [-.5, -.5, -.5, .5], "scale": scale,
            "modelPivot": [(a + b) / 2 for a, b in zip(low, high)]}


def make_glb(vertices, faces, colors):
    if not len(vertices) or not len(faces) or len(colors) != len(vertices):
        raise Refused("geometry")
    if 24 * len(vertices) + 12 * len(faces) > MAX_GLB_BYTES - 4096:
        raise Refused("geometry")
    positions, colour, indices = array("f"), array("f"), array("I")
    for vertex, color in zip(vertices, colors):
        if len(vertex) != 3 or len(color) != 3:
            raise Refused("geometry")
        values = [float(v) for v in vertex]
        rgb = [float(v) for v in color]
        if not all(math.isfinite(v) for v in values + rgb) or not all(0 <= v <= 1 for v in rgb):
            raise Refused("geometry")
        try:
            positions.extend(values)
        except OverflowError:
            raise Refused("geometry") from None
        colour.extend(rgb)
    if not all(math.isfinite(v) for v in positions):
        raise Refused("geometry")
    for face in faces:
        if len(face) != 3 or any(int(v) != v or not 0 <= v < len(vertices) for v in face):
            raise Refused("geometry")
        indices.extend(int(v) for v in face)
    # Pose bounds describe stored float32 positions, not pre-serialization values.
    bounds = [[fn(positions[axis::3]) for axis in range(3)] for fn in (min, max)]
    for values in (positions, colour, indices):
        if sys.byteorder != "little":
            values.byteswap()
    chunks = [positions.tobytes(), colour.tobytes(), indices.tobytes()]
    offsets = [0, len(chunks[0]), len(chunks[0]) + len(chunks[1])]
    binary = b"".join(chunks)
    document = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1}, "indices": 2, "mode": 4, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [{"buffer": 0, "byteOffset": offset, "byteLength": len(chunk)} for offset, chunk in zip(offsets, chunks)],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(vertices), "type": "VEC3", "min": bounds[0], "max": bounds[1]},
            {"bufferView": 1, "componentType": 5126, "count": len(vertices), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5125, "count": len(faces) * 3, "type": "SCALAR"}],
    }
    header = json.dumps(document, separators=(",", ":"), allow_nan=False).encode()
    header += b" " * (-len(header) % 4)
    total = 28 + len(header) + len(binary)
    if total > MAX_GLB_BYTES:
        raise Refused("geometry")
    return (struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(header), b"JSON")
            + header + struct.pack("<I4s", len(binary), b"BIN\0") + binary), bounds


def runtime_paths():
    try:
        source = Path(os.environ["FULL_OBJECT_TRIPOSR_SOURCE"]).resolve(strict=True)
        model = Path(os.environ["FULL_OBJECT_MODEL_DIR"]).resolve(strict=True)
        dino = Path(os.environ["FULL_OBJECT_DINO_CONFIG"]).resolve(strict=True)
        expected = {source / name: digest for name, digest in SOURCE_HASHES.items()}
        expected.update({model / "config.yaml": CONFIG_SHA, model / "model.ckpt": MODEL["checkpointSha256"], dino: DINO_SHA})
        # Namespace packages also import unlisted files; disallow extra executable source.
        if {p.relative_to(source).as_posix() for p in (source / "tsr").rglob("*.py")} != {p for p in SOURCE_HASHES if p.startswith("tsr/")}:
            raise Refused("unavailable")
        if any(file_sha(path) != digest for path, digest in expected.items()):
            raise Refused("unavailable")
        return source, model, dino
    except (KeyError, OSError):
        raise Refused("unavailable") from None


def generate_mesh(image):
    source, model_dir, dino = runtime_paths()
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "TORCH_FORCE_WEIGHTS_ONLY_LOAD"):
        os.environ[key] = "1"
    os.environ.pop("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", None)
    if any(name == "tsr" or name.startswith("tsr.") for name in sys.modules):
        raise Refused("unavailable")
    sys.path.insert(0, str(source))
    try:
        import torch
        from omegaconf import OmegaConf
        from tsr.system import TSR
        from tsr.models.tokenizers import image as tokenizer
    except ImportError:
        raise Refused("unavailable") from None

    def local_config(*, repo_id, filename, **kwargs):
        if repo_id != "facebook/dino-vitb16" or filename != "config.json":
            raise Refused("unavailable")
        if kwargs.get("revision", DINO_REVISION) != DINO_REVISION:
            raise Refused("unavailable")
        return str(dino)

    # The pinned tokenizer's sole hub call resolves to these verified local bytes.
    tokenizer.hf_hub_download = local_config
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    if torch.get_num_threads() != 4 or torch.get_num_interop_threads() != 1:
        raise Refused("unavailable")
    cfg = OmegaConf.load(model_dir / "config.yaml")
    OmegaConf.resolve(cfg)
    model = TSR(cfg)
    model.load_state_dict(torch.load(model_dir / "model.ckpt", map_location="cpu", weights_only=True))
    model.to(device="cpu", dtype=torch.float32).eval()
    tensors = list(model.parameters()) + list(model.buffers())
    if not tensors or any(t.device.type != "cpu" or (t.is_floating_point() and t.dtype != torch.float32) for t in tensors):
        raise Refused("unavailable")
    meshes = infer_once(model, image, torch)
    runtime_paths()
    mesh = meshes[0]
    # Trimesh stores the pinned extractor's model colours as bytes. Do not apply
    # an additional sRGB transform when carrying them into glTF-linear COLOR_0.
    colors = mesh.visual.vertex_colors[:, :3].astype("float32") / 255
    return mesh.vertices, mesh.faces, colors


def infer_once(model, image, torch):
    model.renderer.set_chunk_size(8192)
    forward, calls = model.forward, 0

    def once(*args, **kwargs):
        nonlocal calls
        if calls:
            raise Refused("geometry")
        calls += 1
        return forward(*args, **kwargs)

    model.forward = once
    with torch.no_grad():
        codes = model([image], device="cpu")
        meshes = model.extract_mesh(codes, True, resolution=256)
    if calls != 1 or len(meshes) != 1:
        raise Refused("geometry")
    return meshes


def build(image_path, mask_path, parent_path, output, generate=generate_mesh):
    output = Path(output)
    if not output.is_dir() or any(output.iterdir()):
        raise Refused("write")
    from verify_owner_photo import verify, Refused as PhotoRefused
    try:
        data, parent_data = Path(image_path).read_bytes(), Path(parent_path).read_bytes()
        if len(parent_data) > 32 * 1024**2:
            raise Refused("input")
        source_sha, parent_sha = sha(data), sha(parent_data)
        expect = "png" if data.startswith(b"\x89PNG") else "jpeg"
        size = verify(data, expect)
        parent = json.loads(parent_data)
        validate_parent(parent, source_sha, size)
        outline, mask = validate_outline(mask_path, *size, parent["width"], parent["height"])
        if not outline["coveredGridIndices"]:
            raise Refused("geometry")
        from PIL import Image
        with Image.open(io.BytesIO(data)) as image:
            cutout = preprocess(image, mask, outline["bounds"])
    except PhotoRefused as error:
        raise Refused("unavailable" if error.exit_code == 3 else "input") from None
    except (ValueError, TypeError, AttributeError, OSError):
        raise Refused("input") from None
    vertices, faces, colors = generate(cutout)
    glb, bounds = make_glb(vertices, faces, colors)
    receipt = {"representation": "source-photo-full-object-v1", "asset": "object.glb",
               "sha256": sha(glb), "bytes": len(glb), "initial": initial_pose(parent, outline, bounds),
               "model": dict(MODEL), "input": {"sourceSha256": source_sha, "outlineSha256": outline["maskSha256"], "parentSurfaceSha256": parent_sha}}
    if (file_sha(image_path) != source_sha or file_sha(mask_path) != outline["maskSha256"]
            or file_sha(parent_path) != parent_sha):
        raise Refused("input")
    written = []
    try:
        for name, payload in (("object.glb", glb), ("object.json", json.dumps(receipt, allow_nan=False).encode())):
            with (output / name).open("xb") as stream:
                written.append(output / name)
                stream.write(payload)
    except OSError:
        for path in written:
            path.unlink(missing_ok=True)
        raise Refused("write") from None
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--validate-outline")
    for name in ("width", "height", "grid-width", "grid-height"):
        parser.add_argument("--" + name, type=int)
    for name in ("image", "mask", "parent-surface", "output"):
        parser.add_argument("--" + name)
    args = parser.parse_args(argv)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if args.validate_outline:
                if any((args.image, args.mask, args.parent_surface, args.output)):
                    raise Refused("input")
                result, _ = validate_outline(args.validate_outline, args.width, args.height, args.grid_width, args.grid_height)
            else:
                if not all((args.image, args.mask, args.parent_surface, args.output)) or any(v is not None for v in (args.width, args.height, args.grid_width, args.grid_height)):
                    raise Refused("input")
                result = build(args.image, args.mask, args.parent_surface, args.output)
        if args.validate_outline:
            print(json.dumps(result, separators=(",", ":"), allow_nan=False))
        return 0
    except Refused as error:
        print(str(error), file=sys.stderr)
        return {"input": 2, "unavailable": 3, "geometry": 4, "bounds": 4, "write": 5}[error.reason]
    except Exception:
        print(MESSAGES["unavailable"], file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
