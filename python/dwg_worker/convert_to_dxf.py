#!/usr/bin/env python3
"""Convert a DWG with LibreDWG and validate the resulting DXF."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import ezdxf
from ezdxf import bbox

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
MAX_SCENE_ENTITIES = 300_000


class ConversionError(Exception):
    """An expected conversion or validation failure."""


def _short(value: str, limit: int = DIAGNOSTIC_LIMIT) -> str:
    value = value.strip()
    return value if len(value) <= limit else value[-limit:]


def _json_safe(value: Any) -> Any:
    if isinstance(value, str):
        return value.encode("utf-8", errors="replace").decode("utf-8")
    if isinstance(value, dict):
        return {_json_safe(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def _point(values: Any) -> list[float] | None:
    try:
        point = [float(value) for value in tuple(values)[:3]]
    except (TypeError, ValueError, IndexError):
        return None
    while len(point) < 3:
        point.append(0.0)
    return point if all(map(math.isfinite, point)) else None


def _entity_feature(entity: Any) -> dict[str, Any] | None:
    kind = entity.dxftype()
    data = entity.dxf
    layer = data.get("layer", "0")
    feature: dict[str, Any] = {
        "id": data.get("handle"),
        "type": kind,
        "layer": layer,
    }
    if data.hasattr("color"):
        feature["color"] = data.get("color")
    if data.hasattr("true_color"):
        feature["trueColor"] = data.get("true_color")
    if data.hasattr("lineweight"):
        feature["lineweight"] = data.get("lineweight")

    geometry: dict[str, Any]
    if kind == "LINE":
        geometry = {"start": _point(data.start), "end": _point(data.end)}
    elif kind == "LWPOLYLINE":
        geometry = {
            "vertices": [
                {"point": _point((x, y)), "bulge": float(bulge)}
                for x, y, bulge in entity.get_points("xyb")
            ],
            "closed": entity.closed,
            "elevation": float(data.get("elevation", 0.0)),
        }
    elif kind == "POLYLINE":
        geometry = {
            "vertices": [
                {
                    "point": _point(vertex.dxf.location),
                    "bulge": float(vertex.dxf.get("bulge", 0.0)),
                }
                for vertex in entity.vertices
            ],
            "closed": entity.is_closed,
            "mode": "3d" if entity.is_3d_polyline else "2d",
        }
    elif kind == "CIRCLE":
        geometry = {"center": _point(data.center), "radius": float(data.radius)}
    elif kind == "ARC":
        geometry = {
            "center": _point(data.center),
            "radius": float(data.radius),
            "startAngle": float(data.start_angle),
            "endAngle": float(data.end_angle),
        }
    elif kind == "ELLIPSE":
        geometry = {
            "center": _point(data.center),
            "majorAxis": _point(data.major_axis),
            "ratio": float(data.ratio),
            "startParameter": float(data.start_param),
            "endParameter": float(data.end_param),
        }
    elif kind == "POINT":
        geometry = {"point": _point(data.location)}
    elif kind == "TEXT":
        geometry = {
            "text": str(data.get("text", "")),
            "insert": _point(data.insert),
            "height": float(data.get("height", 0.0)),
            "rotation": float(data.get("rotation", 0.0)),
            "widthFactor": float(data.get("width", 1.0)),
            "oblique": float(data.get("oblique", 0.0)),
            "style": str(data.get("style", "Standard")),
        }
    elif kind == "MTEXT":
        geometry = {
            "text": entity.text,
            "insert": _point(data.insert),
            "charHeight": float(data.get("char_height", 0.0)),
            "width": float(data.get("width", 0.0)),
            "rotation": float(data.get("rotation", 0.0)),
            "attachment": int(data.get("attachment_point", 1)),
            "style": str(data.get("style", "Standard")),
        }
    elif kind == "SPLINE":
        geometry = {
            "degree": int(data.get("degree", 3)),
            "closed": entity.closed,
            "controlPoints": [_point(point) for point in entity.control_points],
            "fitPoints": [_point(point) for point in entity.fit_points],
            "knots": [float(value) for value in entity.knots],
            "weights": [float(value) for value in entity.weights],
        }
    elif kind in {"SOLID", "TRACE", "3DFACE"}:
        geometry = {
            "vertices": [
                _point(data.get(f"vtx{index}"))
                for index in range(4)
                if data.hasattr(f"vtx{index}")
            ]
        }
    elif kind == "INSERT":
        geometry = {
            "block": str(data.get("name", "")),
            "insert": _point(data.insert),
            "scale": [
                float(data.get("xscale", 1.0)),
                float(data.get("yscale", 1.0)),
                float(data.get("zscale", 1.0)),
            ],
            "rotation": float(data.get("rotation", 0.0)),
            "columnCount": int(data.get("column_count", 1)),
            "rowCount": int(data.get("row_count", 1)),
            "columnSpacing": float(data.get("column_spacing", 0.0)),
            "rowSpacing": float(data.get("row_spacing", 0.0)),
        }
    elif kind == "DIMENSION":
        geometry = {
            "block": str(data.get("geometry", "")),
            "text": str(data.get("text", "")),
            "measurement": float(data.get("actual_measurement", 0.0)),
            "dimensionType": int(data.get("dimtype", 0)),
        }
    else:
        return None

    feature["geometry"] = geometry
    return feature


def _scene_model(document: Any) -> tuple[dict[str, Any], list[str]]:
    modelspace = document.modelspace()
    bounds = bbox.extents(modelspace, fast=True)
    extents = None
    if bounds.has_data:
        minimum = _point(bounds.extmin)
        maximum = _point(bounds.extmax)
        if minimum and maximum:
            extents = {"min": minimum, "max": maximum}

    features: list[dict[str, Any]] = []
    unsupported: dict[str, int] = {}
    truncated = False

    def collect(entities: Any) -> list[dict[str, Any]]:
        nonlocal truncated
        output = []
        for entity in entities:
            if len(features) >= MAX_SCENE_ENTITIES:
                truncated = True
                break
            try:
                feature = _entity_feature(entity)
                if feature is not None:
                    json.dumps(feature, allow_nan=False)
            except (AttributeError, TypeError, ValueError, IndexError):
                feature = None
            if feature is None:
                kind = entity.dxftype()
                unsupported[kind] = unsupported.get(kind, 0) + 1
                continue
            features.append(feature)
            output.append(feature)
        return output

    modelspace_features = collect(modelspace)
    blocks: dict[str, Any] = {}
    for block in document.blocks:
        name = block.name
        if name.startswith("*Model_Space") or name.startswith("*Paper_Space"):
            continue
        blocks[name] = {
            "basePoint": _point(block.block.dxf.base_point),
            "entities": collect(block),
        }
        if truncated:
            break

    layers = []
    for layer in document.layers:
        layers.append(
            {
                "name": layer.dxf.name,
                "color": layer.dxf.get("color", 7),
                "trueColor": layer.dxf.get("true_color"),
                "lineweight": layer.dxf.get("lineweight", -1),
                "linetype": layer.dxf.get("linetype", "CONTINUOUS"),
                "visible": not layer.is_off() and not layer.is_frozen(),
                "frozen": layer.is_frozen(),
            }
        )

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
        "blocks": blocks,
        "entities": modelspace_features,
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
