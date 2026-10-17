import { spawn } from 'node:child_process';
import { access, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

const MAX_CONCURRENT_CONVERSIONS = 5;
const CONVERSION_TIMEOUT_MS = 180_000;
const FILE_RETENTION_MS = 10 * 60_000;

export const DWG_VERSION_MAP: Record<string, string> = {
  'MC0.0': 'AutoCAD Release 1.0',
  'AC1.2': 'AutoCAD Release 1.2',
  'AC1.4': 'AutoCAD Release 1.4',
  'AC1.50': 'AutoCAD Release 2.05',
  'AC2.10': 'AutoCAD Release 2.1',
  'AC1002': 'AutoCAD Release 2.5',
  'AC1003': 'AutoCAD Release 2.6',
  'AC1004': 'AutoCAD Release 9',
  'AC1006': 'AutoCAD Release 10',
  'AC1009': 'AutoCAD Release 11 / 12',
  'AC1012': 'AutoCAD Release 13',
  'AC1014': 'AutoCAD Release 14',
  'AC1015': 'AutoCAD 2000 / 2000i / 2002 (AC1015)',
  'AC1018': 'AutoCAD 2004 / 2005 / 2006 (AC1018)',
  'AC1021': 'AutoCAD 2007 / 2008 / 2009 (AC1021)',
  'AC1024': 'AutoCAD 2010 / 2011 / 2012 (AC1024)',
  'AC1027': 'AutoCAD 2013 / 2014 / 2015 / 2016 / 2017 (AC1027)',
  'AC1032': 'AutoCAD 2018 / 2021 / 2024 (AC1032)',
  'AC1036': 'AutoCAD 2025 / 2026 (AC1036)',
};

export type DwgHeaderInfo = {
  isValidSignature: boolean;
  signature: string;
  versionName: string;
  isDxf: boolean;
  isPdf: boolean;
  isZip: boolean;
  description: string;
};

export function inspectDwgHeader(buffer: Buffer): DwgHeaderInfo {
  if (!buffer || buffer.length < 6) {
    return {
      isValidSignature: false,
      signature: buffer ? buffer.toString('hex') : '',
      versionName: 'Bilinmiyor (Dosya çok küçük)',
      isDxf: false,
      isPdf: false,
      isZip: false,
      description: `Dosya boyutu bir DWG için çok küçük (${buffer?.length ?? 0} byte).`,
    };
  }

  const sigAscii = buffer.subarray(0, 6).toString('ascii');
  const first100Text = buffer.subarray(0, Math.min(buffer.length, 100)).toString('utf8');

  if (first100Text.includes('SECTION') || first100Text.startsWith('0\n') || first100Text.startsWith('  0\n')) {
    return {
      isValidSignature: false,
      signature: sigAscii,
      versionName: 'DXF Çizim Formatı',
      isDxf: true,
      isPdf: false,
      isZip: false,
      description: 'Yüklenen dosya aslında bir DWG değil, zaten DXF formatında bir metin çizim dosyasıdır.',
    };
  }

  if (sigAscii.startsWith('%PDF')) {
    return {
      isValidSignature: false,
      signature: sigAscii,
      versionName: 'PDF Belgesi',
      isDxf: false,
      isPdf: true,
      isZip: false,
      description: 'Yüklenen dosya bir PDF belgesidir, DWG çizim dosyası değildir.',
    };
  }

  if (sigAscii.startsWith('PK\x03\x04')) {
    return {
      isValidSignature: false,
      signature: sigAscii,
      versionName: 'ZIP / Arşiv',
      isDxf: false,
      isPdf: false,
      isZip: true,
      description: 'Yüklenen dosya bir ZIP veya sıkıştırılmış arşiv dosyasıdır.',
    };
  }

  const knownVersion = DWG_VERSION_MAP[sigAscii];
  if (knownVersion) {
    return {
      isValidSignature: true,
      signature: sigAscii,
      versionName: knownVersion,
      isDxf: false,
      isPdf: false,
      isZip: false,
      description: `Geçerli DWG başlığı: ${sigAscii} (${knownVersion})`,
    };
  }

  if (/^AC10\d{2}$/.test(sigAscii)) {
    return {
      isValidSignature: true,
      signature: sigAscii,
      versionName: `Bilinmeyen DWG Sürümü (${sigAscii})`,
      isDxf: false,
      isPdf: false,
      isZip: false,
      description: `DWG imzası tanınmadı ama geçerli DWG formatında görünüyor: ${sigAscii}`,
    };
  }

  return {
    isValidSignature: false,
    signature: sigAscii,
    versionName: 'Bilinmeyen Başlık',
    isDxf: false,
    isPdf: false,
    isZip: false,
    description: `Dosya geçerli bir DWG imzası ('AC10xx') ile başlamıyor. Bulunan ilk byte'lar: "${sigAscii}" (hex: ${buffer.subarray(0, 6).toString('hex')})`,
  };
}

export function parseLibreDwgError(stderr: string, stdout: string): string {
  const output = `${stderr}\n${stdout}`.trim();
  const reasons: string[] = [];

  if (/READ ERROR 0x800/i.test(output) || /Invalid DWG/i.test(output)) {
    reasons.push('Geçersiz veya bozuk DWG dosya yapısı (magic header / 0x800 hatası).');
  }
  if (/0x20/i.test(output) || /WRONGCRC/i.test(output) || /crc error/i.test(output)) {
    reasons.push('Çizim dosyasında CRC veri sağlama hatası (dosya hasar görmüş olabilir).');
  }
  if (/0x40/i.test(output) || /UNHANDLEDCLASS/i.test(output) || /unhandled object/i.test(output)) {
    reasons.push('Çizim içinde LibreDWG tarafından desteklenmeyen özel mimari/inşaat proxy nesneleri (AEC, Civil 3D, ideCAD veya Sta4CAD nesneleri) bulunuyor.');
  }
  if (/Object handle not found/i.test(output)) {
    reasons.push('Çizim içinde çözümlenemeyen nesne referansları/handle uyumsuzlukları var.');
  }
  if (/0x04/i.test(output) || /CLASSESNOTFOUND/i.test(output)) {
    reasons.push('Çizim nesne sınıf tanımları (CLASSES) okunamadı.');
  }
  if (/0x1000/i.test(output) || /IOERROR/i.test(output)) {
    reasons.push('Dosya okuma/yazma (I/O) hatası.');
  }
  if (/dwg too small/i.test(output)) {
    reasons.push('Dosya boyutu bir DWG çizimi için çok küçük.');
  }
  if (/encrypted|password/i.test(output)) {
    reasons.push('Dosya şifrelenmiş veya parola korumalı.');
  }

  if (reasons.length > 0) {
    return reasons.join(' ');
  }

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('Reading DWG'));
  return lines.slice(0, 4).join('; ') || 'CAD çizimi okunamadı.';
}

