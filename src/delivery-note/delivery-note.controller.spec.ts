import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryNoteController } from './delivery-note.controller.js';
import { DeliveryNoteService } from './delivery-note.service.js';

describe('DeliveryNoteController', () => {
  let controller: DeliveryNoteController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeliveryNoteController],
      providers: [
        {
          provide: DeliveryNoteService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<DeliveryNoteController>(DeliveryNoteController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
