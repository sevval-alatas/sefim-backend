/**
 * Katman C: Binary DWG verisini CadDatabase modeline yükler.
 * Gelişmiş sürüm: Gerçek DWG handle tablosu simülasyonu (handle offset'leri,
 * sekans numaraları, binary handle saklama biçimi), BitReader, XDATA,
 * ACAD_REACTORS, genişletilmiş grup kodu desteği ve CRC doğrulaması içerir.
 *
 * UYARI: Bu kod, Autodesk/ODA'nın mülki DWG binary formatının tam implementasyonu
 * değildir. Handle yönetimi, DWG handle mantığını simüle etmek için yazılmıştır.
 * Gerçek DWG okuma için ODA Drawings SDK veya LibreDWG kullanılmalıdır.
 */

import { DwgBinaryParser, DwgSection } from './dwg-parser.js';
import {
  CadDatabase,
  CadObjectId,
  CadLayerTableRecord,
  CadBlockTableRecord,
  CadLine,
  CadCircle,
  CadArc,
  CadText,
  CadMText,
  CadLwPolyline,
  CadObject,
} from './dwg-model.js';

// DWG entity tür kodları
const ENTITY_LINE = 'LINE';
const ENTITY_CIRCLE = 'CIRCLE';
const ENTITY_ARC = 'ARC';
const ENTITY_TEXT = 'TEXT';
const ENTITY_MTEXT = 'MTEXT';
const ENTITY_LWPOLYLINE = 'LWPOLYLINE';
const ENTITY_POINT = 'POINT';
const ENTITY_INSERT = 'INSERT';
const ENTITY_POLYLINE = 'POLYLINE';
const ENTITY_VERTEX = 'VERTEX';
const ENTITY_XDATA = 'XDATA';
const ENTITY_REACTOR = 'ACAD_REACTORS';
const ENTITY_DICTIONARY = 'DICTIONARY';

// DWG sürüm aralığı
const DWG_MIN_VERSION = 1012;
const DWG_MAX_VERSION = 1036;

// CRC16 tablosu
const CRC16_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
    table[i] = crc;
  }
  return table;
})();

function computeCrc16(buffer: Buffer, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return crc & 0xffff;
}

/**
 * HandleTableEntry: DWG handle tablosunda tek bir girdiyi temsil eder.
 * Gerçek DWG'de handle'lar 4-byte (32-bit) değerler olarak saklanır ve
 * her birinin buffer içindeki bir offset'i ve bir sequence numarası vardır.
 */
export interface HandleTableEntry {
  handle: string;           // 4-8 haneli hex (ör. "1A2B")
  offset: number;           // Buffer içindeki byte konumu
  sequenceNumber: number;   // DWG sequence numarası (1-based)
  objectType: string;       // LINE, CIRCLE, vb.
}

/**
 * HandleTable: DWG handle tablosu simülasyonu.
 * Handle'ları, offset'lerini ve sequence numaralarını yönetir.
 * DWG'de handle'lar 4-byte (32-bit) hex değerler olarak saklanır ve
 * dosya içindeki her nesneye eşsiz bir handle atanır.
 */
export class HandleTable {
  private entries = new Map<string, HandleTableEntry>();
  private sequenceCounter = 1;

  /**
   * Mevcut bir handle'ı kaydeder (önceden tarama ile).
   */
  register(entry: HandleTableEntry): void {
    this.entries.set(entry.handle.toUpperCase(), entry);
  }

  /**
   * Handle'ı kontrol eder.
   */
  has(handle: string): boolean {
    return this.entries.has(handle.toUpperCase());
  }

  /**
   * Handle ile entry'yi döndürür.
   */
  get(handle: string): HandleTableEntry | undefined {
    return this.entries.get(handle.toUpperCase());
  }

  /**
   * Tüm handle girişlerini döndürür.
   */
  getAllEntries(): HandleTableEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Handle tablosunun boyutunu döndürür.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Belirli bir objectType'a göre handle girişlerini filtreler.
   */
  getByObjectType(objectType: string): HandleTableEntry[] {
    return this.getAllEntries().filter((e) => e.objectType === objectType);
  }

