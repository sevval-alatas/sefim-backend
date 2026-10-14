#!/usr/bin/env python3
"""Read DWG column outlines and their labels, emitting one JSON document."""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path
from typing import Any

DWG_SIGNATURES = {f"AC{version}".encode("ascii") for version in range(1012, 1033)}
COLUMN_NAME = re.compile(r"^\.?S\d+[A-Za-z0-9_-]*$", re.IGNORECASE)
MTEXT_FORMAT = re.compile(r"\\(?:[A-Za-z][^;]*;|P|~|\{|\})")


class WorkerError(Exception):
    pass


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, allow_nan=False))


def clean_text(value: Any) -> str:
    text = str(value or "")
    text = text.replace("\\P", "\n").replace("\\p", "\n").replace("\\~", " ")
    text = MTEXT_FORMAT.sub("", text).replace("{", "").replace("}", "")
    return "\n".join(" ".join(line.split()).strip() for line in text.splitlines()).strip()


def bounds_for(polyline: Any) -> tuple[float, float, float, float] | None:
    points = polyline.to_points()
    if not points:
        return None
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    if not all(math.isfinite(value) for value in (*xs, *ys)):
        return None
    return min(xs), min(ys), max(xs), max(ys)


def extract_columns(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise WorkerError("DWG file does not exist")
    if path.stat().st_size < 6:
        raise WorkerError("File is too short to be a valid DWG")
    with path.open("rb") as drawing_file:
        signature = drawing_file.read(6)
    if signature not in DWG_SIGNATURES:
        raise WorkerError("Invalid or unsupported DWG file signature")

    try:
        import ezdwg

        document = ezdwg.read(str(path))
    except Exception as error:
        raise WorkerError(f"Could not read DWG file: {error}") from error

    entities = list(document.modelspace().query("LWPOLYLINE TEXT MTEXT"))
    polylines = [
        entity
        for entity in entities
        if entity.dxftype == "LWPOLYLINE"
        and str(entity.dxf.get("layer", "")).casefold() == "kolon"
    ]
    texts = [entity for entity in entities if entity.dxftype in {"TEXT", "MTEXT"}]
    if not polylines:
        return {
            "success": True,
            "columns": [],
            "warnings": ['"Kolon" layer üzerinde LWPOLYLINE bulunamadı.'],
        }

    columns: list[dict[str, Any]] = []
    seen: set[str] = set()
    for polyline in polylines:
        bounds = bounds_for(polyline)
        if bounds is None:
            continue
        min_x, min_y, max_x, max_y = bounds
        for text_entity in texts:
            data = text_entity.dxf
            text = clean_text(data.get("text", ""))
            match = next(
                (candidate for line in text.splitlines()
                 if (candidate := COLUMN_NAME.fullmatch(line.strip()))),
                None,
            )
            if not match:
                continue
            name = match.group(0).lstrip(".").upper()
            if not COLUMN_NAME.fullmatch(name) or name in seen:
                continue

            insertion = data.get("insert")
            if not insertion or len(insertion) < 2:
                continue
            x, y = float(insertion[0]), float(insertion[1])
            if not (math.isfinite(x) and math.isfinite(y)):
                continue
            if min_x <= x <= max_x and min_y <= y <= max_y:
                columns.append({
                    "name": name,
                    "minX": min_x,
                    "minY": min_y,
                    "maxX": max_x,
                    "maxY": max_y,
                })
                seen.add(name)
                break

    warnings = [] if columns else [
        '"Kolon" layer bulundu ancak polyline sınırları içinde S101 benzeri kolon adı bulunamadı.'
    ]
    return {"success": True, "columns": columns, "warnings": warnings}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        emit({"success": False, "error": "Usage: python main.py /path/to/project.dwg"})
        return 2
    try:
        emit(extract_columns(Path(argv[1]).expanduser().resolve()))
        return 0
    except WorkerError as error:
        emit({"success": False, "error": str(error)})
        return 1
    except Exception as error:  # Keep stdout machine-readable for unexpected parser errors.
        emit({"success": False, "error": f"Unexpected DWG worker error: {error}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
