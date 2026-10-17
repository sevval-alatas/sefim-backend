import { DwgEntity } from './object-factory.js';

export type CadEntity = DwgEntity;

export type ParseResult = {
  success: boolean;
  version?: string;
  entities: CadEntity[];
  error?: string;
};

export interface IDwgVersionParser {
  parse(buffer: Buffer): ParseResult;
}
