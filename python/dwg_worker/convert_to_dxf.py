#!/usr/bin/env python3
"""Convert a DWG with LibreDWG and validate the resulting DXF."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import ezdxf
from ezdxf import bbox, path as ezdxf_path

DWG_SIGNATURES = {f"AC{version}".encode("ascii") for version in range(1012, 1033)}
SUPPORTED_DXF_VERSIONS = (
    "r12",
    "r14",
    "r2000",
    "r2004",
    "r2007",
    "r2010",
    "r2013",
    "r2018",
)
DIAGNOSTIC_LIMIT = 3000
SCENE_SCHEMA = "sefim-cad-scene/1"
MAX_SCENE_ENTITIES = 1_000_000
MAX_INSERT_DEPTH = 8
IGNORED_ENTITY_TYPES = {
    "ATTDEF",
    "SEQEND",
    "VIEWPORT",
    "WIPEOUT",
    "IMAGE",
    "OLE2FRAME",
    "PDFUNDERLAY",
    "RAY",
    "REGION",
    "XLINE",
}
_SURROGATE_RE = re.compile(r"[\udc80-\udcff]+")
_CP1252_TO_TR = str.maketrans(
    {
        "\u00d0": "Ğ",
        "\u00dd": "İ",
        "\u00de": "Ş",
        "\u00f0": "ğ",
        "\u00fd": "ı",
        "\u00fe": "ş",
    }
)


class ConversionError(Exception):
    """An expected conversion or validation failure."""


def _short(value: str, limit: int = DIAGNOSTIC_LIMIT) -> str:
    value = value.strip()
    return value if len(value) <= limit else value[-limit:]


def _clean_str(value: str) -> str:
    if _SURROGATE_RE.search(value):
        def _replace(match: re.Match[str]) -> str:
            raw = bytes(ord(ch) - 0xDC00 for ch in match.group(0))
            for encoding in ("utf-8", "cp1254", "latin1"):
                try:
                    return raw.decode(encoding)
                except UnicodeDecodeError:
                    continue
            return raw.decode("utf-8", errors="replace")

        value = _SURROGATE_RE.sub(_replace, value)
    return value.translate(_CP1252_TO_TR)


def _json_safe(value: Any) -> Any:
    if isinstance(value, str):
        return _clean_str(value).encode("utf-8", errors="replace").decode("utf-8")
    if isinstance(value, dict):
        return {_json_safe(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def _point(values: Any) -> list[float] | None:
    try:
        coords = tuple(values)
        x = float(coords[0])
        y = float(coords[1])
    except (TypeError, ValueError, IndexError):
        return None
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    return [round(x, 3), round(y, 3), 0.0]


def _wcs_point(entity: Any, value: Any) -> list[float] | None:
    try:
        wcs = entity.ocs().to_wcs(value)
    except Exception:
        wcs = value
    return _point(wcs)


def _is_mirrored_ocs(entity: Any) -> bool:
    try:
        return float(entity.dxf.extrusion.z) < 0.0
    except Exception:
        return False


def _make_base_feature(
    handle: str,
    kind: str,
    layer: str,
    color: int | None,
    true_color: int | None,
    lineweight: int | None,
    geometry: dict[str, Any],
) -> dict[str, Any]:
    feature: dict[str, Any] = {
        "id": handle,
        "type": kind,
        "layer": layer,
    }
    if color is not None:
        feature["color"] = color
    if true_color is not None:
        feature["trueColor"] = true_color
    if lineweight is not None:
        feature["lineweight"] = lineweight
    feature["geometry"] = geometry
    return feature


def _resolve_style(
    entity: Any,
    parent_layer: str | None,
    parent_color: int | None,
    parent_true_color: int | None,
    layer_colors: dict[str, int],
    layer_true_colors: dict[str, int],
) -> tuple[str, int | None, int | None, int | None]:
    data = entity.dxf
    raw_layer = _clean_str(str(data.get("layer", "0") or "0"))
    layer = parent_layer if (raw_layer == "0" and parent_layer) else raw_layer

    color = data.get("color", 256) if data.hasattr("color") else 256
    true_color = data.get("true_color") if data.hasattr("true_color") else None

    if color == 0:
        color = (
            parent_color
            if parent_color is not None
            else layer_colors.get(layer, 7)
        )
        if true_color is None:
            true_color = parent_true_color
    elif color == 256 or color is None:
        color = layer_colors.get(layer, 7)
        if true_color is None:
            true_color = layer_true_colors.get(layer)

    lineweight = data.get("lineweight") if data.hasattr("lineweight") else None
    return layer, color, true_color, lineweight


def _expand_entity_features(
    entity: Any,
    layer_colors: dict[str, int],
    layer_true_colors: dict[str, int],
    unsupported: dict[str, int],
    id_counter: list[int],
    parent_layer: str | None = None,
    parent_color: int | None = None,
    parent_true_color: int | None = None,
    depth: int = 0,
) -> list[dict[str, Any]]:
    kind = entity.dxftype()
    if kind in IGNORED_ENTITY_TYPES:
        return []

    data = entity.dxf
    layer, color, true_color, lineweight = _resolve_style(
        entity,
        parent_layer,
        parent_color,
        parent_true_color,
        layer_colors,
        layer_true_colors,
    )

    def _next_id() -> str:
        raw_handle = data.get("handle")
        if raw_handle and depth == 0:
            return str(raw_handle)
        id_counter[0] += 1
        return f"{raw_handle or 'V'}_{id_counter[0]}"

    if kind == "INSERT":
        results: list[dict[str, Any]] = []
        try:
            attribs = list(getattr(entity, "attribs", ()))
        except Exception:
            attribs = []
        for attrib in attribs:
            results.extend(
                _expand_entity_features(
                    attrib,
                    layer_colors,
                    layer_true_colors,
                    unsupported,
                    id_counter,
                    parent_layer=layer,
                    parent_color=color,
                    parent_true_color=true_color,
                    depth=depth + 1,
                )
            )
        if depth >= MAX_INSERT_DEPTH:
            return results
        try:
            virtual_items = list(entity.virtual_entities())
        except Exception:
            return results
        for child in virtual_items:
            results.extend(
                _expand_entity_features(
                    child,
                    layer_colors,
                    layer_true_colors,
                    unsupported,
                    id_counter,
                    parent_layer=layer,
                    parent_color=color,
                    parent_true_color=true_color,
                    depth=depth + 1,
                )
            )
        return results

    if kind in {
        "LWPOLYLINE",
        "POLYLINE",
        "DIMENSION",
        "ARC_DIMENSION",
        "LARGE_RADIAL_DIMENSION",
        "LEADER",
        "MULTILEADER",
        "MLEADER",
        "MLINE",
    }:
        if depth >= MAX_INSERT_DEPTH + 4:
            return []
        try:
            virtual_items = list(entity.virtual_entities())
        except Exception:
            unsupported[kind] = unsupported.get(kind, 0) + 1
            return []
        results = []
        for child in virtual_items:
            results.extend(
                _expand_entity_features(
                    child,
                    layer_colors,
                    layer_true_colors,
                    unsupported,
                    id_counter,
                    parent_layer=layer,
                    parent_color=color,
                    parent_true_color=true_color,
                    depth=depth + 1,
                )
            )
        return results

    if kind == "HATCH":
        results = []
        try:
            paths = list(ezdxf_path.from_hatch(entity))
        except Exception:
            paths = []
        for hatch_path in paths:
            try:
                pts = [_point(pt) for pt in hatch_path.flattening(distance=2.0)]
            except Exception:
                continue
            valid_pts = [pt for pt in pts if pt is not None]
            for idx in range(len(valid_pts) - 1):
                p1, p2 = valid_pts[idx], valid_pts[idx + 1]
                if p1 != p2:
                    id_counter[0] += 1
                    results.append(
                        _make_base_feature(
                            f"{data.get('handle') or 'H'}_{id_counter[0]}",
                            "LINE",
                            layer,
                            color,
                            true_color,
                            lineweight,
                            {"start": p1, "end": p2},
                        )
                    )
        return results

    if kind in {"SOLID", "TRACE", "3DFACE"}:
        order = (0, 1, 3, 2) if kind in {"SOLID", "TRACE"} else (0, 1, 2, 3)
        pts: list[list[float]] = []
        for idx in order:
            attr_name = f"vtx{idx}"
            if data.hasattr(attr_name):
                raw_pt = data.get(attr_name)
                pt = (
                    _wcs_point(entity, raw_pt)
                    if kind in {"SOLID", "TRACE"}
                    else _point(raw_pt)
                )
                if pt is not None and (not pts or pts[-1] != pt):
                    pts.append(pt)
        if len(pts) < 2:
            return []
        results = []
        count = len(pts)
        for idx in range(count):
            p1 = pts[idx]
            p2 = pts[(idx + 1) % count]
            if p1 != p2:
                id_counter[0] += 1
                results.append(
                    _make_base_feature(
                        f"{data.get('handle') or 'S'}_{id_counter[0]}",
                        "LINE",
                        layer,
                        color,
                        true_color,
                        lineweight,
                        {"start": p1, "end": p2},
                    )
                )
        return results

    if kind == "MTEXT":
        insert = _point(data.insert)
        if insert is None:
            return []
        try:
            raw_lines = entity.plain_text(split=True)
        except Exception:
            raw_lines = [str(getattr(entity, "text", ""))]
        lines = [
            _clean_str(line).strip()
            for line in raw_lines
            if _clean_str(line).strip()
        ]
        if not lines:
            return []
        height = round(float(data.get("char_height", 2.5) or 2.5), 3)
        try:
            rotation = round(float(entity.get_rotation()), 3)
        except Exception:
            rotation = round(float(data.get("rotation", 0.0)), 3)
        rad = math.radians(rotation)
        line_step = height * 1.35
        dx = math.sin(rad) * line_step
        dy = -math.cos(rad) * line_step
        style = _clean_str(str(data.get("style", "Standard")))
        results = []
        for idx, text_line in enumerate(lines):
            line_insert = [
                round(insert[0] + idx * dx, 3),
                round(insert[1] + idx * dy, 3),
                0.0,
            ]
            id_counter[0] += 1
            results.append(
                _make_base_feature(
                    f"{data.get('handle') or 'MT'}_{id_counter[0]}",
                    "TEXT",
                    layer,
                    color,
                    true_color,
                    lineweight,
                    {
                        "text": text_line,
                        "insert": line_insert,
                        "height": height,
                        "rotation": rotation,
                        "widthFactor": 1.0,
                        "oblique": 0.0,
                        "style": style,
                    },
                )
            )
        return results

    if kind in {"TEXT", "ATTRIB"}:
        text_val = _clean_str(str(data.get("text", ""))).strip()
        if not text_val:
            return []
        insert = _wcs_point(entity, data.insert)
        if insert is None:
            return []
        rotation = float(data.get("rotation", 0.0))
        if _is_mirrored_ocs(entity):
            rotation = (180.0 - rotation) % 360.0
        geometry = {
            "text": text_val,
            "insert": insert,
            "height": round(float(data.get("height", 2.5) or 2.5), 3),
            "rotation": round(rotation, 3),
            "widthFactor": round(float(data.get("width", 1.0) or 1.0), 3),
            "oblique": round(float(data.get("oblique", 0.0) or 0.0), 3),
            "style": _clean_str(str(data.get("style", "Standard"))),
        }
        return [
            _make_base_feature(
                _next_id(),
                "TEXT",
                layer,
                color,
                true_color,
                lineweight,
                geometry,
            )
        ]

    if kind == "LINE":
        start = _point(data.start)
        end = _point(data.end)
        if start is None or end is None or start == end:
            return []
        return [
            _make_base_feature(
                _next_id(),
                "LINE",
                layer,
                color,
                true_color,
                lineweight,
                {"start": start, "end": end},
            )
        ]

    if kind == "CIRCLE":
        center = _wcs_point(entity, data.center)
        radius = round(float(data.radius), 3)
        if center is None or radius <= 0 or not math.isfinite(radius):
            return []
        return [
            _make_base_feature(
                _next_id(),
                "CIRCLE",
                layer,
                color,
                true_color,
                lineweight,
                {"center": center, "radius": radius},
            )
        ]

    if kind == "ARC":
        center = _wcs_point(entity, data.center)
        radius = round(float(data.radius), 3)
        if center is None or radius <= 0 or not math.isfinite(radius):
            return []
        start_angle = float(data.start_angle)
        end_angle = float(data.end_angle)
        if _is_mirrored_ocs(entity):
            start_angle, end_angle = (
                (180.0 - end_angle) % 360.0,
                (180.0 - start_angle) % 360.0,
            )
        return [
            _make_base_feature(
                _next_id(),
                "ARC",
                layer,
                color,
                true_color,
                lineweight,
                {
                    "center": center,
                    "radius": radius,
                    "startAngle": round(start_angle, 3),
                    "endAngle": round(end_angle, 3),
                },
            )
        ]

    if kind == "ELLIPSE":
        center = _point(data.center)
        major_axis = _point(data.major_axis)
        ratio = round(float(data.ratio), 6)
        if center is None or major_axis is None or not math.isfinite(ratio):
            return []
        return [
            _make_base_feature(
                _next_id(),
                "ELLIPSE",
                layer,
                color,
                true_color,
                lineweight,
                {
                    "center": center,
                    "majorAxis": major_axis,
                    "ratio": ratio,
                    "startParameter": round(float(data.start_param), 4),
                    "endParameter": round(float(data.end_param), 4),
                },
            )
        ]

    if kind == "POINT":
        pt = _point(data.location)
        if pt is None:
            return []
        return [
            _make_base_feature(
                _next_id(),
                "POINT",
                layer,
                color,
                true_color,
                lineweight,
                {"point": pt},
            )
        ]

    if kind == "SPLINE":
        control_points = [
            pt for pt in (_point(point) for point in entity.control_points) if pt is not None
        ]
        fit_points = [
            pt for pt in (_point(point) for point in entity.fit_points) if pt is not None
        ]
        if not control_points and not fit_points:
            return []
        return [
            _make_base_feature(
                _next_id(),
                "SPLINE",
                layer,
                color,
                true_color,
                lineweight,
                {
                    "degree": int(data.get("degree", 3)),
                    "closed": bool(entity.closed),
                    "controlPoints": control_points,
                    "fitPoints": fit_points,
                    "knots": [round(float(value), 4) for value in entity.knots],
                    "weights": [round(float(value), 4) for value in entity.weights],
                },
            )
        ]

    unsupported[kind] = unsupported.get(kind, 0) + 1
    return []


def _compute_scene_extents(
    features: list[dict[str, Any]], fallback_extents: dict[str, Any] | None
) -> dict[str, Any] | None:
    xs: list[float] = []
    ys: list[float] = []
    for feature in features:
        ftype = feature["type"]
        geom = feature["geometry"]
        if ftype == "LINE":
            xs.extend((geom["start"][0], geom["end"][0]))
            ys.extend((geom["start"][1], geom["end"][1]))
        elif ftype in {"CIRCLE", "ARC"}:
            cx, cy = geom["center"][0], geom["center"][1]
            r = geom["radius"]
            xs.extend((cx - r, cx + r))
            ys.extend((cy - r, cy + r))
        elif ftype == "TEXT":
            xs.append(geom["insert"][0])
            ys.append(geom["insert"][1])
        elif ftype == "POINT":
            xs.append(geom["point"][0])
            ys.append(geom["point"][1])
    if not xs or not ys:
        return fallback_extents
    return {
        "min": [round(min(xs), 3), round(min(ys), 3), 0.0],
        "max": [round(max(xs), 3), round(max(ys), 3), 0.0],
    }


def _scene_model(document: Any) -> tuple[dict[str, Any], list[str]]:
    modelspace = document.modelspace()
    fallback_extents = None
    try:
        bounds = bbox.extents(modelspace, fast=True)
        if bounds.has_data:
            minimum = _point(bounds.extmin)
            maximum = _point(bounds.extmax)
            if minimum and maximum:
                fallback_extents = {"min": minimum, "max": maximum}
    except Exception:
        fallback_extents = None

    layers = []
    layer_colors: dict[str, int] = {}
    layer_true_colors: dict[str, int] = {}
    for layer in document.layers:
        name = _clean_str(str(layer.dxf.name))
        raw_color = int(layer.dxf.get("color", 7) or 7)
        clean_color = abs(raw_color) if raw_color != 0 else 7
        true_color = layer.dxf.get("true_color") if layer.dxf.hasattr("true_color") else None
        layer_colors[name] = clean_color
        if true_color is not None:
            layer_true_colors[name] = int(true_color)
        layers.append(
            {
                "name": name,
                "color": clean_color,
                "trueColor": true_color,
                "lineweight": layer.dxf.get("lineweight", -1),
                "linetype": _clean_str(str(layer.dxf.get("linetype", "CONTINUOUS"))),
                "visible": not layer.is_off() and not layer.is_frozen(),
                "frozen": layer.is_frozen(),
            }
        )

    features: list[dict[str, Any]] = []
    unsupported: dict[str, int] = {}
    truncated = False
    id_counter = [0]

    for entity in modelspace:
        if len(features) >= MAX_SCENE_ENTITIES:
            truncated = True
            break
        try:
            expanded = _expand_entity_features(
                entity,
                layer_colors,
                layer_true_colors,
                unsupported,
                id_counter,
            )
        except Exception:
            kind = entity.dxftype()
            if kind not in IGNORED_ENTITY_TYPES:
                unsupported[kind] = unsupported.get(kind, 0) + 1
            continue

        for feature in expanded:
            if len(features) >= MAX_SCENE_ENTITIES:
                truncated = True
                break
            features.append(feature)

    extents = _compute_scene_extents(features, fallback_extents)

    warnings = []
    if unsupported:
        warnings.append(
            f"{sum(unsupported.values())} entity(ies) are not represented in the mobile scene; original DXF retains them."
        )
    if truncated:
        warnings.append(
            f"Mobile scene was capped at {MAX_SCENE_ENTITIES} entities; the DXF remains complete."
        )

    units = int(document.header.get("$INSUNITS", 0))
    scene = {
        "schema": SCENE_SCHEMA,
        "units": units,
        "extents": extents,
        "layers": layers,
        "blocks": {},
        "entities": features,
        "entityCount": len(features),
        "unsupportedEntities": dict(sorted(unsupported.items())),
        "truncated": truncated,
        "warnings": warnings,
    }
    return scene, warnings


def _inspect_dxf(
    path: Path, scene_output: Path | None = None
) -> tuple[dict[str, Any], list[str]]:
    try:
        document = ezdxf.readfile(path)
    except Exception as error:
        raise ConversionError(f"Generated DXF cannot be read: {error}") from error

    entity_counts: dict[str, int] = {}
    layer_entity_counts: dict[str, int] = {}
    modelspace = document.modelspace()
    for entity in modelspace:
        entity_type = entity.dxftype()
        entity_counts[entity_type] = entity_counts.get(entity_type, 0) + 1
        layer = entity.dxf.get("layer", "0")
        layer_entity_counts[layer] = layer_entity_counts.get(layer, 0) + 1

    layers = sorted(layer.dxf.name for layer in document.layers)
    block_count = len(document.blocks)
    auditor = document.audit()
    report = {
        "dxf_version": document.dxfversion,
        "layer_count": len(layers),
        "layers": layers,
        "block_count": block_count,
        "modelspace_entity_count": sum(entity_counts.values()),
        "entity_types": dict(sorted(entity_counts.items())),
        "modelspace_entities_by_layer": dict(sorted(layer_entity_counts.items())),
        "audit_error_count": len(auditor.errors),
        "audit_fix_count": len(auditor.fixes),
        "audit_errors": [str(item) for item in auditor.errors[:50]],
        "audit_fixes": [str(item) for item in auditor.fixes[:50]],
    }
    warnings = []
    if auditor.errors:
        warnings.append(
            f"DXF audit found {len(auditor.errors)} error(s); the output was not modified."
        )
    if auditor.fixes:
        warnings.append(
            f"DXF audit suggested {len(auditor.fixes)} fix(es); the output was not modified."
        )
    if scene_output:
        scene, scene_warnings = _scene_model(document)
        warnings.extend(scene_warnings)
        _write_json_atomic(scene_output, scene)
        report["mobile_scene"] = {
            "schema": SCENE_SCHEMA,
            "path": str(scene_output),
            "entity_count": scene["entityCount"],
            "unsupported_entities": scene["unsupportedEntities"],
            "truncated": scene["truncated"],
        }
    return report, warnings


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            encoding="utf-8",
            delete=False,
        ) as temporary_file:
            json.dump(
                _json_safe(payload),
                temporary_file,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            temporary_file.write("\n")
            temporary_path = Path(temporary_file.name)
        os.replace(temporary_path, path)
    finally:
        if temporary_path:
            temporary_path.unlink(missing_ok=True)


def _strategies(version: str) -> list[tuple[str, list[str]]]:
    return [
        (f"LibreDWG {version}", ["--as", version]),
        ("LibreDWG native DXF version", []),
        ("LibreDWG r2000 compatibility", ["--as", "r2000"]),
        ("LibreDWG minimal DXF", ["-m"]),
    ]


def convert_dwg_to_dxf(
    source: Path,
    output: Path | None = None,
    report_path: Path | None = None,
    scene_path: Path | None = None,
    converter: str = "dwg2dxf",
    version: str = "r2018",
    timeout: int = 180,
    overwrite: bool = False,
) -> dict[str, Any]:
    source = source.expanduser().resolve()
    if not source.is_file():
        raise ConversionError(f"DWG file does not exist: {source}")
    if source.stat().st_size < 6:
        raise ConversionError("DWG file is too short to contain a valid signature")
    with source.open("rb") as dwg_file:
        signature = dwg_file.read(6)
    if signature not in DWG_SIGNATURES:
        raise ConversionError(f"Invalid or unsupported DWG signature: {signature!r}")
    if version not in SUPPORTED_DXF_VERSIONS:
        raise ConversionError(f"Unsupported DXF version: {version}")
    if timeout <= 0:
        raise ConversionError("Timeout must be greater than zero")

    output = (output or source.with_suffix(".dxf")).expanduser().resolve()
    report_path = (
        report_path or output.with_suffix(".report.json")
    ).expanduser().resolve()
    scene_path = (
        scene_path or output.with_suffix(".scene.json")
    ).expanduser().resolve()
    if len({source, output, report_path, scene_path}) != 4:
        raise ConversionError("Input, DXF, scene, and report must use different paths")
    if not output.parent.is_dir() or not report_path.parent.is_dir() or not scene_path.parent.is_dir():
        raise ConversionError("Output, scene, and report directories must already exist")
    if not overwrite and (output.exists() or report_path.exists() or scene_path.exists()):
        raise ConversionError(
            "DXF, scene, or report already exists; choose different paths or use --overwrite"
        )

    executable = shutil.which(converter)
    if executable is None:
        raise ConversionError(
            f"DWG converter not found: {converter}. Install LibreDWG or set --converter."
        )

    attempts: list[dict[str, Any]] = []
    validated_report: dict[str, Any] | None = None
    warnings: list[str] = []
    selected_strategy: str | None = None

    try:
        with tempfile.TemporaryDirectory(
            prefix=".dwg-convert-", dir=output.parent
        ) as temporary_directory:
            staging_directory = Path(temporary_directory)
            for strategy_name, version_args in _strategies(version):
                staged_output = staging_directory / "candidate.dxf"
                staged_scene = staging_directory / "candidate.scene.json"
                args = [
                    executable,
                    "-v1",
                    "-y",
                    "-o",
                    str(staged_output),
                    *version_args,
                    str(source),
                ]
                attempt: dict[str, Any] = {
                    "strategy": strategy_name,
                }
                try:
                    result = subprocess.run(
                        args,
                        cwd=staging_directory,
                        capture_output=True,
                        text=True,
                        timeout=timeout,
                        check=False,
                    )
                except subprocess.TimeoutExpired as error:
                    attempt["error"] = f"Timed out after {timeout} seconds"
                    attempt["stdout"] = _short(
                        error.stdout.decode(errors="replace")
                        if isinstance(error.stdout, bytes)
                        else error.stdout or ""
                    )
                    attempt["stderr"] = _short(
                        error.stderr.decode(errors="replace")
                        if isinstance(error.stderr, bytes)
                        else error.stderr or ""
                    )
                    attempts.append(attempt)
                    continue
                except OSError as error:
                    attempt["error"] = str(error)
                    attempts.append(attempt)
                    continue

                attempt["return_code"] = result.returncode
                attempt["stdout"] = _short(result.stdout)
                attempt["stderr"] = _short(result.stderr)
                if not staged_output.is_file() or staged_output.stat().st_size == 0:
                    attempt["error"] = "Converter did not create a non-empty DXF"
                    attempt["validated"] = False
                    attempts.append(attempt)
                    continue

                try:
                    validated_report, audit_warnings = _inspect_dxf(
                        staged_output, staged_scene
                    )
                except ConversionError as error:
                    attempt["error"] = str(error)
                    attempt["validated"] = False
                    attempts.append(attempt)
                    continue

                attempt["validated"] = True
                if result.returncode != 0:
                    audit_warnings.append(
                        f"Converter exited with code {result.returncode} but produced a readable DXF."
                    )
                warnings = audit_warnings
                attempts.append(attempt)
                selected_strategy = strategy_name
                validated_report["mobile_scene"]["path"] = str(scene_path)

                report_data = {
                    "success": True,
                    "source": source.name,
                    "output": output.name,
                    "output_bytes": staged_output.stat().st_size,
                    "converter": Path(executable).name,
                    "strategy": selected_strategy,
                    **validated_report,
                    "warnings": warnings,
                    "attempts": attempts,
                    "report": str(report_path),
                }
                with staged_output.open("rb") as converted_file:
                    with tempfile.NamedTemporaryFile(
                        mode="wb",
                        dir=output.parent,
                        prefix=f".{output.name}.",
                        suffix=".tmp",
                        delete=False,
                    ) as temporary_output:
                        shutil.copyfileobj(converted_file, temporary_output)
                        temporary_output_path = Path(temporary_output.name)
                try:
                    with staged_scene.open("rb") as converted_scene:
                        temporary_scene_path: Path | None = None
                        with tempfile.NamedTemporaryFile(
                            mode="wb",
                            dir=scene_path.parent,
                            prefix=f".{scene_path.name}.",
                            suffix=".tmp",
                            delete=False,
                        ) as temporary_scene:
                            shutil.copyfileobj(converted_scene, temporary_scene)
                            temporary_scene_path = Path(temporary_scene.name)
                    temporary_report_path: Path | None = None
                    with tempfile.NamedTemporaryFile(
                        mode="w",
                        dir=report_path.parent,
                        prefix=f".{report_path.name}.",
                        suffix=".tmp",
                        encoding="utf-8",
                        delete=False,
                    ) as temporary_report:
                        temporary_report.write(
                            json.dumps(
                                _json_safe(report_data),
                                ensure_ascii=False,
                                indent=2,
                            )
                            + "\n"
                        )
                        temporary_report_path = Path(temporary_report.name)
                    try:
                        os.replace(temporary_output_path, output)
                        os.replace(temporary_scene_path, scene_path)
                        os.replace(temporary_report_path, report_path)
                    finally:
                        if temporary_report_path:
                            temporary_report_path.unlink(missing_ok=True)
                        if temporary_scene_path:
                            temporary_scene_path.unlink(missing_ok=True)
                finally:
                    temporary_output_path.unlink(missing_ok=True)
                return report_data

    except OSError as error:
        raise ConversionError(f"Could not write conversion output: {error}") from error

    details = "; ".join(
        f"{attempt['strategy']}: {attempt.get('error', attempt.get('stderr', 'failed'))}"
        for attempt in attempts
    )
    raise ConversionError(
        f"DWG could not be converted to a readable DXF. Attempts: {details}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert DWG to DXF using LibreDWG and validate the result."
    )
    parser.add_argument("source", type=Path, help="Input DWG file")
    parser.add_argument("-o", "--output", type=Path, help="DXF output path")
    parser.add_argument(
        "--report",
        type=Path,
        help="JSON report path (default: <output>.report.json)",
    )
    parser.add_argument(
        "--scene-output",
        type=Path,
        help="Mobile scene JSON path (default: <output>.scene.json)",
    )
    parser.add_argument(
        "--converter",
        default=os.environ.get("DWG2DXF", "dwg2dxf"),
        help="Path or command name for dwg2dxf (default: DWG2DXF or dwg2dxf)",
    )
    parser.add_argument(
        "--version",
        choices=SUPPORTED_DXF_VERSIONS,
        default="r2018",
        help="Preferred output DXF version (default: r2018)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=180,
        help="Maximum seconds per conversion attempt (default: 180)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace an existing DXF and/or report",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Read and audit a DXF without converting it",
    )
    args = parser.parse_args(argv)

    if args.validate_only:
        try:
            if not args.source.is_file():
                raise ConversionError(f"DXF file does not exist: {args.source}")
            validation_report, warnings = _inspect_dxf(args.source, args.scene_output)
            print(
                json.dumps(
                    {
                        "success": True,
                        "source": args.source.name,
                        "output_bytes": args.source.stat().st_size,
                        **validation_report,
                        "warnings": warnings,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        except ConversionError as error:
            print(json.dumps(_json_safe({"success": False, "error": str(error)}), ensure_ascii=False))
            return 1
        except Exception as error:
            print(
                json.dumps(
                    _json_safe({
                        "success": False,
                        "error": f"Unexpected {type(error).__name__}: {error}",
                    }),
                    ensure_ascii=False,
                )
            )
            return 1

    try:
        result = convert_dwg_to_dxf(
            source=args.source,
            output=args.output,
            report_path=args.report,
            scene_path=args.scene_output,
            converter=args.converter,
            version=args.version,
            timeout=args.timeout,
            overwrite=args.overwrite,
        )
    except ConversionError as error:
        print(json.dumps(_json_safe({"success": False, "error": str(error)}), ensure_ascii=False))
        return 1
    except Exception as error:
        print(
            json.dumps(
                _json_safe({
                    "success": False,
                    "error": f"Unexpected {type(error).__name__}: {error}",
                }),
                ensure_ascii=False,
            )
        )
        return 1

    print(json.dumps(_json_safe(result), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