export async function findGeneratedFile(jobDirectory: string, preferredPath: string, extension: string): Promise<string | null> {
  try {
    const stats = await stat(preferredPath);
    if (stats.size > 100) return preferredPath;
  } catch {}

  const defaultPath = join(jobDirectory, `input.${extension}`);
  try {
    const stats = await stat(defaultPath);
    if (stats.size > 100) return defaultPath;
  } catch {}

  try {
    const files = await readdir(jobDirectory);
    for (const file of files) {
      if (file.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
        const fullPath = join(jobDirectory, file);
        const stats = await stat(fullPath);
        if (stats.size > 100) return fullPath;
      }
    }
  } catch {}

  return null;
}

export async function isValidPdfFile(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (stats.size < 100) return false;

    const fd = await open(filePath, 'r');
    try {
      const headBuf = Buffer.alloc(Math.min(stats.size, 1024));
      await fd.read(headBuf, 0, headBuf.length, 0);
      return headBuf.toString('utf8').includes('%PDF-');
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

export async function isValidDxfFile(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (stats.size < 100) return false;

    const fd = await open(filePath, 'r');
    try {
      const headBuf = Buffer.alloc(Math.min(stats.size, 8192));
      await fd.read(headBuf, 0, headBuf.length, 0);
      const headText = headBuf.toString('utf8');
      return (
        headText.includes('SECTION') &&
        (headText.includes('HEADER') || headText.includes('CLASSES') || headText.includes('TABLES') || headText.includes('BLOCKS') || headText.includes('ENTITIES'))
      );
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

export async function optimizeDxfForViewing(dxfPath: string): Promise<void> {
  try {
    const content = await readFile(dxfPath, 'utf8');
    let optimized = content;

    if (optimized.includes('$LWDISPLAY')) {
      optimized = optimized.replace(
        /(\$LWDISPLAY\s*\r?\n\s*290\s*\r?\n\s*)(1)/g,
        '$10',
      );
    }

    optimized = optimized.replace(
      /(\r?\n\s*370\s*\r?\n\s*)(\d+)/g,
      '$10',
    );

    optimized = optimized.replace(
      /(\r?\n\s*43\s*\r?\n\s*)([0-9]+(?:\.[0-9]+)?)/g,
      '$10.0',
    );

    optimized = optimized.replace(/\\P/g, ' ');
    optimized = optimized.replace(/\\[A-Za-z][^;]*;/g, '');

    await writeFile(dxfPath, optimized, 'utf8');
  } catch {
    // Post-processing hatası durumunda orijinal DXF korunur
  }
}

function runConverterProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdoutAcc = '';
    let stderrAcc = '';
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutAcc.length < 50_000) {
        stdoutAcc += chunk.toString('utf8');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrAcc.length < 50_000) {
        stderrAcc += chunk.toString('utf8');
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: stdoutAcc,
        stderr: `${stderrAcc}\n${err.message}`,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: stdoutAcc,
        stderr: stderrAcc,
        timedOut,
      });
    });
  });
}

