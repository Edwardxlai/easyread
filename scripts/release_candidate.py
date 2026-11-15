"""Record and verify the three native installer sets for a single release."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
from urllib.parse import unquote

MANIFEST = "candidate.json"
ASSETS = {
    "Windows": ["EasyRead-Setup-{v}.exe", "EasyRead-Setup-{v}.exe.blockmap", "latest.yml"],
    "macOS": ["EasyRead-{v}-arm64.dmg", "EasyRead-{v}-arm64.dmg.blockmap",
              "EasyRead-{v}-arm64-mac.zip", "EasyRead-{v}-arm64-mac.zip.blockmap", "latest-mac.yml"],
    "Linux": ["EasyRead-{v}.AppImage", "latest-linux.yml"],
}


def digest(path, algorithm):
    hashed = hashlib.new(algorithm)
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            hashed.update(chunk)
    return hashed


def record(folder, platform, sha, version):
    names = [name.format(v=version) for name in ASSETS[platform]]
    return {"sha": sha, "version": version, "platform": platform,
            "sha256": {name: digest(folder / name, "sha256").hexdigest() for name in names}}


def verify(folder, platform, sha, version):
    import yaml

    expected = record(folder, platform, sha, version)
    if json.loads((folder / MANIFEST).read_text(encoding="utf-8")) != expected:
        raise ValueError(f"{platform}: candidate manifest mismatch")
    assets = set(expected["sha256"])
    if {p.name for p in folder.iterdir()} != assets | {MANIFEST}:
        raise ValueError(f"{platform}: unexpected release artifact")
    index = next(name for name in assets if name.endswith(".yml"))
    metadata = yaml.safe_load((folder / index).read_text(encoding="utf-8"))
    installers = {name for name in assets if not name.endswith((".blockmap", ".yml"))}
    listed = {unquote(entry["url"]) for entry in metadata["files"]}
    # The Mac updater may index only the zip; the dmg is independently hashed.
    updatable = {name for name in installers if not name.endswith(".dmg")}
    if (metadata["version"] != version or not updatable <= listed <= installers
            or unquote(metadata["path"]) not in listed):
        raise ValueError(f"{platform}: invalid update index")
    for entry in metadata["files"]:
        name = unquote(entry["url"])
        path = folder / name
        checksum = base64.b64encode(digest(path, "sha512").digest()).decode()
        if checksum != entry["sha512"] or path.stat().st_size != entry["size"]:
            raise ValueError(f"{name}: invalid update size or SHA512")
        if name == unquote(metadata["path"]) and checksum != metadata["sha512"]:
            raise ValueError(f"{name}: invalid default update checksum")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("record", "verify"))
    parser.add_argument("folder", type=Path)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--platform", choices=ASSETS)
    args = parser.parse_args()
    if args.mode == "record":
        if not args.platform:
            parser.error("record requires --platform")
        data = record(args.folder, args.platform, args.sha, args.version)
        (args.folder / MANIFEST).write_text(json.dumps(data, indent=2), encoding="utf-8")
    else:
        for platform in ASSETS:
            verify(args.folder / ("easyread-" + platform), platform, args.sha, args.version)


if __name__ == "__main__":
    main()
