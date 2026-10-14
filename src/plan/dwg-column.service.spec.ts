import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { parseWorkerResult } from './dwg-column.service.js';

describe('parseWorkerResult', () => {
  it('parses a structured column result', () => {
    expect(parseWorkerResult(JSON.stringify({
      success: true,
      columns: [{ name: 'S101', minX: 1, minY: 2, maxX: 3, maxY: 4 }],
    }))).toEqual({
      success: true,
      columns: [{ name: 'S101', minX: 1, minY: 2, maxX: 3, maxY: 4 }],
      warnings: [],
    });
  });

  it('rejects invalid JSON and malformed columns', () => {
    expect(() => parseWorkerResult('not json')).toThrow(BadGatewayException);
    expect(() => parseWorkerResult('{"success":true,"columns":[{}]}')).toThrow(BadGatewayException);
  });

  it('returns worker errors as a bad request', () => {
    expect(() => parseWorkerResult('{"success":false,"error":"Invalid DWG"}'))
      .toThrow(BadRequestException);
  });
});
