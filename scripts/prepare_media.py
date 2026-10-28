#!/usr/bin/env python3
"""Copy selected original demos and generate project-page posters and metadata.

Run from any directory with Python 3, ffmpeg, and ffprobe on PATH:
    python scripts/prepare_media.py
    python scripts/prepare_media.py --source-root /path/to/paper-workspace
    python scripts/prepare_media.py --prune

Only assets/videos, assets/posters, assets/media-sources.json, and media-data.js
inside this project are written. Original source media is never changed.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


SITE = Path(__file__).resolve().parents[1]
SHORT_SCENES = [
    ("03_glacial_cave", "Glacial cave"),
    ("05_seoul_violinist", "Seoul violinist"),
    ("01_hong_kong_tram", "Hong Kong tram"),
    ("06_desert_carnival", "Desert carnival"),
]
LONG_SCENES = [
    ("p0554_park_yoga__MemRoPE__seed5__1f043c28.mp4", "yoga", "Park yoga"),
    ("p0311_pottery_wheel__MemRoPE__seed2__8b3ae36f.mp4", "pottery", "Pottery wheel"),
    ("p0273_making_dumplings__MemRoPE__seed0__3899dd8a.mp4", "dumplings", "Making dumplings"),
    ("p0303_playing_acoustic_guitar__MemRoPE__seed0__abd27aa7.mp4", "guitar", "Acoustic guitar"),
    ("p0316_brushing_teeth_at_mirror__MemRoPE__seed15__eced57a3.mp4", "brushing", "Mirror reflection"),
    ("p0777_chef_plating__MemRoPE__seed3__d99068a6.mp4", "chef", "Chef at work"),
]
WORLD_SCENES = [
    ("03_milk_pouring", "Pouring milk"),
    ("01_watercolor", "Watercolor painting"),
    ("05_sand_filling", "Filling with sand"),
]


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_prompt(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig").strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=SITE.parents[1])
    parser.add_argument("--prune", action="store_true", help="Remove stale copied MP4/JPEG assets only inside this project's media folders")
    args = parser.parse_args()
    root = args.source_root.resolve()
    for executable in ("ffmpeg", "ffprobe"):
        if shutil.which(executable) is None:
            parser.error(f"{executable} is required on PATH")
    source_dir = root / "exports" / "videos"
    if not source_dir.is_dir():
        parser.error(f"Missing exports/videos inside {root}")

    records = []
    data = {"short": [], "long": [], "world": []}

    def copy_video(source: Path, group: str, name: str) -> tuple[str, str, float]:
        target = SITE / "assets" / "videos" / group / f"{name}.mp4"
        poster = SITE / "assets" / "posters" / group / f"{name}.jpg"
        target.parent.mkdir(parents=True, exist_ok=True)
        poster.parent.mkdir(parents=True, exist_ok=True)
        source_hash = checksum(source)
        if not target.exists() or checksum(target) != source_hash:
            shutil.copy2(source, target)
        assert checksum(target) == source_hash, f"Copy checksum mismatch: {target.name}"
        probe = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,codec_name,avg_frame_rate:format=duration",
            "-of", "json", str(source),
        ], text=True, encoding="utf-8"))
        stream = probe["streams"][0]
        duration = float(probe["format"]["duration"])
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", "0.5", "-i", str(source), "-frames:v", "1",
            "-vf", "scale='min(960,iw)':-2", "-q:v", "3", str(poster),
        ], check=True)
        video_path = target.relative_to(SITE).as_posix()
        poster_path = poster.relative_to(SITE).as_posix()
        records.append({
            "source": source.relative_to(root).as_posix(),
            "file": video_path,
            "sha256": source_hash,
            "bytes": target.stat().st_size,
            "width": stream["width"],
            "height": stream["height"],
            "codec": stream["codec_name"],
            "frame_rate": stream["avg_frame_rate"],
            "duration": duration,
            "poster": poster_path,
            "poster_timestamp": 0.5,
            "poster_sha256": checksum(poster),
        })
        return video_path, poster_path, duration

    for folder, title in SHORT_SCENES:
        scene = source_dir / "15svideo" / folder
        baseline, baseline_poster, baseline_duration = copy_video(scene / "baseline.mp4", "15s", f"{folder}-baseline")
        ours, poster, duration = copy_video(scene / "ours.mp4", "15s", f"{folder}-ours")
        if abs(baseline_duration - duration) > 1e-6:
            raise ValueError(f"Paired video durations differ: {folder}")
        data["short"].append({
            "id": folder, "title": title, "prompt": read_prompt(scene / "prompt.txt"),
            "baseline": baseline, "ours": ours, "baselinePoster": baseline_poster,
            "poster": poster, "duration": duration,
        })

    long_dir = source_dir / "60svideo" / "ours_all_60s_videos_20261028"
    with (long_dir / "video_index.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for filename, scene_id, title in LONG_SCENES:
        row = next(row for row in rows if filename in row.values())
        video, poster, duration = copy_video(long_dir / filename, "60s", scene_id)
        data["long"].append({
            "id": scene_id, "title": title, "prompt": row["prompt"],
            "src": video, "poster": poster, "duration": duration,
        })

    for folder, title in WORLD_SCENES:
        scene = source_dir / "world_model_demos" / folder
        baseline, baseline_poster, baseline_duration = copy_video(scene / "baseline.mp4", "world", f"{folder}-baseline")
        ours, poster, duration = copy_video(scene / "ours.mp4", "world", f"{folder}-ours")
        if abs(baseline_duration - duration) > 1e-6:
            raise ValueError(f"Paired video durations differ: {folder}")
        data["world"].append({
            "id": folder, "title": title, "prompt": read_prompt(scene / "prompt.txt"),
            "baseline": baseline, "ours": ours, "baselinePoster": baseline_poster,
            "poster": poster, "duration": duration,
        })

    hero_scene = data["world"][0]
    data["heroWorld"] = {
        "id": hero_scene["id"], "title": hero_scene["title"],
        "prompt": hero_scene["prompt"], "src": hero_scene["ours"],
        "poster": hero_scene["poster"], "duration": hero_scene["duration"],
    }

    (SITE / "media-data.js").write_text(
        "// Generated by scripts/prepare_media.py; source media remains unchanged.\n"
        "window.HF_MEDIA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    (SITE / "assets" / "media-sources.json").write_text(json.dumps({
        "schema_version": 1,
        "source_root": "paper workspace",
        "video_count": len(records),
        "total_video_bytes": sum(record["bytes"] for record in records),
        "notes": [
            "MP4 files are byte-for-byte copies of selected exports/videos sources.",
            "Posters are JPEG frames extracted at 0.5 seconds, at most 960 pixels wide.",
            "Long-rollout examples last 62.8125 seconds.",
            "World demos use separate original Baseline and History Forcing videos with identical paired durations.",
            "Prompt text is copied from the source exports; some world demos use a changing prompt schedule.",
        ],
        "videos": records,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.prune:
        project_root = SITE.resolve()
        expected = {
            (SITE / record[key]).resolve()
            for record in records for key in ("file", "poster")
        }
        removed = 0
        for relative_dir, extension in (("assets/videos", ".mp4"), ("assets/posters", ".jpg")):
            media_root = (SITE / relative_dir).resolve()
            if project_root not in media_root.parents:
                raise ValueError(f"Media directory resolves outside this project: {relative_dir}")
            for candidate in media_root.rglob("*"):
                if not candidate.is_file() or candidate.suffix.lower() != extension:
                    continue
                resolved = candidate.resolve()
                if media_root not in resolved.parents or project_root not in resolved.parents:
                    raise ValueError(f"Refusing to remove a path outside the media directory: {candidate.name}")
                if resolved not in expected:
                    candidate.unlink()
                    removed += 1
        print(f"Removed {removed} stale copied media assets inside this project.")
    print(f"Prepared {len(records)} original videos and {len(records)} posters.")
    print(f"Video bytes: {sum(record['bytes'] for record in records):,}")
    print("Wrote media-data.js and assets/media-sources.json.")


if __name__ == "__main__":
    main()
