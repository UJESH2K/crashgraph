"""Shrink a .glb by re-encoding its embedded textures.

    python tools/optimize_glb.py in.glb out.glb [--max 1024] [--quality 85]

Sketchfab exports often carry 2K/4K PNG colour and normal maps, which dominate the file size:
the lunar surface used by the console is 53 MB of which 49 MB is two PNGs, and serving that over
the dev server takes half a minute. Re-encoding to JPEG at a sane resolution gives the same look
on screen for a fraction of the bytes.

Geometry, materials and the node tree are copied through untouched - only image bytes change,
so accessors keep pointing at the same bufferViews and nothing needs re-indexing.
"""
import argparse
import io
import json
import os
import struct
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("needs Pillow:  pip install pillow")

JSON_CHUNK, BIN_CHUNK = 0x4E4F534A, 0x004E4942


def read_glb(path):
    with open(path, "rb") as f:
        magic, _version, length = struct.unpack("<III", f.read(12))
        if magic != 0x46546C67:
            sys.exit(f"{path} is not a GLB")
        gltf, blob = None, b""
        while f.tell() < length:
            clen, ctype = struct.unpack("<II", f.read(8))
            data = f.read(clen)
            if ctype == JSON_CHUNK:
                gltf = json.loads(data)
            elif ctype == BIN_CHUNK:
                blob = data
    return gltf, blob


def write_glb(path, gltf, blob):
    j = json.dumps(gltf, separators=(",", ":")).encode()
    j += b" " * (-len(j) % 4)
    b = blob + b"\0" * (-len(blob) % 4)
    total = 12 + 8 + len(j) + (8 + len(b) if b else 0)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(j), JSON_CHUNK))
        f.write(j)
        if b:
            f.write(struct.pack("<II", len(b), BIN_CHUNK))
            f.write(b)


def recode(raw, max_dim, quality, srgb):
    """Return (bytes, mime) for one texture, or None to keep the original."""
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception:
        return None
    if max(im.size) > max_dim:
        im = im.resize((max(1, round(im.width * max_dim / max(im.size))),
                        max(1, round(im.height * max_dim / max(im.size)))), Image.LANCZOS)
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    buf = io.BytesIO()
    if has_alpha:
        im.convert("RGBA").save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "image/png"
    im.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True,
                           subsampling=0 if not srgb else 2)
    return buf.getvalue(), "image/jpeg"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--max", type=int, default=1024, help="longest texture edge (default 1024)")
    ap.add_argument("--quality", type=int, default=85)
    a = ap.parse_args()

    gltf, blob = read_glb(a.src)
    views = gltf.get("bufferViews", [])
    images = gltf.get("images", [])
    if not images:
        sys.exit("no embedded images to optimise")

    # Which bufferViews hold image bytes, and what the replacement is.
    replacement = {}
    for im in images:
        bv = im.get("bufferView")
        if bv is None:
            continue
        v = views[bv]
        raw = blob[v["byteOffset"]:v["byteOffset"] + v["byteLength"]]
        # a colour map is sRGB; normal/roughness are data, so keep chroma intact
        srgb = any(
            m.get("pbrMetallicRoughness", {}).get("baseColorTexture", {}).get("index") is not None
            for m in gltf.get("materials", []))
        out = recode(raw, a.max, a.quality, srgb)
        if out and len(out[0]) < len(raw):
            replacement[bv] = out
            im["mimeType"] = out[1]
            print(f"  image {bv}: {len(raw)/1e6:6.2f} MB -> {len(out[0])/1e6:5.2f} MB  {out[1]}")
        else:
            print(f"  image {bv}: kept ({len(raw)/1e6:.2f} MB)")

    # Rebuild the binary chunk, keeping bufferView order and indices.
    out = bytearray()
    for i, v in enumerate(views):
        data = (replacement[i][0] if i in replacement
                else blob[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])
        out += b"\0" * (-len(out) % 4)          # keep every view 4-byte aligned
        v["byteOffset"] = len(out)
        v["byteLength"] = len(data)
        out += data
    gltf["buffers"] = [{"byteLength": len(out)}]

    write_glb(a.dst, gltf, bytes(out))
    before, after = os.path.getsize(a.src), os.path.getsize(a.dst)
    print(f"\n{a.src} {before/1e6:.1f} MB  ->  {a.dst} {after/1e6:.1f} MB  "
          f"({100 * after / before:.0f}% of original)")


if __name__ == "__main__":
    main()
