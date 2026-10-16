import { BadRequestException } from '@nestjs/common';
import { extname } from 'node:path';

export function isDwgFileName(fileName: string) {
  return extname(fileName).toLowerCase() === '.dwg';
}

export function requireDwgUpload<T>(file: T | undefined | null): T {
  if (!file) {
    throw new BadRequestException('"file" alanında .dwg uzantılı dosya gereklidir');
  }
  return file;
}