  /**
   * Yeni bir handle üretir ve kaydeder.
   * DWG'de handle'lar genellikle 4-8 haneli hex değerleridir.
   * Çakışma durumunda bir sonraki değere geçilir.
   */
  allocate(offset: number, objectType: string): string {
    let handle: string;
    let attempts = 0;
    const maxAttempts = 0xffff;

    do {
      // DWG handle'ları 4-byte (32-bit) hex değerler olarak temsil edilir.
      // Handle uzunluğu通常 4 haneden başlar, büyük dosyalarda artabilir.
      const len = 4 + (this.sequenceCounter % 4); // 4, 5, 6, 7 haneli döngü
      handle = this.sequenceCounter.toString(16).toUpperCase().padStart(len, '0');
      this.sequenceCounter += 1;
      if (this.sequenceCounter > 0xffffffff) {
        this.sequenceCounter = 1;
      }
      attempts += 1;

      if (attempts > maxAttempts) {
        throw new Error('HandleTable: benzersiz handle üretilemedi (tüm değerler tükendi).');
      }
    } while (this.entries.has(handle));

    const entry: HandleTableEntry = {
      handle,
      offset,
      sequenceNumber: this.sequenceCounter,
      objectType,
    };
    this.register(entry);
    return handle;
  }

  /**
   * Handle tablosunu sıfırlar (yeni dosya yüklemesi için).
   */
  clear(): void {
    this.entries.clear();
    this.sequenceCounter = 1;
  }

  /**
   * Handle tablosunun özet bilgisini döndürür.
   */
  getSummary(): {
    totalHandles: number;
    objectTypes: Record<string, number>;
    minHandle: string | null;
    maxHandle: string | null;
  } {
    const entries = this.getAllEntries();
    const objectTypes: Record<string, number> = {};
    let minHandle: string | null = null;
    let maxHandle: string | null = null;

    for (const entry of entries) {
      objectTypes[entry.objectType] = (objectTypes[entry.objectType] || 0) + 1;
      if (minHandle === null || entry.handle < minHandle) {
        minHandle = entry.handle;
      }
      if (maxHandle === null || entry.handle > maxHandle) {
        maxHandle = entry.handle;
      }
    }

    return {
      totalHandles: entries.length,
      objectTypes,
      minHandle,
      maxHandle,
    };
  }
}

/**
 * BitReader: DWG'nin bit seviyesinde sıkıştırılmış verilerini okumak için.
 */
export class BitReader {
  private readonly buffer: Buffer;
  private bitPos: number;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    this.bitPos = 0;
  }

  get bytePos(): number {
    return Math.floor(this.bitPos / 8);
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byteIndex = Math.floor(this.bitPos / 8);
      const bitIndex = 7 - (this.bitPos % 8);
      if (byteIndex >= this.buffer.length) {
        throw new Error(`BitReader: buffer sınırı aşıldı (bitPos=${this.bitPos})`);
      }
      const bit = (this.buffer[byteIndex] >>> bitIndex) & 1;
      value = (value << 1) | bit;
      this.bitPos += 1;
    }
    return value;
  }

  alignToByte(): void {
    this.bitPos = Math.ceil(this.bitPos / 8) * 8;
  }

  readBytes(count: number): Buffer {
    const start = this.bytePos;
    const end = start + count;
    if (end > this.buffer.length) {
      throw new Error(`BitReader: bayt okuma sınırı aşıldı (start=${start}, count=${count})`);
    }
    this.bitPos = end * 8;
    return this.buffer.subarray(start, end);
  }

  seek(bits: number): void {
    this.bitPos = bits;
  }
}

/**
 * XData: DWG'deki genişletilmiş veri yapısı (group code 1000+).
 */
export class XData {
  constructor(
    public readonly appName: string,
    public readonly codes: Map<number, string | number | boolean>,
  ) {}
}

/**
 * AcDbDictionary: DWG'deki sözlük yapısı (nesne koleksiyonları).
 */
export class AcDbDictionary {
  constructor(
    public readonly name: string,
    public readonly entries = new Map<string, CadObject>(),
  ) {}
}

/**
 * AcDbReactors: DWG'deki reaktör (işlemci) yapısı.
 */
export class AcDbReactors {
  constructor(
    public readonly ownerHandle: string,
    public readonly reactorHandles: string[] = [],
  ) {}
}

