export class BitReader {
  private readonly buffer: Buffer;
  private bitOffset: number;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    this.bitOffset = 0;
  }

  get offset(): number {
    return this.bitOffset;
  }

  set offset(value: number) {
    this.bitOffset = value;
  }

  get remainingBits(): number {
    return this.buffer.length * 8 - this.bitOffset;
  }

  private byteIndex(): number {
    return Math.floor(this.bitOffset / 8);
  }

  private bitIndex(): number {
    return this.bitOffset % 8;
  }

  private ensureBits(count: number): void {
    if (this.bitOffset + count > this.buffer.length * 8) {
      throw new Error(
        `Unexpected end of DWG stream at bit ${this.bitOffset}, needed ${count} more bits`,
      );
    }
  }

  readBit(): number {
    this.ensureBits(1);
    const byteIdx = this.byteIndex();
    const bitIdx = this.bitIndex();
    const value = (this.buffer[byteIdx] >> (7 - bitIdx)) & 1;
    this.bitOffset += 1;
    return value;
  }

  readBits(count: number): number {
    if (count <= 0) return 0;
    this.ensureBits(count);
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  readByte(): number {
    this.ensureBits(8);
    const byteIdx = this.byteIndex();
    const bitIdx = this.bitIndex();
    if (bitIdx === 0) {
      const value = this.buffer[byteIdx];
      this.bitOffset += 8;
      return value;
    }
    let value = 0;
    for (let i = 0; i < 8; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  readString(): string {
    const len = this.readModularChar();
    if (len <= 0) return '';
    const bytes = this.readRawBytes(len);
    return bytes.toString('utf8');
  }

  readRawBytes(count: number): Buffer {
    if (count <= 0) return Buffer.alloc(0);
    if (this.bitOffset % 8 !== 0) {
      throw new Error('readRawBytes requires byte alignment');
    }
    this.ensureBits(count * 8);
    const start = this.byteIndex();
    const end = start + count;
    const slice = this.buffer.subarray(start, end);
    this.bitOffset += count * 8;
    return Buffer.from(slice);
  }

  alignToByte(): void {
    const remainder = this.bitOffset % 8;
    if (remainder > 0) {
      this.bitOffset += 8 - remainder;
    }
  }

  readModularChar(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    let more = true;
    while (more) {
      byte = this.readByte();
      more = (byte & 0x80) !== 0;
      result |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const signBit = 1 << (shift - 1);
    if ((result & signBit) !== 0) {
      result |= -(1 << shift);
    }
    return result;
  }

  readBitDouble(): number {
    const zeroFlag = this.readBit();
    if (zeroFlag === 1) {
      return 0.0;
    }
    const oneFlag = this.readBit();
    if (oneFlag === 1) {
      return 1.0;
    }
    this.ensureBits(64);
    const bytes = this.readRawBytes(8);
    return bytes.readDoubleLE(0);
  }

  readBitDoubleArray(count: number): number[] {
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      values.push(this.readBitDouble());
    }
    return values;
  }
}
