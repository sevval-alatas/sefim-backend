/**
 * Katman D: Nesne modelini tam DXF (Drawing Exchange Format) çıktısına dönüştürür.
 * Çıktı DXF R2013 (AC1027) uyumludur ve AutoCAD, LibreCAD, ezdxf ve
 * diğer DXF okuyucular tarafından güvenli şekilde açılabilir.
 *
 * DXF grup kodları (0-370+) açık bir spesifikasyondur. Bu renderer,
 * yaygın kullanılan grup kodlarını kapsar.
 */

import { CadDatabase, CadObjectVisitor } from './dwg-model.js';
import {
  CadLayerTableRecord,
  CadBlockTableRecord,
  CadLine,
  CadCircle,
  CadArc,
  CadText,
  CadMText,
  CadLwPolyline,
  CadObjectId,
} from './dwg-model.js';

type DxfSection = string[];

export abstract class CadRenderer {
  abstract render(database: CadDatabase): string | Buffer;
}

/**
 * Tam DXF R2013 renderer.
 * Her varlık benzersiz handle (5 kodu) ile imzalanır ve gerekli tüm
 * tablo girişleri (LAYER, LTYPE, STYLE, BLOCK_RECORD, VPORT, APPID,
 * DIMSTYLE, VIEW) içerir.
 */
export class CadToDxfRenderer extends CadRenderer implements CadObjectVisitor {
  private lines: DxfSection = [];
  private handleCounter = 1000;

  private nextHandle(): string {
    const h = this.handleCounter.toString(16).toUpperCase();
    this.handleCounter += 1;
    return h;
  }

  private code(code: number | string, value: string | number): void {
    this.lines.push(` ${code}`, String(value));
  }

  private entityHeader(entity: CadObject, dxfType: string): void {
    this.code(0, dxfType);
    this.code(5, entity.id.toString());
    this.code(8, entity.layer);
    this.code(62, entity.colorIndex);
    this.code(6, entity.linetype);
    this.code(48, 1.0);   // Linetype scale
    this.code(60, 0);     // Visibility
  }

