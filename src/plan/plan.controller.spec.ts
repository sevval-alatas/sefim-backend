import { BadRequestException } from '@nestjs/common';
import { isDwgFileName, requireDwgUpload } from './plan-upload-validation.js';

describe('PlanController upload validation', () => {
  it('accepts only DWG file extensions, without relying on the user filename as a path', () => {
    expect(isDwgFileName('plan.DWG')).toBe(true);
    expect(isDwgFileName('plan.dxf')).toBe(false);
    expect(isDwgFileName('plan.dwg.exe')).toBe(false);
  });

  it('rejects a missing upload', async () => {
    expect(() => requireDwgUpload(undefined)).toThrow(BadRequestException);
  });
});
