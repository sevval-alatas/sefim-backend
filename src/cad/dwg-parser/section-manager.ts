import { BitReader } from './bit-reader.js';

export type DwgSection = {
  name: string;
  offset: number;
  size: number;
};

export type DwgHeader = {
  signature: string;
  version: string;
  isValid: boolean;
};

export class SectionManager {
  private readonly reader: BitReader;

  constructor(buffer: Buffer) {
    this.reader = new BitReader(buffer);
  }

  readHeader(): DwgHeader {
    const reader = this.reader;
    const sigBytes = reader.readRawBytes(6);
    const signature = sigBytes.toString('ascii');

    const known: Record<string, string> = {
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
      AC1036: 'AutoCAD 2025 / 2026',
    };

    const version = known[signature] || `Unknown DWG version (${signature})`;
    const isValid = /^AC10\d{2}$/.test(signature) && signature in known;

    return { signature, version, isValid };
  }

  readSections(): DwgSection[] {
    const sections: DwgSection[] = [];
    while (this.reader.remainingBits > 0) {
      const secNameBuf = this.reader.readRawBytes(8);
      const name = secNameBuf.toString('ascii').replace(/\0/g, '').trim();
      if (!name) break;

      const offset = this.reader.readBits(32);
      const size = this.reader.readBits(32);
      sections.push({ name, offset, size });
    }
    return sections;
  }

  findSection(sections: DwgSection[], name: string): DwgSection | undefined {
    return sections.find((s) => s.name === name);
  }
}