export class DwgFiler {
  private database = new CadDatabase();
  private handleTable = new HandleTable();
  private bitReader: BitReader | null = null;
  private xdataList: XData[] = [];
  private dictionaries = new Map<string, AcDbDictionary>();
  private reactors = new Map<string, AcDbReactors>();

  getDatabase(): CadDatabase {
    return this.database;
  }

  getHandleTable(): HandleTable {
    return this.handleTable;
  }

  getXDataList(): XData[] {
    return this.xdataList;
  }

  getDictionaries(): Map<string, AcDbDictionary> {
    return this.dictionaries;
  }

  getReactors(): Map<string, AcDbReactors> {
    return this.reactors;
  }

  load(buffer: Buffer): CadDatabase {
    const header = DwgBinaryParser.parseHeader(buffer);
    if (!header.isValid) {
      throw new Error(`Geçersiz DWG imzası: ${header.signature}`);
    }

    // Sürüm kontrolü
    const versionNum = parseInt(header.signature.replace('AC10', ''), 10);
    if (isNaN(versionNum) || versionNum < DWG_MIN_VERSION || versionNum > DWG_MAX_VERSION) {
      throw new Error(`Desteklenmeyen DWG sürümü: ${header.signature} (${header.version})`);
    }

    // CRC kontrolü (ilk 512 byte üzerinden)
    const crcStored = buffer.readUInt16LE(0);
    const crcCalc = computeCrc16(buffer, 2, Math.min(buffer.length, 512));
    if (crcStored !== 0 && crcStored !== crcCalc) {
      console.warn(
        `CRC uyumsuzluğu: saklanan=0x${crcStored.toString(16)}, hesaplanan=0x${crcCalc.toString(16)}`,
      );
    }

    // BitReader'ı başlat (sıkıştırılmış bölümler için)
    this.bitReader = new BitReader(buffer);

    const sections = DwgBinaryParser.scanSections(buffer);

    // 1. Önce mevcut handle'ları tara ve HandleTable'e kaydet
    this.scanExistingHandles(buffer);

    // 2. Temel katman
    const layer0 = new CadLayerTableRecord(
      this.allocateHandle('LAYER_0', 0),
      '0',
      7,
      'CONTINUOUS',
    );
    this.database.add(layer0);

    // 3. Model alanı bloğu
    const modelBlock = new CadBlockTableRecord(
      this.allocateHandle('BLOCK_MODEL', buffer.length - 1),
      '*Model_Space',
      [],
    );
    this.database.add(modelBlock);

    // 4. Katmanları buffer'dan tahmin et
    this.extractLayersFromBuffer(buffer, layer0);

    // 5. XDATA, DICTIONARY ve REACTOR'ları tar
    this.extractExtendedStructures(buffer);

    // 6. Entityleri çıkar
    this.extractEntitiesFromBuffer(buffer, sections, modelBlock.id);

    // Handle tablosu özetini logla
    const summary = this.handleTable.getSummary();
    console.log(
      `HandleTable özeti: ${summary.totalHandles} handle, ` +
      `objectTypes: ${JSON.stringify(summary.objectTypes)}, ` +
      `minHandle: ${summary.minHandle}, maxHandle: ${summary.maxHandle}`,
    );

    return this.database;
  }

  /**
   * Yeni bir handle ayırır ve HandleTable'e kaydeder.
   * Gerçek DWG'de handle'lar 4-byte (32-bit) hex değerlerdir.
   */
  private allocateHandle(objectType: string, offset: number): CadObjectId {
    const handle = this.handleTable.allocate(offset, objectType);
    return new CadObjectId(handle);
  }

  /**
   * Handle tablosu özet bilgisini döndürür (debug/amacıyla).
   */
  getHandleTableSummary() {
    return this.handleTable.getSummary();
  }

  /**
   * Handle tablosunu sıfırlar (yeni dosya yüklemesi için).
   */
  clearHandleTable(): void {
    this.handleTable.clear();
  }

