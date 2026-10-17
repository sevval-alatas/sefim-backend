import { IDwgVersionParser, ParseResult, CadEntity } from './parser-strategy.js';
import { DwgClassicParser } from './dwg-classic-parser.js';
import { DwgLzoPagedParser } from './dwg-lzo-paged-parser.js';
import { DwgModernParser } from './dwg-modern-parser.js';

export class DwgParserFactory {
  static createParser(versionHeader: string): IDwgVersionParser {
    switch (versionHeader) {
      case 'AC1012':
      case 'AC1014':
      case 'AC1015':
        return new DwgClassicParser(versionHeader);

      case 'AC1018':
      case 'AC1021':
      case 'AC1024':
      case 'AC1027':
        return new DwgLzoPagedParser(versionHeader);

      case 'AC1032':
      case 'AC1036':
        return new DwgModernParser(versionHeader);

      default: {
        const match = /^AC10\d{2}$/.test(versionHeader);
        if (match) {
          return new DwgModernParser(versionHeader);
        }
        throw new Error(`Desteklenmeyen veya geçersiz DWG sürümü: ${versionHeader}`);
      }
    }
  }
}