export type ConvertedFile = {
  path: string;
  name: string;
  jobDirectory: string;
  mimeType: string;
};

export type PdfConversionOptions = {
  paper?: string;
  monochrome?: boolean;
};

export type ConversionResult = {
  fileId: string;
  fileName: string;
  outputPath: string;
  jobDirectory: string;
  downloadUrl: string;
  format: 'pdf' | 'dxf';
  strategyUsed?: string;
  fallbackUsed?: boolean;
};

@Injectable()
export class DwgConverterService {
  private readonly logger = new Logger(DwgConverterService.name);
  private readonly dxfVersion = process.env.CAD_DXF_VERSION ?? 'r2018';
  private readonly convertedFiles = new Map<string, ConvertedFile>();
  private activeConversions = 0;

  resolveConverterCommand(): string {
    return this.resolvePdfConverterCommand() ?? this.resolveDxfConverterCommand();
  }

  resolvePdfConverterCommand(): string | null {
    if (process.env.CAD_PDF_CONVERTER_COMMAND && existsSync(process.env.CAD_PDF_CONVERTER_COMMAND)) {
      return process.env.CAD_PDF_CONVERTER_COMMAND;
    }
    const candidates = [
      '/Applications/QCAD.app/Contents/Resources/dwg2pdf',
      '/opt/homebrew/bin/dwg2pdf',
      '/usr/local/bin/dwg2pdf',
      'dwg2pdf',
    ];
    for (const candidate of candidates) {
      if (candidate.startsWith('/') && existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  resolveQcadDwg2DwgCommand(): string | null {
    const candidates = [
      '/Applications/QCAD.app/Contents/Resources/dwg2dwg',
      '/opt/homebrew/bin/dwg2dwg',
      '/usr/local/bin/dwg2dwg',
    ];
    for (const candidate of candidates) {
      if (candidate.startsWith('/') && existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  resolveDxfConverterCommand(): string {
    if (process.env.CAD_CONVERTER_COMMAND) {
      return process.env.CAD_CONVERTER_COMMAND;
    }
    const candidates = [
      'dwg2dxf',
      '/opt/homebrew/bin/dwg2dxf',
      '/usr/local/bin/dwg2dxf',
      '/usr/bin/dwg2dxf',
    ];
    for (const candidate of candidates) {
      if (candidate.startsWith('/') && existsSync(candidate)) {
        return candidate;
      }
    }
    return 'dwg2dxf';
  }

  async checkConverterAvailable(): Promise<{
    pdfConverter: { available: boolean; command?: string };
    dxfConverter: { available: boolean; command: string };
  }> {
    const pdfCommand = this.resolvePdfConverterCommand();
    const dxfCommand = this.resolveDxfConverterCommand();

    return {
      pdfConverter: {
        available: Boolean(pdfCommand),
        command: pdfCommand ?? undefined,
      },
      dxfConverter: {
        available: true,
        command: dxfCommand,
      },
    };
  }

  async convert(
    file: Express.Multer.File,
    format: 'auto' | 'dxf' | 'pdf' = 'auto',
    options: PdfConversionOptions = {},
  ): Promise<ConversionResult> {
    if (format === 'pdf') {
      return this.convertToPdf(file, options);
    }

    if (format === 'dxf') {
      return this.convertToDxf(file);
    }

    this.logger.log(`[Auto CAD Motoru] İlk olarak DXF deneniyor: ${file.originalname}`);
    try {
      const dxfResult = await this.convertToDxf(file);
      this.logger.log(`[Auto CAD Motoru] DXF dönüştürme başarılı: ${file.originalname}`);
      return dxfResult;
    } catch (dxfError: unknown) {
      const errorMsg = dxfError instanceof Error ? dxfError.message : String(dxfError);
      this.logger.warn(
        `[Auto CAD Motoru] DXF dönüştürme tamamlanamadı (${errorMsg}). Otomatik olarak Vektörel PDF motoruna geçiliyor...`,
      );

      const pdfResult = await this.convertToPdf(file, options);
      pdfResult.fallbackUsed = true;
      this.logger.log(`[Auto CAD Motoru] Vektörel PDF yedek dönüştürme başarılı: ${file.originalname}`);
      return pdfResult;
    }
  }

  async convertToPdf(
    file: Express.Multer.File,
    options: PdfConversionOptions = {},
  ): Promise<ConversionResult> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('DWG dosyası boş veya yüklenemedi');
    }

    const headerInfo = inspectDwgHeader(file.buffer);
    if (!headerInfo.isValidSignature) {
      this.throwInvalidDwgException(file, headerInfo);
    }

    if (this.activeConversions >= MAX_CONCURRENT_CONVERSIONS) {
      throw new ServiceUnavailableException('Dönüştürme kapasitesi şu an dolu, lütfen biraz sonra tekrar deneyin');
    }

    const pdfCommand = this.resolvePdfConverterCommand();
    if (!pdfCommand) {
      this.logger.warn('QCAD dwg2pdf bulunamadı, DXF dönüştürmeye yönlendiriliyor...');
      return this.convertToDxf(file);
    }

    this.activeConversions += 1;
    const fileId = randomUUID();
    const jobDirectory = join(tmpdir(), 'sefim-cad', fileId);
    const inputPath = join(jobDirectory, 'input.dwg');
    const outputPath = join(jobDirectory, 'output.pdf');

    try {
      await mkdir(jobDirectory, { recursive: true });
      await writeFile(inputPath, file.buffer);

      const paperSize = options.paper?.toUpperCase() || 'A0';
      this.logger.log(`DWG -> Vektörel PDF dönüştürme başlatıldı: ${file.originalname} (Pafta: ${paperSize})`);

      const args = [
        '-a',
        '-auto-orientation',
        '-color-correction',
        `-paper=${paperSize}`,
        '-min-lineweight=0.01',
        '-max-lineweight=0.08',
        '-flat',
        '-d',
        '-f',
        '-no-dock-icon',
        '-o', outputPath,
        inputPath,
      ];

      if (options.monochrome) {
        args.push('-n');
      }

      const result = await runConverterProcess(
        pdfCommand,
        args,
        jobDirectory,
        CONVERSION_TIMEOUT_MS,
        this.getProcessEnv(),
      );

      const generatedPdf = await findGeneratedFile(jobDirectory, outputPath, 'pdf');
      if (generatedPdf && (await isValidPdfFile(generatedPdf))) {
        if (generatedPdf !== outputPath) {
          await rename(generatedPdf, outputPath);
        }
        const stats = await stat(outputPath);
        const pdfFileName = this.toPdfName(file.originalname);
        this.convertedFiles.set(fileId, {
          path: outputPath,
          name: pdfFileName,
          jobDirectory,
          mimeType: 'application/pdf',
        });

        setTimeout(() => void this.cleanup(fileId), FILE_RETENTION_MS).unref();

        this.logger.log(`DWG -> Vektörel PDF başarılı: ${file.originalname} -> ${(stats.size / 1024).toFixed(1)} KB PDF`);

        return {
          fileId,
          fileName: pdfFileName,
          outputPath,
          jobDirectory,
          downloadUrl: `/api/cad/files/${fileId}`,
          format: 'pdf',
          strategyUsed: 'QCAD Teigha dwg2pdf (A0 Vektörel PDF)',
        };
      }

      this.logger.error(
        `DWG -> PDF dönüştürücü hata verdi:\nSTDOUT: ${result.stdout}\nSTDERR: ${result.stderr}`,
      );

      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        message: `DWG dosyası Vektörel PDF formatına dönüştürülemedi. [Dosya: ${file.originalname}]. Çizim hasarlı veya desteklenmeyen özel bir formatta olabilir.`,
        details: {
          fileName: file.originalname,
          fileSizeBytes: file.buffer.length,
          signature: headerInfo.signature,
          dwgVersion: headerInfo.versionName,
          error: (result.stderr || result.stdout || 'PDF çıktısı üretilemedi').trim().slice(0, 500),
          suggestions: [
            'Çizimi AutoCAD, BricsCAD veya DWG TrueView ile açıp "AutoCAD 2018 DWG" veya "AutoCAD 2013 DWG" olarak farklı kaydedin.',
            'Çizimde hata varsa AutoCAD içinde AUDIT veya RECOVER komutunu çalıştırarak onarın.',
          ],
        },
      });
    } catch (error) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      this.activeConversions -= 1;
    }
  }

  async convertToDxf(file: Express.Multer.File): Promise<ConversionResult> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('DWG dosyası boş veya yüklenemedi');
    }

