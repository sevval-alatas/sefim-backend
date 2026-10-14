import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Mobil ve web istemciler için CORS'u aktif et
  app.enableCors();

  const config = new DocumentBuilder()
    .setTitle('Sefim CAD API')
    .setDescription('Sefim DWG - DXF Çevirici ve Çizim Servisi API Dokümantasyonu')
    .setVersion('1.0')
    .addTag('CAD Conversion')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger documentation: http://localhost:${port}/api/docs`);
}

void bootstrap();
