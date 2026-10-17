import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


CONVERTER = (
    Path(__file__).resolve().parents[1]
    / "python"
    / "dwg_worker"
    / "convert_to_dxf.py"
)


class DwgConversionCliTests(unittest.TestCase):
    def make_fake_converter(self, directory: Path) -> Path:
        executable = directory / "fake-dwg2dxf"
        executable.write_text(
            f"""#!{sys.executable}
import sys
from pathlib import Path
import ezdxf

args = sys.argv[1:]
output = Path(args[args.index("-o") + 1])
if "--as" in args and args[args.index("--as") + 1] == "r2018":
    output.write_text("not a DXF")
    print("simulated unsupported export", file=sys.stderr)
    raise SystemExit(2)
document = ezdxf.new("R2000")
document.layers.new("Walls")
document.modelspace().add_line((0, 0), (10, 10), dxfattribs={{"layer": "Walls"}})
document.modelspace().add_lwpolyline(
    [(0, 0, 0.5), (4, 0, 0)],
    format="xyb",
    dxfattribs={{"layer": "Walls"}},
)
document.modelspace().add_text("Room 1", dxfattribs={{"insert": (1, 1)}})
document.saveas(output)
""",
            encoding="utf-8",
        )
        executable.chmod(0o755)
        return executable

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CONVERTER), *args],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_invalid_signature_is_reported_as_json(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "invalid.dwg"
            source.write_bytes(b"not a DWG")
            result = self.run_cli(str(source))

        self.assertNotEqual(result.returncode, 0)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["success"])
        self.assertIn("signature", payload["error"].lower())

    def test_falls_back_validates_report_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "plan.dwg"
            original_bytes = b"AC1032" + b"\0" * 32
            source.write_bytes(original_bytes)
            fake_converter = self.make_fake_converter(root)

            result = self.run_cli(
                str(source),
                "--converter",
                str(fake_converter),
            )

            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            output = root / "plan.dxf"
            report_path = root / "plan.report.json"
            scene_path = root / "plan.scene.json"
            self.assertTrue(output.is_file())
            self.assertTrue(report_path.is_file())
            self.assertTrue(scene_path.is_file())
            self.assertEqual(source.read_bytes(), original_bytes)
            self.assertTrue(payload["success"])
            self.assertGreater(payload["output_bytes"], 0)
            self.assertEqual(payload["strategy"], "LibreDWG native DXF version")
            self.assertEqual(payload["modelspace_entity_count"], 3)
            self.assertEqual(payload["modelspace_entities_by_layer"]["Walls"], 2)
            self.assertEqual(payload["audit_error_count"], 0)
            self.assertEqual(payload["attempts"][0]["return_code"], 2)
            self.assertFalse(payload["attempts"][0]["validated"])
            self.assertTrue(payload["attempts"][1]["validated"])
            self.assertEqual(json.loads(report_path.read_text())["dxf_version"], "AC1015")
            scene = json.loads(scene_path.read_text())
            self.assertEqual(scene["schema"], "sefim-cad-scene/1")
            self.assertEqual(scene["entityCount"], 3)
            self.assertIsNotNone(scene["extents"])
            self.assertLess(scene["extents"]["min"][0], scene["extents"]["max"][0])
            self.assertIn("Walls", [layer["name"] for layer in scene["layers"]])
            self.assertEqual(scene["entities"][0]["type"], "LINE")
            polyline = next(entity for entity in scene["entities"] if entity["type"] == "LWPOLYLINE")
            self.assertEqual(polyline["geometry"]["vertices"][0]["bulge"], 0.5)

    def test_refuses_to_overwrite_existing_output_without_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "plan.dwg"
            source.write_bytes(b"AC1032" + b"\0" * 32)
            (root / "plan.dxf").write_text("keep existing file")
            fake_converter = self.make_fake_converter(root)

            result = self.run_cli(
                str(source),
                "--converter",
                str(fake_converter),
            )

            self.assertNotEqual(result.returncode, 0)
            payload = json.loads(result.stdout)
            self.assertIn("already exists", payload["error"])
            self.assertEqual((root / "plan.dxf").read_text(), "keep existing file")

    def test_validate_only_reads_and_audits_existing_dxf(self):
        import ezdxf

        with tempfile.TemporaryDirectory() as directory:
            dxf_path = Path(directory) / "plan.dxf"
            document = ezdxf.new("R2000")
            document.modelspace().add_line((0, 0), (10, 10))
            document.saveas(dxf_path)

            result = self.run_cli(str(dxf_path), "--validate-only")

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["success"])
        self.assertEqual(payload["modelspace_entity_count"], 1)
        self.assertEqual(payload["audit_error_count"], 0)

    def test_validate_only_can_export_mobile_scene(self):
        import ezdxf

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dxf_path = root / "plan.dxf"
            scene_path = root / "scene.json"
            document = ezdxf.new("R2000")
            document.modelspace().add_circle((2, 3), 4)
            block = document.blocks.new("Furniture")
            block.add_line((0, 0), (1, 1))
            document.modelspace().add_blockref("Furniture", (10, 10))
            document.saveas(dxf_path)

            result = self.run_cli(
                str(dxf_path),
                "--validate-only",
                "--scene-output",
                str(scene_path),
            )

            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            scene = json.loads(scene_path.read_text())
            self.assertEqual(scene["entities"][0]["type"], "CIRCLE")
            self.assertEqual(scene["entities"][0]["geometry"]["radius"], 4)
            self.assertEqual(scene["entities"][1]["type"], "INSERT")
            self.assertIsNotNone(scene["entities"][1]["geometry"]["insert"])
            self.assertEqual(scene["blocks"]["Furniture"]["entities"][0]["type"], "LINE")


if __name__ == "__main__":
    unittest.main()
