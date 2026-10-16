#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/498260f6d26db1767d9488d5030da86a3a3f998e0cfcb21fa0121513c13827c7/contract';
import endContract from '../../snapshots/498260f6d26db1767d9488d5030da86a3a3f998e0cfcb21fa0121513c13827c7/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/5f486946768368326e29e57f5d024ee5b79346849f9542ef43022922535418b8/contract';
import startContract from '../../snapshots/5f486946768368326e29e57f5d024ee5b79346849f9542ef43022922535418b8/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'cadDrawing',
        columns: [
          col('convertedFileName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('convertedFilePath', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('convertedFormat', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('deviceId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('dwgVersion', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('errorMessage', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('fileSizeBytes', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('originalFileName', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('originalFilePath', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('pending'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'cadDrawing',
        index: 'cadDrawing_deviceId_createdAt_idx_e2036dd5',
        columns: ['deviceId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'cadDrawing',
        index: 'cadDrawing_deviceId_idx_a7d461e8',
        columns: ['deviceId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
