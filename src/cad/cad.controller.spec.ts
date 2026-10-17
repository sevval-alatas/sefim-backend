import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { CadController } from './cad.controller.js';
import { CadDrawingService } from './cad-drawing.service.js';
import { DwgConverterService } from './dwg-converter.service.js';

describe('CadController', () => {
  let controller: CadController;

  const mockCadDrawingService = {
    saveUploadedDrawing: jest.fn().mockResolvedValue({
      id: 'mock-drawing-uuid',
      deviceId: 'device-123',
      originalFileName: 'project.dwg',
      fileSizeBytes: 1024,
      status: 'pending',
    }),
    markConversionSuccess: jest.fn().mockResolvedValue(undefined),
    markConversionFailed: jest.fn().mockResolvedValue(undefined),
    getDrawingsByDeviceId: jest.fn().mockResolvedValue([
      {
        id: 'mock-drawing-uuid',
        deviceId: 'device-123',
        originalFileName: 'project.dwg',
        fileSizeBytes: 1024,
        status: 'success',
        convertedFormat: 'dxf',
        convertedFileName: 'project.dxf',
        downloadUrl: '/api/cad/drawings/mock-drawing-uuid/download',
      },
    ]),
    getDrawingById: jest.fn().mockResolvedValue({
      id: 'mock-drawing-uuid',
      deviceId: 'device-123',
      originalFileName: 'project.dwg',
      fileSizeBytes: 1024,
      status: 'success',
      convertedFormat: 'dxf',
      convertedFileName: 'project.dxf',
      originalFilePath: '/tmp/test.dwg',
      convertedFilePath: '/tmp/test.dxf',
    }),
    deleteDrawing: jest.fn().mockResolvedValue(true),
    toResponseDto: jest.fn().mockImplementation((record) => record),
  };

  const mockConverterService = {
    checkConverterAvailable: jest.fn().mockResolvedValue({
      pdfConverter: { available: true, command: '/Applications/QCAD.app/Contents/Resources/dwg2pdf' },
      dxfConverter: { available: true, command: 'dwg2dxf' },
      pythonDxfConverter: {
        available: true,
        command: '.venv-dwg/bin/python',
        script: 'python/dwg_worker/convert_to_dxf.py',
      },
    }),
    convert: jest.fn().mockImplementation(async (_file, format) => {
      if (format === 'pdf') {
        return {
          fileId: 'mock-file-id',
          fileName: 'project.pdf',
          outputPath: '/tmp/sefim-cad/mock-file-id/output.pdf',
          jobDirectory: '/tmp/sefim-cad/mock-file-id',
          downloadUrl: '/api/cad/files/mock-file-id',
          format: 'pdf',
        };
      }
      return {
        fileId: 'mock-file-id',
        fileName: 'project.dxf',
        outputPath: '/tmp/sefim-cad/mock-file-id/output.dxf',
        jobDirectory: '/tmp/sefim-cad/mock-file-id',
        downloadUrl: '/api/cad/files/mock-file-id',
        format: 'dxf',
        mobileScenePath: '/tmp/sefim-cad/mock-file-id/output.scene.json',
      };
    }),
    convertToPdf: jest.fn().mockResolvedValue({
      fileId: 'mock-file-id',
      fileName: 'project.pdf',
      outputPath: '/tmp/sefim-cad/mock-file-id/output.pdf',
      jobDirectory: '/tmp/sefim-cad/mock-file-id',
      downloadUrl: '/api/cad/files/mock-file-id',
      format: 'pdf',
    }),
    convertToDxf: jest.fn().mockResolvedValue({
      fileId: 'mock-file-id',
      fileName: 'project.dxf',
      outputPath: '/tmp/sefim-cad/mock-file-id/output.dxf',
      jobDirectory: '/tmp/sefim-cad/mock-file-id',
      downloadUrl: '/api/cad/files/mock-file-id',
      format: 'dxf',
    }),
    getConvertedFile: jest.fn().mockResolvedValue({
      path: '/tmp/sefim-cad/mock-file-id/output.pdf',
      name: 'project.pdf',
      jobDirectory: '/tmp/sefim-cad/mock-file-id',
      mimeType: 'application/pdf',
    }),
    cleanup: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CadController],
      providers: [
        {
          provide: DwgConverterService,
          useValue: mockConverterService,
        },
        {
          provide: CadDrawingService,
          useValue: mockCadDrawingService,
        },
      ],
    }).compile();

    controller = module.get<CadController>(CadController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getStatus', () => {
    it('should return converter status', async () => {
      const status = await controller.getStatus();
      expect(status).toHaveProperty('pdfConverter');
      expect(status).toHaveProperty('dxfConverter');
      expect(mockConverterService.checkConverterAvailable).toHaveBeenCalled();
    });
  });

  describe('convert', () => {
    it('should throw BadRequestException when no file is uploaded', async () => {
      const res = {} as Response;
      await expect(
        controller.convert(undefined as unknown as Express.Multer.File, res),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return JSON response when format=json is requested', async () => {
      const mockFile = {
        buffer: Buffer.from('mock dwg data'),
        originalname: 'test.dwg',
      } as Express.Multer.File;

      const jsonMock = jest.fn();
      const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      const res = {
        status: statusMock,
      } as unknown as Response;

      await controller.convert(mockFile, res, 'json');

      expect(mockConverterService.convert).toHaveBeenCalledWith(
        mockFile,
        'auto',
        expect.objectContaining({ paper: 'A0' }),
      );
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          drawingId: 'mock-drawing-uuid',
          deviceId: 'anonymous-device',
          fileId: 'mock-file-id',
          fileName: 'project.dxf',
          format: 'dxf',
          fallbackUsed: false,
          downloadUrl: '/api/cad/drawings/mock-drawing-uuid/download',
          mobileSceneUrl: '/api/cad/drawings/mock-drawing-uuid/scene',
          tempDownloadUrl: '/api/cad/files/mock-file-id',
        }),
      );
    });

    it('should save drawing with provided deviceId header or query', async () => {
      const mockFile = {
        buffer: Buffer.from('mock dwg data'),
        originalname: 'test.dwg',
      } as Express.Multer.File;

      const setHeaderMock = jest.fn();
      const downloadMock = jest.fn((path, name, callback) => {
        if (callback) callback();
      });
      const res = {
        setHeader: setHeaderMock,
        download: downloadMock,
      } as unknown as Response;

      await controller.convert(mockFile, res, undefined, undefined, undefined, 'device-xyz');

      expect(mockCadDrawingService.saveUploadedDrawing).toHaveBeenCalledWith(mockFile, 'device-xyz');
      expect(setHeaderMock).toHaveBeenCalledWith('X-Device-Id', 'device-xyz');
      expect(setHeaderMock).toHaveBeenCalledWith('X-Drawing-Id', 'mock-drawing-uuid');
    });

    it('should stream DXF by default with auto mode (DXF first)', async () => {
      const mockFile = {
        buffer: Buffer.from('mock dwg data'),
        originalname: 'project.dwg',
      } as Express.Multer.File;

      const setHeaderMock = jest.fn();
      const downloadMock = jest.fn((path, name, callback) => {
        if (callback) callback();
      });
      const res = {
        setHeader: setHeaderMock,
        download: downloadMock,
      } as unknown as Response;

      await controller.convert(mockFile, res);

      expect(mockConverterService.convert).toHaveBeenCalledWith(
        mockFile,
        'auto',
        expect.objectContaining({ paper: 'A0' }),
      );
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'application/dxf');
      expect(setHeaderMock).toHaveBeenCalledWith('X-CAD-Format', 'dxf');
      expect(downloadMock).toHaveBeenCalledWith(
        '/tmp/sefim-cad/mock-file-id/output.dxf',
        'project.dxf',
        expect.any(Function),
      );
      expect(mockConverterService.cleanup).toHaveBeenCalledWith('mock-file-id');
    });

    it('should stream PDF download directly when format=pdf is requested', async () => {
      const mockFile = {
        buffer: Buffer.from('mock dwg data'),
        originalname: 'project.dwg',
      } as Express.Multer.File;

      const setHeaderMock = jest.fn();
      const downloadMock = jest.fn((path, name, callback) => {
        if (callback) callback();
      });
      const res = {
        setHeader: setHeaderMock,
        download: downloadMock,
      } as unknown as Response;

      await controller.convert(mockFile, res, 'pdf');

      expect(mockConverterService.convert).toHaveBeenCalledWith(
        mockFile,
        'pdf',
        expect.objectContaining({ paper: 'A0' }),
      );
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(setHeaderMock).toHaveBeenCalledWith('X-CAD-Format', 'pdf');
      expect(downloadMock).toHaveBeenCalledWith(
        '/tmp/sefim-cad/mock-file-id/output.pdf',
        'project.pdf',
        expect.any(Function),
      );
    });
  });

  describe('convertToPdf', () => {
    it('should convert and send PDF file directly', async () => {
      const mockFile = {
        buffer: Buffer.from('mock dwg data'),
        originalname: 'project.dwg',
      } as Express.Multer.File;

      const setHeaderMock = jest.fn();
      const downloadMock = jest.fn((path, name, callback) => {
        if (callback) callback();
      });
      const res = {
        setHeader: setHeaderMock,
        download: downloadMock,
      } as unknown as Response;

      await controller.convertToPdf(mockFile, res);

      expect(mockConverterService.convertToPdf).toHaveBeenCalledWith(
        mockFile,
        expect.objectContaining({ paper: 'A0' }),
      );
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(downloadMock).toHaveBeenCalledWith(
        '/tmp/sefim-cad/mock-file-id/output.pdf',
        'project.pdf',
        expect.any(Function),
      );
    });
  });

  describe('download', () => {
    it('should send the file for the given fileId', async () => {
      const setHeaderMock = jest.fn();
      const downloadMock = jest.fn();
      const res = {
        setHeader: setHeaderMock,
        download: downloadMock,
      } as unknown as Response;

      await controller.download('mock-file-id', res);

      expect(mockConverterService.getConvertedFile).toHaveBeenCalledWith('mock-file-id');
      expect(setHeaderMock).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(downloadMock).toHaveBeenCalledWith(
        '/tmp/sefim-cad/mock-file-id/output.pdf',
        'project.pdf',
      );
    });
  });

  describe('drawings endpoints', () => {
    it('should throw BadRequestException if deviceId is not provided in getDrawings', async () => {
      await expect(controller.getDrawings('', '')).rejects.toThrow(BadRequestException);
    });

    it('should return drawings for deviceId', async () => {
      const drawings = await controller.getDrawings('device-123');
      expect(mockCadDrawingService.getDrawingsByDeviceId).toHaveBeenCalledWith('device-123');
      expect(drawings).toHaveLength(1);
      expect(drawings[0].deviceId).toBe('device-123');
    });

    it('should return drawing details by id', async () => {
      const drawing = await controller.getDrawingDetails('mock-drawing-uuid');
      expect(mockCadDrawingService.getDrawingById).toHaveBeenCalledWith('mock-drawing-uuid');
      expect(drawing.id).toBe('mock-drawing-uuid');
    });

    it('should delete drawing by id and deviceId', async () => {
      const result = await controller.deleteDrawing('mock-drawing-uuid', 'device-123');
      expect(mockCadDrawingService.deleteDrawing).toHaveBeenCalledWith('mock-drawing-uuid', 'device-123');
      expect(result.success).toBe(true);
    });
  });
});