  /**
   * DWG buffer'ından mevcut handle'ları tarar ve HandleTable'e kaydeder.
   * DWG'de handle'lar genellikle 4-8 haneli hex değerler olarak saklanır.
   * Bu metin tabanlı tarama, dosya içinde geçen hex pattern'leri bulur.
   */
  private scanExistingHandles(buffer: Buffer): void {
    const text = buffer.toString('latin1');
    const foundHandles = new Set<string>();

    // DWG handle'ları genellikle 4-8 haneli hex değerlerdir.
    const hexHandleRegex = /\b[0-9A-Fa-f]{4,8}\b/g;
    let match: RegExpExecArray | null;

    while ((match = hexHandleRegex.exec(text)) !== null) {
      const candidate = match[0].toUpperCase();
      if (candidate.length >= 4 && candidate.length <= 8) {
        if (/^[0-9A-F]+$/.test(candidate)) {
          foundHandles.add(candidate);
        }
      }
    }

    // Bulunan handle'ları HandleTable'e sequence numarasıyla kaydet
    let seq = 1;
    for (const handle of foundHandles) {
      this.handleTable.register({
        handle,
        offset: text.indexOf(handle),
        sequenceNumber: seq++,
        objectType: 'UNKNOWN',
      });
    }

    console.log(`${foundHandles.size} mevcut handle tarıldı ve HandleTable'e kaydedildi.`);
  }

  /**
   * DWG buffer'ından katman isimlerini arar ve ekler.
   */
  private extractLayersFromBuffer(buffer: Buffer, defaultLayer: CadLayerTableRecord): void {
    const text = buffer.toString('latin1');
    const layerCandidates = new Set<string>();

    const patterns = ['0', 'Defpoints', 'KATMAN', 'LAYER', 'COLOR', 'LINE', 'DEFPOINTS'];
    for (const pat of patterns) {
      let idx = 0;
      while ((idx = text.indexOf(pat, idx)) !== -1) {
        const after = text.substring(idx, idx + 64).replace(/\0/g, '').trim();
        if (after.length > 0 && after.length < 64 && /^[A-Za-z0-9_\-]+$/.test(after)) {
          layerCandidates.add(after);
        }
        idx += pat.length;
      }
    }

    for (const name of layerCandidates) {
      if (name !== '0' && !this.database.layers.has(name)) {
        this.database.add(new CadLayerTableRecord(
          this.allocateHandle('LAYER', buffer.indexOf(name)),
          name,
          7,
          'CONTINUOUS',
        ));
      }
    }
  }

  /**
   * XDATA, DICTIONARY ve ACAD_REACTORS gibi genişletmiş yapıları tarar.
   */
  private extractExtendedStructures(buffer: Buffer): void {
    const text = buffer.toString('latin1');

    // XDATA işaretçisi (1000+ group code)
    const xdataMatches = text.match(/XDATA|1000|1001|1002|1003|1004|1005|1010|1011|1012|1013|1040|1041|1042|1070|1071/g);
    if (xdataMatches) {
      for (const match of xdataMatches) {
        const appName = match === 'XDATA' ? 'UNKNOWN_APP' : match;
        const codes = new Map<number, string | number | boolean>();
        codes.set(1000, match);
        this.xdataList.push(new XData(appName, codes));
      }
    }

    // DICTIONARY işareti
    const dictMatches = text.match(/DICTIONARY|ACAD_DICTIONARY/g);
    if (dictMatches) {
      for (const match of dictMatches) {
        const dict = new AcDbDictionary(match);
        this.dictionaries.set(match, dict);
      }
    }

    // ACAD_REACTORS işareti
    const reactorMatches = text.match(/ACAD_REACTORS/g);
    if (reactorMatches) {
      for (const match of reactorMatches) {
        const handle = this.allocateHandle('REACTOR', text.indexOf(match));
        this.reactors.set(handle.toString(), new AcDbReactors(handle.toString()));
      }
    }
  }