    const headerInfo = inspectDwgHeader(file.buffer);
    if (!headerInfo.isValidSignature) {
      this.throwInvalidDwgException(file, headerInfo);
    }

    if (this.activeConversions >= MAX_CONCURRENT_CONVERSIONS) {
      throw new ServiceUnavailableException('Dönüştürme kapasitesi şu an dolu, lütfen biraz sonra tekrar deneyin');
    }

    this.activeConversions += 1;
    const fileId = randomUUID();
    const jobDirectory = join(tmpdir(), 'sefim-cad', fileId);
    const inputPath = join(jobDirectory, 'input.dwg');
    const outputPath = join(jobDirectory, 'output.dxf');

    try {
      await mkdir(jobDirectory, { recursive: true });
      await writeFile(inputPath, file.buffer);

      const qcadDwg2Dwg = this.resolveQcadDwg2DwgCommand();
      const libreDwg2Dxf = this.resolveDxfConverterCommand();

      type DxfStrategy = {
        name: string;
        cmd: string;
        args: string[];
      };

      const strategies: DxfStrategy[] = [];

      if (qcadDwg2Dwg) {
        strategies.push({
          name: 'QCAD OpenDesign Teigha dwg2dwg (R27 DXF)',
          cmd: qcadDwg2Dwg,
          args: ['-f', '-no-dock-icon', '-r', 'R27', '-o', outputPath, inputPath],
        });
      }

      strategies.push(
        {
          name: `LibreDWG r2018 DXF (--as ${this.dxfVersion})`,
          cmd: libreDwg2Dxf,
          args: ['-v1', '-y', '-o', outputPath, '--as', this.dxfVersion, inputPath],
        },
        {
          name: 'LibreDWG r2013 DXF (--as r2013)',
          cmd: libreDwg2Dxf,
          args: ['-v1', '-y', '-o', outputPath, '--as', 'r2013', inputPath],
        },
        {
          name: 'LibreDWG r2010 DXF (--as r2010)',
          cmd: libreDwg2Dxf,
          args: ['-v1', '-y', '-o', outputPath, '--as', 'r2010', inputPath],
        },
        {
          name: 'LibreDWG r2007 DXF (--as r2007)',
          cmd: libreDwg2Dxf,
          args: ['-v1', '-y', '-o', outputPath, '--as', 'r2007', inputPath],
        },
        {
          name: 'LibreDWG r2000 Uyumluluk Modu (--as r2000)',
          cmd: libreDwg2Dxf,
          args: ['-v1', '-y', '-o', outputPath, '--as', 'r2000', inputPath],
        },
        {
          name: 'LibreDWG Doğal Sürüm (flagsiz)',
          cmd: libreDwg2Dxf,
          args: ['-v1', '-y', '-o', outputPath, inputPath],
        },
        {
          name: 'LibreDWG Minimal DXF Modu (-m)',
          cmd: libreDwg2Dxf,
          args: ['-v1', '-y', '-m', '-o', outputPath, inputPath],
        },
      );

      type AttemptLog = {
        strategy: string;
        exitCode?: number | string;
        error?: string;
        stderr?: string;
        stdout?: string;
      };

      const attemptLogs: AttemptLog[] = [];
      let successStrategy: string | null = null;
      let finalPath = outputPath;

      for (const strategy of strategies) {
        if (!strategy.cmd) continue;

        this.logger.log(`DWG -> DXF deneniyor: "${strategy.name}" -> ${file.originalname}`);

        const result = await runConverterProcess(
          strategy.cmd,
          strategy.args,
          jobDirectory,
          CONVERSION_TIMEOUT_MS,
          this.getProcessEnv(),
        );

        if (result.timedOut) {
          attemptLogs.push({
            strategy: strategy.name,
            exitCode: 'TIMEOUT',
            error: `Zaman aşımı (${CONVERSION_TIMEOUT_MS / 1000}s)`,
            stdout: result.stdout,
            stderr: result.stderr,
          });
          continue;
        }

        const generatedDxf = await findGeneratedFile(jobDirectory, outputPath, 'dxf');
        if (generatedDxf && (await isValidDxfFile(generatedDxf))) {
          if (generatedDxf !== outputPath) {
            await rename(generatedDxf, outputPath);
          }
          finalPath = outputPath;

          await optimizeDxfForViewing(finalPath);

          const stats = await stat(finalPath);
          successStrategy = strategy.name;
          this.logger.log(
            `DWG -> DXF başarılı ve optimize edildi (${strategy.name}): ${file.originalname} -> ${(stats.size / 1024).toFixed(1)} KB DXF`,
          );
          break;
        }

        attemptLogs.push({
          strategy: strategy.name,
          exitCode: result.exitCode ?? 'UNKNOWN',
          error: 'Geçerli bir DXF çıktı dosyası üretilemedi',
          stdout: result.stdout?.trim(),
          stderr: result.stderr?.trim(),
        });
      }

      if (!successStrategy) {
        const lastAttempt = attemptLogs[attemptLogs.length - 1];
        const primaryErrorOutput = attemptLogs[0]?.stderr || lastAttempt?.stderr || attemptLogs[0]?.stdout || '';
        const specificReason = parseLibreDwgError(primaryErrorOutput, attemptLogs[0]?.stdout || '');

        throw new BadGatewayException({
          statusCode: 502,
          error: 'Bad Gateway',
          message: `DWG dosyası DXF formatına dönüştürülemedi. [Dosya: ${file.originalname}]. Sebep: ${specificReason}`,
          details: {
            fileName: file.originalname,
            fileSizeBytes: file.buffer.length,
            signature: headerInfo.signature,
            dwgVersion: headerInfo.versionName,
            specificReason,
            rawError: primaryErrorOutput.slice(0, 500),
            attempts: attemptLogs,
            suggestions: [
              'Çizimi Vektörel PDF formatında indirmeyi deneyin (format=pdf).',
              'Çizimi AutoCAD ile açıp "AutoCAD 2013 DWG" veya "DXF" olarak kaydedin.',
              'LibreDWG veya QCAD sürümünüzü güncelleyin.',
            ],
          },
        });
      }

      const dxfFileName = this.toDxfName(file.originalname);
      this.convertedFiles.set(fileId, {
        path: finalPath,
        name: dxfFileName,
        jobDirectory,
        mimeType: 'application/dxf',
      });

      setTimeout(() => void this.cleanup(fileId), FILE_RETENTION_MS).unref();

      return {
        fileId,
        fileName: dxfFileName,
        outputPath: finalPath,
        jobDirectory,
        downloadUrl: `/api/cad/files/${fileId}`,
        format: 'dxf',
        strategyUsed: successStrategy,
      };
    } catch (error) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      this.activeConversions -= 1;
    }
  }

  async getConvertedFile(fileId: string): Promise<ConvertedFile> {
    const convertedFile = this.convertedFiles.get(fileId);
    if (!convertedFile) {
      throw new NotFoundException('Dönüştürülen dosya bulunamadı veya süresi doldu');
    }

    try {
      await access(convertedFile.path);
    } catch {
      this.convertedFiles.delete(fileId);
      throw new NotFoundException('Dönüştürülen dosya disk üzerinde bulunamadı');
    }

    return convertedFile;
  }

  async cleanup(fileId: string): Promise<void> {
    const convertedFile = this.convertedFiles.get(fileId);
    if (convertedFile) {
      this.convertedFiles.delete(fileId);
      await rm(convertedFile.jobDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  private throwInvalidDwgException(file: Express.Multer.File, headerInfo: DwgHeaderInfo): never {
    this.logger.warn(`Geçersiz DWG başlığı tespit edildi: ${headerInfo.description} (Dosya: ${file.originalname})`);
    const detailedMessage =
      `Yüklenen dosya geçerli bir DWG çizim dosyası değil. ` +
      `[Dosya: ${file.originalname}, Tespit Edilen Format: ${headerInfo.versionName}]. ` +
      `Açıklama: ${headerInfo.description}`;

    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: detailedMessage,
      details: {
        fileName: file.originalname,
        fileSizeBytes: file.buffer.length,
        signature: headerInfo.signature,
        detectedFormat: headerInfo.versionName,
        isDxf: headerInfo.isDxf,
        isPdf: headerInfo.isPdf,
        isZip: headerInfo.isZip,
        suggestion: headerInfo.isDxf
          ? 'Bu dosya zaten DXF formatındadır. Dönüştürme yapmadan doğrudan kullanabilirsiniz.'
          : 'Lütfen geçerli bir .dwg uzantılı CAD çizim dosyası yükleyin.',
      },
    });
  }

  private toPdfName(originalName?: string): string {
    const base = (originalName || 'drawing.dwg').replace(/\.(dwg|dxf)$/i, '');
    return `${base}.pdf`;
  }

  private toDxfName(originalName?: string): string {
    const base = (originalName || 'drawing.dwg').replace(/\.dwg$/i, '');
    return `${base}.dxf`;
  }

  private getProcessEnv(): NodeJS.ProcessEnv {
    const extraPaths = [
      '/Applications/QCAD.app/Contents/Resources',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
    ];
    const currentPath = process.env.PATH ?? '';
    return {
      ...process.env,
      PATH: `${currentPath}:${extraPaths.join(':')}`,
    };
  }
}
