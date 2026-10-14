"""HTTP wrapper for the project's EasyOCR delivery-note reader.

Run with: python3 ocr/ocr_service.py
The model is loaded once and reused for uploaded images.
"""

import base64
import json
import os
import re
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

warnings.filterwarnings("ignore", message=".*quantize_per_tensor.*")

import cv2
import easyocr
import numpy as np
from PIL import Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass


def preprocess_image(image_bytes):
    """Apply EXIF orientation, size normalization and CLAHE to image bytes."""
    import io

    try:
        image = Image.open(io.BytesIO(image_bytes))
    except Exception:
        return None

    image = ImageOps.exif_transpose(image).convert("RGB")
    pixels = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape

    min_width = 1800
    max_width = 3000
    if width < min_width:
        ratio = min_width / float(width)
        gray = cv2.resize(
            gray, (min_width, int(height * ratio)), interpolation=cv2.INTER_LANCZOS4
        )
    elif width > max_width:
        ratio = max_width / float(width)
        gray = cv2.resize(
            gray, (max_width, int(height * ratio)), interpolation=cv2.INTER_AREA
        )

    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)


def extract_fields(full_text):
    """Extract the same delivery-note header fields as the supplied script."""
    result = {
        "documentDate": None,
        "documentTime": None,
        "documentNumber": None,
        "vehiclePlate": None,
        "concreteStrength": None,
        "productionQuantity": None,
        # The supplied script initializes this to '-' and does not parse it.
        "orderQuantity": None,
    }
    lines = [line.strip() for line in full_text.split("\n") if line.strip()]

    match = re.search(r"\b(BCE\s*\d{10,14})\b", full_text, re.IGNORECASE)
    if not match:
        match = re.search(
            r"(?:E[- ]?Irsaliye|İrsaliye)[^\n\d]*([A-Z0-9]{13,17})",
            full_text,
            re.IGNORECASE,
        )
    if not match:
        match = re.search(r"\b((?:H\d{2}|GIB|[A-Z]{3})\s*\d{10,14})\b", full_text, re.IGNORECASE)
    if match:
        result["documentNumber"] = re.sub(r"\s+", "", match.group(1)).upper()

    timestamp = re.search(
        r"(\b\d{1,2}[\s.,/-]\s*\d{1,2}[\s.,/-]\s*(?:20)?\d{2,4}\b)\s*([0-2]?\d[:.,][0-5]\d(?:[:.,][0-5]\d)?)",
        full_text,
    )
    if timestamp:
        date_parts = re.split(r"[\s.,/-]+", timestamp.group(1).strip())
        if len(date_parts) >= 3 and len(date_parts[0]) <= 2:
            year = date_parts[2] if len(date_parts[2]) == 4 else f"20{date_parts[2]}"
            result["documentDate"] = f"{int(date_parts[0]):02d}-{int(date_parts[1]):02d}-{year}"
            result["documentTime"] = re.sub(r"[,.]", ":", timestamp.group(2))[:8]

    if not result["documentDate"]:
        dates = re.findall(r"(\b\d{1,2}[\s.,/-]\s*\d{1,2}[\s.,/-]\s*(?:20)?\d{2,4}\b)", full_text)
        for date_text in dates:
            cleaned = re.sub(r"\s+", "", date_text)
            parts = re.split(r"[.,/-]", cleaned)
            if len(parts) >= 3:
                year = parts[2] if len(parts[2]) == 4 else f"20{parts[2]}"
                result["documentDate"] = f"{int(parts[0]):02d}-{int(parts[1]):02d}-{year}"
                break

    if not result["documentTime"]:
        times = re.findall(r"\b([0-2]?\d[:.,][0-5]\d(?:[:.,][0-5]\d)?)\b", full_text)
        if times:
            result["documentTime"] = re.sub(r"[,.]", ":", times[0])[:8]

    double_strength = re.search(r"\b([cC]\s*\d{2}\s*[/\\|!]\s*\d{2})\b", full_text)
    if double_strength:
        result["concreteStrength"] = (
            re.sub(r"\s+", "", double_strength.group(1))
            .upper()
            .replace("\\", "/")
            .replace("|", "/")
            .replace("!", "/")
        )
    else:
        strength = re.search(r"\b([cC]\s*\d{2})\b", full_text, re.IGNORECASE)
        if strength:
            result["concreteStrength"] = re.sub(r"\s+", "", strength.group(1)).upper()

    for index, line in enumerate(lines):
        if any(token in line.lower() for token in ["mikser", "plaka", "mo1", "m01"]):
            nearby = " ".join(lines[index : min(index + 3, len(lines))])
            plate = re.search(r"\b([0-8][0-9O]\s*[A-Z]{1,3}\s*[0-9O]{2,4})\b", nearby.upper())
            if plate:
                cleaned = plate.group(1).replace("O", "0")
                if not cleaned.startswith("C") and not cleaned.replace(" ", "").isdigit():
                    result["vehiclePlate"] = re.sub(r"\s+", " ", cleaned).strip()
                    break

    if not result["vehiclePlate"]:
        plates = re.findall(r"\b([0-8][0-9O]\s*[A-Z]{1,3}\s*[0-9O]{2,4})\b", full_text.upper())
        for plate in plates:
            cleaned = plate.replace("O", "0")
            if not cleaned.startswith("C") and not cleaned.replace(" ", "").isdigit():
                result["vehiclePlate"] = re.sub(r"\s+", " ", cleaned).strip()
                break

    for index, line in enumerate(lines):
        if "beton miktar" in line.lower():
            nearby = " ".join(lines[index : min(index + 3, len(lines))])
            quantity = re.search(r"(\d+[.,]\d+|\d+)\s*(?:m3|m³)?", nearby, re.IGNORECASE)
            if quantity:
                value = float(quantity.group(1).replace(",", "."))
                if 1.0 <= value <= 20.0:
                    result["productionQuantity"] = value
                    break

    if result["productionQuantity"] is None:
        quantities = re.findall(r"(\d+(?:[.,]\d+)?)\s*(?:m3|m³)", full_text, re.IGNORECASE)
        for raw_value in quantities:
            value = float(raw_value.replace(",", "."))
            if value >= 1.0:
                result["productionQuantity"] = value
                break

    return result


class OCRHandler(BaseHTTPRequestHandler):
    reader = None
    reader_lock = Lock()

    def do_POST(self):
        if self.path != "/ocr":
            self._respond(404, {"error": "not_found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 18 * 1024 * 1024:
                self._respond(413, {"error": "invalid_image_size"})
                return
            payload = json.loads(self.rfile.read(length))
            image_bytes = base64.b64decode(payload["imageBase64"], validate=True)
            processed = preprocess_image(image_bytes)
            if processed is None:
                self._respond(422, {"error": "image_cannot_be_read"})
                return

            with self.reader_lock:
                lines = self.reader.readtext(processed, detail=0)
            raw_text = "\n".join(lines)
            self._respond(200, {**extract_fields(raw_text), "rawText": raw_text})
        except Exception:
            self._respond(500, {"error": "ocr_processing_failed"})

    def _respond(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    print("Loading EasyOCR Turkish/English models…", flush=True)
    OCRHandler.reader = easyocr.Reader(["tr", "en"], gpu=False)
    host = os.environ.get("OCR_SERVICE_HOST", "127.0.0.1")
    port = int(os.environ.get("OCR_SERVICE_PORT", "8010"))
    server = ThreadingHTTPServer((host, port), OCRHandler)
    print(f"OCR service listening on http://{host}:{port}", flush=True)
    server.serve_forever()
