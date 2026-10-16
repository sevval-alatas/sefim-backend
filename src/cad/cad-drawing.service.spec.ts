import { Test, TestingModule } from '@nestjs/testing';
import { CadDrawingService } from './cad-drawing.service.js';
import { db } from '../prisma/db.js';

// Mock db
jest.mock('../prisma/db.js', () => ({
  db: {
    orm: {
      public: {
        CadDrawing: {
          create: jest.fn(),
          where: jest.fn(),
        },
      },
    },
  },
}));

describe('CadDrawingService', () => {
  let service: CadDrawingService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [CadDrawingService],
    }).compile();

    service = module.get<CadDrawingService>(CadDrawingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('saveUploadedDrawing', () => {
    it('should save uploaded drawing and create DB record', async () => {
      const mockDwgHeader = Buffer.from('AC1032\0\0\0\0');
      const mockFile = {
        buffer: mockDwgHeader,
        originalname: 'test_drawing.dwg',
      } as Express.Multer.File;

      const mockDbRecord = {
        id: 'test-id',
        deviceId: 'device-456',
        originalFileName: 'test_drawing.dwg',
        fileSizeBytes: mockDwgHeader.length,
        dwgVersion: 'AutoCAD 2018 / 2021 / 2024 (AC1032)',
        originalFilePath: '/tmp/test.dwg',
        status: 'pending',
      };

      (db.orm.public.CadDrawing.create as jest.Mock).mockResolvedValue(mockDbRecord);

      const result = await service.saveUploadedDrawing(mockFile, 'device-456');

      expect(db.orm.public.CadDrawing.create).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'device-456',
          originalFileName: 'test_drawing.dwg',
          fileSizeBytes: mockDwgHeader.length,
          status: 'pending',
        }),
      );
      expect(result.id).toBeDefined();
      expect(result.deviceId).toBe('device-456');
    });
  });

  describe('markConversionSuccess', () => {
    it('should update DB record on success', async () => {
      const updateMock = jest.fn().mockResolvedValue({});
      (db.orm.public.CadDrawing.where as jest.Mock).mockReturnValue({ update: updateMock });

      await service.markConversionSuccess('test-id', {
        convertedFormat: 'dxf',
        convertedFileName: 'test.dxf',
        tempOutputPath: '/nonexistent/temp.dxf',
      });

      expect(db.orm.public.CadDrawing.where).toHaveBeenCalledWith({ id: 'test-id' });
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          convertedFormat: 'dxf',
          convertedFileName: 'test.dxf',
        }),
      );
    });
  });

  describe('markConversionFailed', () => {
    it('should update DB record on failure', async () => {
      const updateMock = jest.fn().mockResolvedValue({});
      (db.orm.public.CadDrawing.where as jest.Mock).mockReturnValue({ update: updateMock });

      await service.markConversionFailed('test-id', 'Conversion failed due to invalid header');

      expect(db.orm.public.CadDrawing.where).toHaveBeenCalledWith({ id: 'test-id' });
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'Conversion failed due to invalid header',
        }),
      );
    });
  });

  describe('getDrawingsByDeviceId', () => {
    it('should return empty list if deviceId is empty', async () => {
      const list = await service.getDrawingsByDeviceId('');
      expect(list).toEqual([]);
      expect(db.orm.public.CadDrawing.where).not.toHaveBeenCalled();
    });

    it('should return drawings for deviceId', async () => {
      const allMock = jest.fn().mockResolvedValue([
        {
          id: 'test-1',
          deviceId: 'dev-1',
          originalFileName: 'plan.dwg',
          fileSizeBytes: 500,
          dwgVersion: 'AC1032',
          convertedFormat: 'dxf',
          convertedFileName: 'plan.dxf',
          status: 'success',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      const orderByMock = jest.fn().mockReturnValue({ all: allMock });
      (db.orm.public.CadDrawing.where as jest.Mock).mockReturnValue({ orderBy: orderByMock });

      const list = await service.getDrawingsByDeviceId('dev-1');
      expect(db.orm.public.CadDrawing.where).toHaveBeenCalledWith({ deviceId: 'dev-1' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('test-1');
      expect(list[0].downloadUrl).toBe('/api/cad/drawings/test-1/download');
    });
  });
});

