#!/usr/bin/env python3
"""
DWG dosyasındaki TÜM katmanlardaki TÜM nesneleri (çizim yöntemi ve renk
fark etmeksizin) yakalayıp JSON üzerinden döndüren işleyici.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# AutoCAD DWG sürüm imzaları: AC1012 (R13) ile AC1040 (gelecek sürümler) arası
DWG_SIGNATURES = {f"AC{version}".encode("ascii") for version in range(1012, 1041)}


class WorkerError(Exception):
    pass


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, allow_nan=False))


def convert_dwg_to_raw_dxf(dwg_path: Path, output_dir: Path) -> Path:
    """LibreDWG (dwg2dxf) ile DWG'yi ham bir DXF dosyasına dönüştürür."""
    try:
        result = subprocess.run(
            ["dwg2dxf", "-o", str(output_dir), str(dwg_path)],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if result.returncode == 0:
            dxf_files = list(output_dir.glob("*.dxf"))
            if dxf_files:
                return dxf_files[0]
        err_msg = result.stderr.strip() if result.stderr else "Bilinmeyen hata"
        raise WorkerError(f"dwg2dxf dönüştürmesi başarısız oldu: {err_msg}")
    except FileNotFoundError:
        raise WorkerError("Sistemde 'dwg2dxf' komutu bulunamadı (LibreDWG kurulu olmalı).")
    except Exception as exc:
        raise WorkerError(f"DWG dönüştürme hatası: {exc}") from exc


def _entity_bounds(entity: Any) -> dict[str, Any] | None:
    """Bir varlığın sınır kutusunu (bounding box) ve ana koordinatlarını döndürür."""
    try:
        dxftype = entity.dxftype
        points: list[tuple[float, float]] = []

        if dxftype == "LWPOLYLINE":
            points = [(float(p[0]), float(p[1])) for p in entity.to_points()]

        elif dxftype == "POLYLINE":
            vertices = list(entity.vertices)
            points = [
                (float(v.dxf.location.x), float(v.dxf.location.y)) for v in vertices
            ]

        elif dxftype == "LINE":
            start = entity.dxf.start
            end = entity.dxf.end
            points = [(float(start.x), float(start.y)), (float(end.x), float(end.y))]

        elif dxftype == "CIRCLE":
            center = entity.dxf.center
            r = float(entity.dxf.radius)
            cx, cy = float(center.x), float(center.y)
            points = [
                (cx - r, cy - r),
                (cx + r, cy + r),
            ]

        elif dxftype == "ARC":
            center = entity.dxf.center
            r = float(entity.dxf.radius)
            cx, cy = float(center.x), float(center.y)
            points = [
                (cx - r, cy - r),
                (cx + r, cy + r),
            ]

        elif dxftype == "INSERT":
            ins = entity.dxf.insert
            points = [(float(ins.x), float(ins.y))]

        elif dxftype == "TEXT":
            ins = entity.dxf.insert
            points = [(float(ins.x), float(ins.y))]

        elif dxftype == "MTEXT":
            ins = entity.dxf.insert
            points = [(float(ins.x), float(ins.y))]

        else:
            # Diğer varlık türleri için temel insert/konum bilgisini almaya çalış
            insert = getattr(entity.dxf, "insert", None)
            if insert is not None:
                points = [(float(insert.x), float(insert.y))]
            else:
                return None

        if not points:
            return None

        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        if not all(math.isfinite(v) for v in (*xs, *ys)):
            return None

        return {
            "min_x": min(xs),
            "min_y": min(ys),
            "max_x": max(xs),
            "max_y": max(ys),
            "points": points[:10],  # İlk 10 nokta (JSON boyutu kontrolü için)
        }

    except Exception:
        return None


def extract_all_entities(dxf_path: Path) -> dict[str, Any]:
    """
    DXF dosyasındaki TÜM modelspace varlıklarını katman, renk ve
    çizim yöntemi filtresi olmadan toplar ve JSON-dostu bir yapı döndürür.
    """
    try:
        import ezdxf
    except ImportError:
        raise WorkerError("Gerekli 'ezdxf' kütüphanesi yüklü değil.")

    try:
        doc = ezdxf.readfile(str(dxf_path))
    except Exception as error:
        raise WorkerError(f"DXF dosyası okunamadı: {error}") from error

    msp = doc.modelspace()
    all_entities = list(msp)

    captured: list[dict[str, Any]] = []
    layers_found: set[str] = set()
    entity_types: dict[str, int] = {}

    for entity in all_entities:
        try:
            dxftype = entity.dxftype
            layer = str(getattr(entity.dxf, "layer", "0"))
            color = getattr(entity.dxf, "color", 256)  # 256 = BYLAYER
            linetype = str(getattr(entity.dxf, "linetype", "BYLAYER"))

            layers_found.add(layer)
            entity_types[dxftype] = entity_types.get(dxftype, 0) + 1

            bounds = _entity_bounds(entity)

            color_info = color
            try:
                color_info = int(color)
            except (ValueError, TypeError):
                pass

            captured.append({
                "handle": str(entity.dxf.handle),
                "type": dxftype,
                "layer": layer,
                "color": color_info,
                "linetype": linetype,
                "bounds": bounds,
            })
        except Exception:
            # Tek bir varlık hatalıysa atla, diğerlerini devam ettir
            continue

    return {
        "success": True,
        "total_entities": len(captured),
        "layers_found": sorted(layers_found),
        "entity_types": entity_types,
        "entities": captured,
    }


def process_dwg(dwg_path: Path) -> dict[str, Any]:
    if not dwg_path.is_file():
        raise WorkerError("Belirtilen DWG dosyası bulunamadı.")
    if dwg_path.stat().st_size < 6:
        raise WorkerError("Dosya boyutu geçerli bir DWG için çok küçük.")

    with dwg_path.open("rb") as f:
        signature = f.read(6)
    if signature not in DWG_SIGNATURES:
        raise WorkerError("Geçersiz veya desteklenmeyen DWG sürüm imzası.")

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_dir_path = Path(temp_dir)
        raw_dxf = convert_dwg_to_raw_dxf(dwg_path, temp_dir_path)
        return extract_all_entities(raw_dxf)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        emit({
            "success": False,
            "error": "Kullanım: python main.py /yol/proje.dwg",
        })
        return 2

    dwg_file = Path(argv[1]).expanduser().resolve()

    try:
        result = process_dwg(dwg_file)
        emit(result)
        return 0
    except WorkerError as error:
        emit({"success": False, "error": str(error)})
        return 1
    except Exception as error:
        emit({"success": False, "error": f"Beklenmeyen işleyici hatası: {error}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