  /**
   * DWG buffer'ından temel entityleri ayıklar.
   */
  private extractEntitiesFromBuffer(
    buffer: Buffer,
    sections: DwgSection[],
    modelBlockId: CadObjectId,
  ): void {
    const text = buffer.toString('latin1');

    const entityMarkers = [
      { name: ENTITY_LINE, type: 'LINE' },
      { name: ENTITY_CIRCLE, type: 'CIRCLE' },
      { name: ENTITY_ARC, type: 'ARC' },
      { name: ENTITY_TEXT, type: 'TEXT' },
      { name: ENTITY_MTEXT, type: 'MTEXT' },
      { name: ENTITY_LWPOLYLINE, type: 'LWPOLYLINE' },
      { name: ENTITY_POINT, type: 'POINT' },
      { name: ENTITY_INSERT, type: 'INSERT' },
      { name: ENTITY_POLYLINE, type: 'POLYLINE' },
    ];

    for (const marker of entityMarkers) {
      let idx = 0;
      while ((idx = text.indexOf(marker.name, idx)) !== -1) {
        const entityData = this.tryParseEntity(buffer, idx, marker.type, modelBlockId);
        if (entityData) {
          const model = this.database.blocks.get('*Model_Space');
          if (model) {
            model.entities.push(entityData);
          }
          this.database.add(entityData);
        }
        idx += marker.name.length;
      }
    }
  }

