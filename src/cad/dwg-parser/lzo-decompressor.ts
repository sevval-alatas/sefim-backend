export class LZODecompressor {
  static decompress(data: Buffer): Buffer {
    if (data.length < 4) {
      return Buffer.from(data);
    }

    const output: Buffer[] = [];
    let pos = 0;

    while (pos < data.length) {
      const flag = data[pos];
      pos += 1;

      const copyLen = (flag >> 4) & 0x0f;
      const litLen = flag & 0x0f;

      if (copyLen > 0) {
        const dist = data[pos] | (data[pos + 1] << 8);
        pos += 2;

        let written = 0;
        const target = output.length;
        const backRef = target - dist;
        const len = copyLen + 4;

        while (written < len) {
          const srcIdx = backRef + written;
          if (srcIdx < 0) break;
          const totalSoFar = output.reduce((acc, b) => acc + b.length, 0);
          if (srcIdx >= totalSoFar) break;
          output.push(Buffer.from([data[srcIdx]]));
          written += 1;
        }
      }

      if (litLen > 0) {
        const end = Math.min(pos + litLen, data.length);
        output.push(data.subarray(pos, end));
        pos = end;
      }

      if (copyLen === 0 && litLen === 0) {
        break;
      }
    }

    return Buffer.concat(output);
  }
}
