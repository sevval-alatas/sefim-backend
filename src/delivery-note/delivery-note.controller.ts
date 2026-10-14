import {
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { basename } from 'node:path';
import type { Request } from 'express';
import { JwtAuthGuard, type AuthenticatedUser } from '../auth/jwt-auth.guard.js';
import { DeliveryNoteService } from './delivery-note.service.js';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('delivery-notes')
export class DeliveryNoteController {
  constructor(
    private readonly deliveryNoteService: DeliveryNoteService,
  ) {}

  @Get()
  getAll() {
    return {
      message: 'Delivery notes endpoint çalışıyor',
    };
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: diskStorage({
        destination: './uploads',
        filename: (_req, file, cb) => {
          const safeName = basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
          const uniqueName = `${Date.now()}-${safeName}`;
          cb(null, uniqueName);
        },
      }),
      limits: { fileSize: 15 * 1024 * 1024, files: 1 },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          cb(new Error('Only image uploads are supported'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async uploadDeliveryNote(
    @UploadedFile() photo: Express.Multer.File,
    @Req() request: AuthenticatedRequest,
  ) {
    const deliveryNote = await this.deliveryNoteService.create(photo.path, request.user.id);

    return {
      message: 'İrsaliye fotoğrafı alındı',
      fileName: photo.originalname,
      savedFileName: photo.filename,
      mimeType: photo.mimetype,
      size: photo.size,
      deliveryNote,
    };
  }
}