  /**
   * Belirli bir offset'teki entity verisini parse etmeye çalışır.
   */
  private tryParseEntity(
    buffer: Buffer,
    offset: number,
    type: string,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    try {
      const searchStart = Math.max(0, offset - 300);
      const searchEnd = Math.min(buffer.length, offset + 300);

      switch (type) {
        case ENTITY_LINE:
          return this.parseLine(buffer, searchStart, searchEnd, modelBlockId);
        case ENTITY_CIRCLE:
          return this.parseCircle(buffer, searchStart, searchEnd, modelBlockId);
        case ENTITY_ARC:
          return this.parseArc(buffer, searchStart, searchEnd, modelBlockId);
        case ENTITY_TEXT:
          return this.parseText(buffer, searchStart, searchEnd, modelBlockId);
        case ENTITY_MTEXT:
          return this.parseMText(buffer, searchStart, searchEnd, modelBlockId);
        case ENTITY_LWPOLYLINE:
          return this.parseLwPolyline(buffer, searchStart, searchEnd, modelBlockId);
        case ENTITY_POINT:
          return this.parsePoint(buffer, searchStart, searchEnd, modelBlockId);
        case ENTITY_INSERT:
          return this.parseInsert(buffer, searchStart, searchEnd, modelBlockId);
        case ENTITY_POLYLINE:
          return this.parsePolyline(buffer, searchStart, searchEnd, modelBlockId);
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private readDouble(buffer: Buffer, offset: number): number | null {
    if (offset + 8 > buffer.length) return null;
    const v = buffer.readDoubleLE(offset);
    return Number.isFinite(v) ? v : null;
  }

  private readString(buffer: Buffer, offset: number, maxLen: number): string | null {
    const end = Math.min(offset + maxLen, buffer.length);
    const bytes = buffer.subarray(offset, end);
    const nullIdx = bytes.indexOf(0);
    const validBytes = nullIdx !== -1 ? bytes.subarray(0, nullIdx) : bytes;
    const str = validBytes.toString('utf8').replace(/\0/g, '').trim();
    return str.length > 0 ? str : null;
  }

  private findDoublePair(
    buffer: Buffer,
    start: number,
    end: number,
  ): { x: number; y: number } | null {
    for (let off = start; off + 16 <= end; off += 8) {
      const x = buffer.readDoubleLE(off);
      const y = buffer.readDoubleLE(off + 8);
      if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Math.abs(x) < 1000000 &&
        Math.abs(y) < 1000000
      ) {
        return { x, y };
      }
    }
    return null;
  }

  private parseLine(
    buffer: Buffer,
    start: number,
    end: number,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    let p1 = this.findDoublePair(buffer, start, end);
    let p2 = this.findDoublePair(buffer, start + 16, end);
    if (!p1 || !p2) return null;

    return new CadLine(
      this.allocateHandle('LINE', start),
      p1.x, p1.y,
      p2.x, p2.y,
      '0',
      256,
      'BYLAYER',
      modelBlockId,
    );
  }

  private parseCircle(
    buffer: Buffer,
    start: number,
    end: number,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    const center = this.findDoublePair(buffer, start, end);
    if (!center) return null;

    let radius = 0;
    for (let off = start + 16; off < end; off += 8) {
      const r = buffer.readDoubleLE(off);
      if (r > 0 && r < 10000 && Number.isFinite(r)) {
        radius = r;
        break;
      }
    }

    return new CadCircle(
      this.allocateHandle('CIRCLE', start),
      center.x, center.y,
      radius,
      '0',
      256,
      'BYLAYER',
      modelBlockId,
    );
  }

  private parseArc(
    buffer: Buffer,
    start: number,
    end: number,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    const center = this.findDoublePair(buffer, start, end);
    if (!center) return null;

    let radius = 0;
    for (let off = start + 16; off < end; off += 8) {
      const r = buffer.readDoubleLE(off);
      if (r > 0 && r < 10000 && Number.isFinite(r)) {
        radius = r;
        break;
      }
    }

    return new CadArc(
      this.allocateHandle('ARC', start),
      center.x, center.y,
      radius,
      0, 360,
      '0',
      256,
      'BYLAYER',
      modelBlockId,
    );
  }

  private parseText(
    buffer: Buffer,
    start: number,
    end: number,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    const pos = this.findDoublePair(buffer, start, end);
    if (!pos) return null;

    let value = 'TEXT';
    for (let off = start; off < end; off++) {
      const s = this.readString(buffer, off, 64);
      if (s && s.length > 1 && s.length < 100 && /^[A-Za-z0-9\s._-]+$/.test(s)) {
        value = s;
        break;
      }
    }

    return new CadText(
      this.allocateHandle('TEXT', start),
      pos.x, pos.y,
      2.5,
      value,
      '0',
      256,
      'BYLAYER',
      modelBlockId,
    );
  }

  private parseMText(
    buffer: Buffer,
    start: number,
    end: number,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    const pos = this.findDoublePair(buffer, start, end);
    if (!pos) return null;

    let value = 'MTEXT';
    for (let off = start; off < end; off++) {
      const s = this.readString(buffer, off, 128);
      if (s && s.length > 1 && s.length < 200 && /^[A-Za-z0-9\s._-]+$/.test(s)) {
        value = s;
        break;
      }
    }

    return new CadMText(
      this.allocateHandle('MTEXT', start),
      pos.x, pos.y,
      1.0,
      value,
      '0',
      256,
      'BYLAYER',
      modelBlockId,
    );
  }

  private parseLwPolyline(
    buffer: Buffer,
    start: number,
    end: number,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    const vertices: [number, number][] = [];
    for (let off = start; off + 16 <= end; off += 16) {
      const x = buffer.readDoubleLE(off);
      const y = buffer.readDoubleLE(off + 8);
      if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 100000 && Math.abs(y) < 100000) {
        vertices.push([x, y]);
        if (vertices.length >= 100) break;
      } else {
        break;
      }
    }

    if (vertices.length < 2) return null;

    return new CadLwPolyline(
      this.allocateHandle('LWPOLYLINE', start),
      vertices,
      '0',
      256,
      'BYLAYER',
      modelBlockId,
    );
  }

  private parsePoint(
    buffer: Buffer,
    start: number,
    end: number,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    const pos = this.findDoublePair(buffer, start, end);
    if (!pos) return null;

    return new CadLwPolyline(
      this.allocateHandle('POINT', start),
      [[pos.x, pos.y]],
      '0',
      256,
      'BYLAYER',
      modelBlockId,
    );
  }

  private parseInsert(
    buffer: Buffer,
    start: number,
    end: number,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    const pos = this.findDoublePair(buffer, start, end);
    if (!pos) return null;

    return new CadCircle(
      this.allocateHandle('INSERT', start),
      pos.x, pos.y,
      1.0,
      '0',
      256,
      'BYLAYER',
      modelBlockId,
    );
  }

  private parsePolyline(
    buffer: Buffer,
    start: number,
    end: number,
    modelBlockId: CadObjectId,
  ): CadObject | null {
    return this.parseLwPolyline(buffer, start, end, modelBlockId);
  }

  addExampleEntities(): void {
    const model = this.database.blocks.get('*Model_Space');
    if (!model) return;

    const line = new CadLine(
      this.allocateHandle('LINE_EXAMPLE', 0),
      0, 0, 100, 100,
      '0',
      7,
      'CONTINUOUS',
      model.id,
    );
    model.entities.push(line);
    this.database.add(line);

    const circle = new CadCircle(
      this.allocateHandle('CIRCLE_EXAMPLE', 1),
      50, 50, 25,
      '0',
      7,
      'CONTINUOUS',
      model.id,
    );
    model.entities.push(circle);
    this.database.add(circle);
  }
}
