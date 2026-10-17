/**
 * Katman B: DWG dosyasının bellek içi nesne modeli.
 * Tüm CAD nesneleri burada temsil eder.
 */

export class CadObjectId {
  constructor(public readonly handle: string) {}
  toString(): string { return this.handle; }
}

export abstract class CadObject {
  constructor(
    public readonly id: CadObjectId,
    public readonly layer: string,
    public readonly colorIndex: number = 256,
    public readonly linetype: string = 'BYLAYER',
    public readonly ownerId: CadObjectId | null = null,
  ) {}
  abstract accept(visitor: CadObjectVisitor): void;
}

export class CadLayerTableRecord extends CadObject {
  constructor(
    id: CadObjectId,
    public readonly name: string,
    public readonly colorIndex: number = 256,
    public readonly linetype: string = 'BYLAYER',
    ownerId: CadObjectId | null = null,
  ) {
    super(id, name, colorIndex, linetype, ownerId);
  }
  accept(visitor: CadObjectVisitor): void { visitor.visitLayer(this); }
}

export class CadBlockTableRecord extends CadObject {
  constructor(
    id: CadObjectId,
    public readonly name: string,
    public readonly entities: CadObject[] = [],
    ownerId: CadObjectId | null = null,
  ) {
    super(id, '0', 256, 'BYLAYER', ownerId);
  }
  accept(visitor: CadObjectVisitor): void { visitor.visitBlock(this); }
}

export class CadLine extends CadObject {
  constructor(
    id: CadObjectId,
    public readonly startX: number,
    public readonly startY: number,
    public readonly endX: number,
    public readonly endY: number,
    layer: string,
    colorIndex: number = 256,
    linetype: string = 'BYLAYER',
    ownerId: CadObjectId | null = null,
  ) {
    super(id, layer, colorIndex, linetype, ownerId);
  }
  accept(visitor: CadObjectVisitor): void { visitor.visitLine(this); }
}

export class CadCircle extends CadObject {
  constructor(
    id: CadObjectId,
    public readonly centerX: number,
    public readonly centerY: number,
    public readonly radius: number,
    layer: string,
    colorIndex: number = 256,
    linetype: string = 'BYLAYER',
    ownerId: CadObjectId | null = null,
  ) {
    super(id, layer, colorIndex, linetype, ownerId);
  }
  accept(visitor: CadObjectVisitor): void { visitor.visitCircle(this); }
}

export class CadArc extends CadObject {
  constructor(
    id: CadObjectId,
    public readonly centerX: number,
    public readonly centerY: number,
    public readonly radius: number,
    public readonly startAngle: number,
    public readonly endAngle: number,
    layer: string,
    colorIndex: number = 256,
    linetype: string = 'BYLAYER',
    ownerId: CadObjectId | null = null,
  ) {
    super(id, layer, colorIndex, linetype, ownerId);
  }
  accept(visitor: CadObjectVisitor): void { visitor.visitArc(this); }
}

export class CadText extends CadObject {
  constructor(
    id: CadObjectId,
    public readonly insertX: number,
    public readonly insertY: number,
    public readonly height: number,
    public readonly value: string,
    layer: string,
    colorIndex: number = 256,
    linetype: string = 'BYLAYER',
    ownerId: CadObjectId | null = null,
  ) {
    super(id, layer, colorIndex, linetype, ownerId);
  }
  accept(visitor: CadObjectVisitor): void { visitor.visitText(this); }
}

export class CadMText extends CadObject {
  constructor(
    id: CadObjectId,
    public readonly insertX: number,
    public readonly insertY: number,
    public readonly width: number,
    public readonly value: string,
    layer: string,
    colorIndex: number = 256,
    linetype: string = 'BYLAYER',
    ownerId: CadObjectId | null = null,
  ) {
    super(id, layer, colorIndex, linetype, ownerId);
  }
  accept(visitor: CadObjectVisitor): void { visitor.visitMText(this); }
}

export class CadLwPolyline extends CadObject {
  constructor(
    id: CadObjectId,
    public readonly vertices: [number, number][],
    layer: string,
    colorIndex: number = 256,
    linetype: string = 'BYLAYER',
    ownerId: CadObjectId | null = null,
  ) {
    super(id, layer, colorIndex, linetype, ownerId);
  }
  accept(visitor: CadObjectVisitor): void { visitor.visitLwPolyline(this); }
}

export interface CadObjectVisitor {
  visitLayer(layer: CadLayerTableRecord): void;
  visitBlock(block: CadBlockTableRecord): void;
  visitLine(line: CadLine): void;
  visitCircle(circle: CadCircle): void;
  visitArc(arc: CadArc): void;
  visitText(text: CadText): void;
  visitMText(mtext: CadMText): void;
  visitLwPolyline(poly: CadLwPolyline): void;
}

export class CadDatabase {
  public readonly objects = new Map<string, CadObject>();
  public readonly layers = new Map<string, CadLayerTableRecord>();
  public readonly blocks = new Map<string, CadBlockTableRecord>();
  public readonly entities: CadObject[] = [];

  add(object: CadObject): void {
    this.objects.set(object.id.toString(), object);
    if (object instanceof CadLayerTableRecord) {
      this.layers.set(object.name, object);
    } else if (object instanceof CadBlockTableRecord) {
      this.blocks.set(object.name, object);
    } else {
      this.entities.push(object);
    }
  }

  getById(handle: string): CadObject | undefined {
    return this.objects.get(handle);
  }

  accept(visitor: CadObjectVisitor): void {
    for (const obj of this.objects.values()) {
      obj.accept(visitor);
    }
  }
}
