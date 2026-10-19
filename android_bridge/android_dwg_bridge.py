"""Android .so DWG okucusu köprüsü.

Bu servis, APK'den çıkarılan ARM64 .so kütüphanesini ctypes üzerinden yükleyip
HTTP üzerinden DWG okuma işlevini açar. NestJS backend bunu
ANDROID_DWG_BRIDGE_URL ile çağırır.

Çalıştırma (Android/Termux/ARM64 Linux):
    python android_bridge/android_dwg_bridge.py

Ortam değişkenleri:
    ANDROID_DWG_SO_PATH   .so dosyasının tam yolu (zorunlu)
    ANDROID_DWG_FUNC_NAME .so içindeki DWG okuma fonksiyon adı (varsayılan: read_dwg)
    ANDROID_DWG_HOST      Dinlenecek host (varsayılan: 127.0.0.1)
    ANDROID_DWG_PORT      Dinlenecek port (varsayılan: 8020)
"""

import base64
import ctypes
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

SO_PATH = os.environ.get("ANDROID_DWG_SO_PATH", "")
FUNC_NAME = os.environ.get("ANDROID_DWG_FUNC_NAME", "read_dwg")
HOST = os.environ.get("ANDROID_DWG_HOST", "127.0.0.1")
PORT = int(os.environ.get("ANDROID_DWG_PORT", "8020"))

_lib = None
_lib_lock = Lock()
_load_error = None


def load_lib():
    global _lib, _load_error
    if _lib is not None:
        return _lib
    if not SO_PATH:
        _load_error = "ANDROID_DWG_SO_PATH tanımlanmamış"
        return None
    if not os.path.exists(SO_PATH):
        _load_error = f".so dosyası bulunamadı: {SO_PATH}"
        return None
    try:
        with _lib_lock:
            if _lib is None:
                _lib = ctypes.CDLL(SO_PATH)
    except Exception as exc:
        _load_error = f".so yüklenemedi: {exc}"
        return None
    return _lib


class DwgBridgeHandler(BaseHTTPRequestHandler):
    def _respond(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ("/read-dwg", "/ocr"):
            self._respond(404, {"error": "not_found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 100 * 1024 * 1024:
                self._respond(413, {"error": "invalid_file_size"})
                return

            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self._respond(400, {"error": "multipart_form_data_required"})
                return

            # Basit multipart parser (kullanıcı dostu, genişletilebilir)
            boundary = content_type.split("boundary=")[-1].strip().encode()
            raw = self.rfile.read(length)

            file_name = "upload.dwg"
            file_data = None

            parts = raw.split(b"--" + boundary)
            for part in parts:
                if b"Content-Disposition" not in part:
                    continue
                headers_block, _, body_block = part.partition(b"\r\n\r\n")
                body_block = body_block.rstrip(b"\r\n--")
                if b'name="file"' in headers_block:
                    if b'filename="' in headers_block:
                        start = headers_block.index(b'filename="') + len(b'filename="')
                        end = headers_block.index(b'"', start)
                        file_name = headers_block[start:end].decode("utf-8", errors="replace")
                    file_data = body_block

            if not file_data:
                self._respond(400, {"error": "file_field_required"})
                return

            lib = load_lib()
            if lib is None:
                self._respond(503, {"error": "so_not_loaded", "detail": _load_error or "bilinmeyen hata"})
                return

            func = getattr(lib, FUNC_NAME, None)
            if func is None:
                self._respond(503, {"error": "function_not_found", "detail": FUNC_NAME})
                return

            # Dosyayı geçici dosyaya yaz
            with tempfile.NamedTemporaryFile(delete=False, suffix=".dwg") as tmp:
                tmp.write(file_data)
                tmp_path = tmp.name

            try:
                # Fonksiyon imzası varsayımı: const char* read_dwg(const char* path) -> const char* JSON
                func.argtypes = [ctypes.c_char_p]
                func.restype = ctypes.c_char_p

                result_ptr = func(tmp_path.encode("utf-8"))
                if not result_ptr:
                    self._respond(500, {"success": False, "error": "so_returned_null"})
                    return

                result_text = ctypes.string_at(result_ptr).decode("utf-8", errors="replace")
                try:
                    result = json.loads(result_text)
                except json.JSONDecodeError:
                    result = {"success": False, "error": "invalid_json_from_so", "raw": result_text[:1000]}

                if not isinstance(result, dict):
                    result = {"success": False, "error": "unexpected_so_output"}

                status = 200 if result.get("success") else 400
                self._respond(status, result)
            finally:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

        except Exception as exc:
            self._respond(500, {"success": False, "error": "bridge_exception", "detail": str(exc)})

    def log_message(self, _format, *_args):
        return


def main():
    lib = load_lib()
    if lib:
        print(f".so yüklendi: {SO_PATH}, fonksiyon: {FUNC_NAME}", flush=True)
    else:
        print(f"UYARI: .so yüklenemedi: {_load_error}", flush=True)

    server = ThreadingHTTPServer((HOST, PORT), DwgBridgeHandler)
    print(f"Android DWG Bridge http://{HOST}:{PORT} dinleniyor", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
