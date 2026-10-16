import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryNoteService } from './delivery-note.service.js';

describe('DeliveryNoteService', () => {
  let service: DeliveryNoteService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DeliveryNoteService],
    }).compile();

    service = module.get<DeliveryNoteService>(DeliveryNoteService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
