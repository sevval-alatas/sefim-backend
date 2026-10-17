import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DwgConverterService,
  inspectDwgHeader,
  optimizeDxfForViewing,
  parseLibreDwgError,
} from './dwg-converter.service.js';

describe('DwgConverterService', () => {
  let service: DwgConverterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DwgConverterService],
    }).compile();

    service = module.get<DwgConverterService>(DwgConverterService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should resolve a converter command', () => {
    const command = service.resolveConverterCommand();
    expect(command).toBeDefined();
    expect(typeof command).toBe('string');
  });

  it('should check if converter is available in the system', async () => {
    const status = await service.checkConverterAvailable();
    expect(status).toHaveProperty('pdfConverter');
    expect(status).toHaveProperty('dxfConverter');
    expect(status).toHaveProperty('pythonDxfConverter');
    expect(status.pdfConverter).toHaveProperty('available');
    expect(status.dxfConverter).toHaveProperty('available');
    expect(status.pythonDxfConverter).toHaveProperty('available');
  });

  it('should throw BadRequestException if file buffer is empty', async () => {
    const dummyFile = {
      buffer: Buffer.alloc(0),
      originalname: 'test.dwg',
    } as Express.Multer.File;

    await expect(service.convert(dummyFile)).rejects.toThrow(BadRequestException);
  });

  describe('inspectDwgHeader', () => {
    it('should correctly identify AutoCAD 2018 (AC1032) signature', () => {
      const buffer = Buffer.from('AC1032\x00\x00\x00\x00extra data');
      const info = inspectDwgHeader(buffer);
      expect(info.isValidSignature).toBe(true);
      expect(info.signature).toBe('AC1032');
      expect(info.versionName).toContain('AutoCAD 2018');
    });

    it('should correctly identify AutoCAD 2013 (AC1027) signature', () => {
      const buffer = Buffer.from('AC1027\x00\x00\x00\x00extra data');
      const info = inspectDwgHeader(buffer);
      expect(info.isValidSignature).toBe(true);
      expect(info.signature).toBe('AC1027');
      expect(info.versionName).toContain('AutoCAD 2013');
    });

    it('should detect DXF file mistakenly uploaded as DWG', () => {
      const buffer = Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC');
      const info = inspectDwgHeader(buffer);
      expect(info.isValidSignature).toBe(false);
      expect(info.isDxf).toBe(true);
    });

    it('should detect PDF file mistakenly uploaded as DWG', () => {
      const buffer = Buffer.from('%PDF-1.5 some pdf data');
      const info = inspectDwgHeader(buffer);
      expect(info.isValidSignature).toBe(false);
      expect(info.isPdf).toBe(true);
    });

    it('should reject invalid arbitrary signature', () => {
      const buffer = Buffer.from('NOTADWGFILE');
      const info = inspectDwgHeader(buffer);
      expect(info.isValidSignature).toBe(false);
      expect(info.description).toContain('geçerli bir DWG imzası');
    });
  });

  describe('parseLibreDwgError', () => {
    it('should identify READ ERROR 0x800', () => {
      const reason = parseLibreDwgError('ERROR: Failed to decode file: test.dwg 0x800\nREAD ERROR 0x800', '');
      expect(reason).toContain('0x800');
    });

    it('should identify unhandled proxy classes (0x40)', () => {
      const reason = parseLibreDwgError('WARNING: UNHANDLEDCLASS 0x40 in entity', '');
      expect(reason).toContain('proxy');
    });

    it('should identify CRC errors (0x20)', () => {
      const reason = parseLibreDwgError('ERROR: WRONGCRC 0x20', '');
      expect(reason).toContain('CRC');
    });
  });

  it('should throw BadRequestException with detailed diagnostics for non-DWG file', async () => {
    const fakeFile = {
      buffer: Buffer.from('Hello this is just a text file'),
      originalname: 'proje.dwg',
    } as Express.Multer.File;

    await expect(service.convert(fakeFile)).rejects.toThrow(BadRequestException);
  });

  it('preserves valid DXF group-code/value pairs during viewing optimization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sefim-dxf-optimize-'));
    const filePath = join(directory, 'drawing.dxf');
    const content = [
      '0', 'SECTION', '2', 'HEADER', '9', '$LWDISPLAY', '290', '1',
      '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE',
      '5', 'A1', '1001', 'APP', '1070', '43', '1071', '1', '43', '2.5', '370', '25',
      '0', 'ENDSEC', '0', 'EOF', '',
    ].join('\n');

    try {
      await writeFile(filePath, content);
      await optimizeDxfForViewing(filePath);
      const optimized = await readFile(filePath, 'utf8');

      expect(optimized).toContain('1070\n43\n1071\n1\n43\n0.0\n370\n0');
      expect(optimized).toContain('9\n$LWDISPLAY\n290\n0');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