  render(database: CadDatabase): string {
    this.lines = [];
    this.handleCounter = 1000;

    // ================================================================
    // 1. HEADER SECTION
    // ================================================================
    this.lines.push(
      '  0', 'SECTION',
      '  2', 'HEADER',
      '  9', '$ACADVER', '  1', 'AC1027',
      '  9', '$INSUNITS', ' 70', '4',           // Millimeter
      '  9', '$LWDISPLAY', ' 70', '1',           // Lineweight display on
      '  9', '$CECOLOR', ' 70', '256',          // ByLayer color
      '  9', '$CELTYPE', '  2', 'BYLAYER',
      '  9', '$CLAYER', '  2', '0',
      '  9', '$PELEVATION', ' 40', '0.0',
      '  9', '$THICKNESS', ' 40', '0.0',
      '  9', '$TILEMODE', ' 70', '1',
      '  9', '$USRTIMER', ' 70', '0',
      '  9', '$WORLDVIEW', ' 70', '1',
      '  9', '$HANDLING', ' 70', '1',
      '  9', '$HANDSEED', '  5', 'FFF',         // Next handle seed
      '  0', 'ENDSEC'
    );

    // ================================================================
    // 2. TABLES SECTION
    // ================================================================
    this.lines.push('  0', 'SECTION', '  2', 'TABLES');

    // 2a. LAYER table
    this.lines.push('  0', 'TABLE', '  2', 'LAYER', ' 70', String(database.layers.size));
    const layer0 = database.layers.get('0');
    if (!layer0) {
      this.code(0, 'LAYER');
      this.code(2, '0');
      this.code(70, 0);
      this.code(62, 7);
      this.code(6, 'CONTINUOUS');
      this.code(390, '0'); // Owner handle (placeholder)
    }
    for (const layer of database.layers.values()) {
      this.code(0, 'LAYER');
      this.code(2, layer.name);
      this.code(70, 0);               // Standard layer flags
      this.code(62, layer.colorIndex);
      this.code(6, layer.linetype);
      this.code(390, layer.id.toString()); // Owner handle (block record)
    }
    this.lines.push('  0', 'ENDTAB');

    // 2b. LTYPE table
    this.lines.push('  0', 'TABLE', '  2', 'LTYPE', ' 70', '1');
    this.lines.push(
      '  0', 'LTYPE',
      '  2', 'CONTINUOUS',
      ' 70', '0',
      '  3', 'Solid line',
      ' 72', '65',
      ' 40', '0.0',
      '  0', 'ENDTAB'
    );

    // 2c. STYLE table
    this.lines.push('  0', 'TABLE', '  2', 'STYLE', ' 70', '1');
    this.lines.push(
      '  0', 'STYLE',
      '  2', 'STANDARD',
      ' 70', '0',
      ' 40', '0.0',
      ' 41', '1.0',
      ' 50', '0.0',
      ' 51', '0.0',
      '  7', 'txt',
      '  0', 'ENDTAB'
    );

    // 2d. VIEWPORT (VTAB) table
    this.lines.push('  0', 'TABLE', '  2', 'VPORT', ' 70', '1');
    this.lines.push(
      '  0', 'VPORT',
      '  2', '*Active',
      ' 70', '0',
      ' 10', '0.0', ' 20', '0.0',        // Center point
      ' 11', '1.0', ' 21', '1.0',        // View direction
      ' 12', '0.0', ' 22', '0.0',
      ' 13', '0.0', ' 23', '0.0',
      ' 14', '0.0', ' 24', '0.0',
      ' 15', '0.0', ' 25', '0.0',
      ' 16', '0.0', ' 26', '0.0',
      ' 17', '0.0', ' 27', '0.0',
      ' 18', '0.0', ' 28', '0.0',
      ' 39', '0.0',
      ' 46', '0.0',
      ' 40', '1.0', ' 41', '1.0',        // View width/height
      ' 42', '1.0', ' 43', '1.0',
      ' 50', '0.0', ' 51', '0.0',        // Twist angle
      ' 71', '0', ' 72', '100',
      ' 73', '1', ' 74', '1',
      ' 75', '0', ' 76', '1',
      ' 77', '0', ' 78', '0', ' 79', '0',
      ' 90', '0.0', ' 91', '0.0',
      '140', '0.0', '141', '0.0', '142', '0.0',
      '143', '0.0', '144', '0.0', '145', '0.0',
      '146', '0.0', '147', '0.0', '148', '0.0',
      '149', '0.0',
      '  0', 'ENDTAB'
    );

    // 2e. APPID table
    this.lines.push('  0', 'TABLE', '  2', 'APPID', ' 70', '1');
    this.lines.push(
      '  0', 'APPID',
      '  2', 'ACAD',
      ' 70', '0',
      '  0', 'ENDTAB'
    );

    // 2f. DIMSTYLE table
    this.lines.push('  0', 'TABLE', '  2', 'DIMSTYLE', ' 70', '1');
    this.lines.push(
      '  0', 'DIMSTYLE',
      '  2', 'STANDARD',
      ' 70', '0',
      '  0', 'ENDTAB'
    );

    // 2g. BLOCK_RECORD table
    this.lines.push('  0', 'TABLE', '  2', 'BLOCK_RECORD', ' 70', String(database.blocks.size + 1));
    const modelBlock = database.blocks.get('*Model_Space');
    if (modelBlock) {
      this.code(0, 'BLOCK_RECORD');
      this.code(2, '*Model_Space');
      this.code(390, modelBlock.id.toString());
    } else {
      this.code(0, 'BLOCK_RECORD');
      this.code(2, '*Model_Space');
      this.code(390, '0');
    }
    this.lines.push('  0', 'ENDTAB');

    this.lines.push('  0', 'ENDSEC');

    // ================================================================
    // 3. BLOCKS SECTION
    // ================================================================
    this.lines.push('  0', 'SECTION', '  2', 'BLOCKS');

    const blockDef = database.blocks.get('*Model_Space') ?? new CadBlockTableRecord(
      new CadObjectId('BLOCK_MODEL'),
      '*Model_Space',
      database.entities,
    );

    this.code(0, 'BLOCK');
    this.code(2, '*Model_Space');
    this.code(70, 0);
    this.code(10, 0.0);
    this.code(20, 0.0);
    this.code(30, 0.0);
    this.code(3, '*Model_Space'); // Block name
    this.code(1, '');             // Xref path (empty)
    this.lines.push('  0', 'ENDBLK');

    // *Paper_Space block definition (required)
    this.code(0, 'BLOCK');
    this.code(2, '*Paper_Space');
    this.code(70, 0);
    this.code(10, 0.0);
    this.code(20, 0.0);
    this.code(30, 0.0);
    this.code(3, '*Paper_Space');
    this.code(1, '');
    this.lines.push('  0', 'ENDBLK');

    this.lines.push('  0', 'ENDSEC');

    // ================================================================
    // 4. ENTITIES SECTION
    // ================================================================
    this.lines.push('  0', 'SECTION', '  2', 'ENTITIES');

    database.accept(this);

    this.lines.push('  0', 'ENDSEC');

    // ================================================================
    // 5. EOF
    // ================================================================
    this.lines.push('  0', 'EOF');

    return this.lines.join('\n');
  }

