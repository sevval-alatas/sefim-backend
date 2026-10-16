
import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { db } from '../prisma/db.js';

interface OCRResult {
  documentDate: string | null;
  documentTime: string | null;
  documentNumber: string | null;
  vehiclePlate: string | null;
  concreteStrength: string | null;
  productionQuantity: number | null;
  orderQuantity: number | null;
  rawText: string;
}

@Injectable()
export class DeliveryNoteService {
  async create(photoUrl: string, createdById: number) {
    const deliveryNote = await db.orm.public.DeliveryNote.create({
      status: 'pending',
      photoUrl,
      createdById,
    });

    try {
      const image = await readFile(photoUrl);
      const ocrUrl = (process.env['OCR_SERVICE_URL'] ?? 'http://127.0.0.1:8010').replace(/\/+$/, '');
      const response = await fetch(`${ocrUrl}/ocr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: image.toString('base64') }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        throw new Error(`OCR service returned ${response.status}`);
      }

      const result = (await response.json()) as OCRResult;
      return db.orm.public.DeliveryNote.where({ id: deliveryNote.id }).update({
        status: 'processed',
        documentDate: result.documentDate,
        documentTime: result.documentTime,
        documentNumber: result.documentNumber,
        vehiclePlate: result.vehiclePlate,
        concreteStrength: result.concreteStrength,
        productionQuantity: result.productionQuantity,
        orderQuantity: result.orderQuantity,
        rawText: result.rawText,
      });
    } catch {
      return db.orm.public.DeliveryNote.where({ id: deliveryNote.id }).update({
        status: 'failed',
      });
    }
  }
}
