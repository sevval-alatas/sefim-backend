import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1] / "python" / "dwg_worker" / "main.py"


class DwgWorkerCliTests(unittest.TestCase):
    def test_invalid_file_emits_json_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.dwg"
            path.write_bytes(b"this is not a DWG")
            result = subprocess.run(
                [sys.executable, str(WORKER), str(path)],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertNotEqual(result.returncode, 0)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["success"])
        self.assertIn("signature", payload["error"])


if __name__ == "__main__":
    unittest.main()
