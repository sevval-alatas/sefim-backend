/**
 * Katman A: DWG dosyasının binary başlığını ve bölümlerini okur.
 * Sadece dosya yapısını ayrıştırır, nesne modelini oluşturmaz.
 */

export const DWG_SIGNATURES: Record<string, string> = {
  AC1002: 'AutoCAD Release 2.5',
  AC1003: 'AutoCAD Release 2.6',
  AC1004: 'AutoCAD Release 9',
  AC1006: 'AutoCAD Release 10',
  AC1009: 'AutoCAD Release 11 / 12',
  AC1012: 'AutoCAD Release 13',
  AC1014: 'AutoCAD Release 14',
  AC1015: 'AutoCAD 2000 / 2000i / 2002',
  AC1018: 'AutoCAD 2004 / 2005 / 2006',
  AC1021: 'AutoCAD 2007 / 2008 / 2009',
  AC1024: 'AutoCAD 2010 / 2011 / 2012',
  AC1027: 'AutoCAD 2013 / 2014 / 2015 / 2016 / 2017',
  AC1032: 'AutoCAD 2018 / 2021 / 2024',
};

export enum DwgSectionType {
  HEADER = 'HEADER',
  CLASSES = 'CLASSES',
  TABLES = 'TABLES',
  BLOCKS = 'BLOCKS',
  ENTITIES = 'ENTITIES',
  OBJECTS = 'OBJECTS',
  THUMBNAIL = 'THUMBNAIL_IMAGE',
  UNKNOWN = 'UNKNOWN',
}

export interface DwgSection {
  type: DwgSectionType;
  offset: number;
  size: number;
}

export interface DwgHeader {
  signature: string;
  version: string | null;
  isValid: boolean;
  sectionCount: number;
}

export class DwgBinaryParser {
  static parseHeader(buffer: Buffer): DwgHeader {
    if (buffer.length < 6) {
      return {
        signature: buffer.toString('hex'),
        version: null,
        isValid: false,
        sectionCount: 0,
      };
    }

    const signature = buffer.subarray(0, 6).toString('ascii');
    const version = DWG_SIGNATURES[signature] ?? null;

    return {
      signature,
      version,
      isValid: /^AC10\d{2}$/.test(signature),
      sectionCount: 0,
    };
  }

  static scanSections(buffer: Buffer): DwgSection[] {
    const sections: DwgSection[] = [];
    const text = buffer.toString('latin1');

    const knownSections: [string, DwgSectionType][] = [
      ['HEADER', DwgSectionType.HEADER],
      ['CLASSES', DwgSectionType.CLASSES],
      ['TABLES', DwgSectionType.TABLES],
      ['BLOCKS', DwgSectionType.BLOCKS],
      ['ENTITIES', DwgSectionType.ENTITIES],
      ['OBJECTS', DwgSectionType.OBJECTS],
      ['THUMBNAILIMAGE', DwgSectionType.THUMBNAIL],
    ];

    for (const [name, type] of knownSections) {
      let idx = 0;
      while ((idx = text.indexOf(name, idx)) !== -1) {
        sections.push({ type, offset: idx, size: 0 });
        idx += name.length;
      }
    }

    sections.sort((a, b) => a.offset - b.offset);
    return sections;
  }
}