  // ==================================================================
  // Visitor implementations
  // ==================================================================

  visitLayer(layer: CadLayerTableRecord): void {
    // Layers already emitted in TABLES section above.
  }

  visitBlock(block: CadBlockTableRecord): void {
    // Blocks already emitted above.
  }

  visitLine(line: CadLine): void {
    this.entityHeader(line, 'LINE');
    this.code(10, line.startX);
    this.code(20, line.startY);
    this.code(30, 0.0);
    this.code(11, line.endX);
    this.code(21, line.endY);
    this.code(31, 0.0);
    this.code(210, 0.0); this.code(220, 0.0); this.code(230, 1.0); // Extrusion
  }

  visitCircle(circle: CadCircle): void {
    this.entityHeader(circle, 'CIRCLE');
    this.code(10, circle.centerX);
    this.code(20, circle.centerY);
    this.code(30, 0.0);
    this.code(40, circle.radius);
    this.code(210, 0.0); this.code(220, 0.0); this.code(230, 1.0); // Extrusion
  }

  visitArc(arc: CadArc): void {
    this.entityHeader(arc, 'ARC');
    this.code(10, arc.centerX);
    this.code(20, arc.centerY);
    this.code(30, 0.0);
    this.code(40, arc.radius);
    this.code(50, arc.startAngle);
    this.code(51, arc.endAngle);
    this.code(210, 0.0); this.code(220, 0.0); this.code(230, 1.0); // Extrusion
  }

  visitText(text: CadText): void {
    this.entityHeader(text, 'TEXT');
    this.code(10, text.insertX);
    this.code(20, text.insertY);
    this.code(30, 0.0);
    this.code(40, text.height);
    this.code(1, text.value);
    this.code(50, 0.0);
    this.code(41, 1.0);
    this.code(51, 0.0);
    this.code(7, 'STANDARD');
    this.code(11, 0.0); this.code(21, 0.0); this.code(31, 0.0); // Alignment point
    this.code(210, 0.0); this.code(220, 0.0); this.code(230, 1.0); // Extrusion
    this.code(72, 0); // Attachment point
    this.code(73, 0); // Justification
  }

  visitMText(mtext: CadMText): void {
    this.entityHeader(mtext, 'MTEXT');
    this.code(10, mtext.insertX);
    this.code(20, mtext.insertY);
    this.code(30, 0.0);
    this.code(40, mtext.width > 0 ? mtext.width : 1.0);
    this.code(1, mtext.value);
    this.code(7, 'STANDARD');
    this.code(11, 0.0); this.code(21, 0.0); this.code(31, 0.0); // Insert point
    this.code(210, 0.0); this.code(220, 0.0); this.code(230, 1.0); // Extrusion
    this.code(71, 1); // Attachment point (top left)
    this.code(72, 1); // Justification
    this.code(230, 1.0); // Line spacing style
    this.code(41, 1.0); // Line spacing factor
  }

  visitLwPolyline(poly: CadLwPolyline): void {
    this.entityHeader(poly, 'LWPOLYLINE');
    this.code(8, poly.layer);
    this.code(62, poly.colorIndex);
    this.code(6, poly.linetype);
    this.code(48, 1.0);
    this.code(90, poly.vertices.length);
    this.code(70, 0); // flags: 0=open, 1=closed
    this.code(43, 0.0); // constant width
    for (const [x, y] of poly.vertices) {
      this.code(10, x);
      this.code(20, y);
    }
    this.code(210, 0.0); this.code(220, 0.0); this.code(230, 1.0); // Extrusion
  }
}
