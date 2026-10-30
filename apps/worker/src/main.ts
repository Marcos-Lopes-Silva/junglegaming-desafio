import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app.module.js';

export async function bootstrapWorker() {
  const app = await NestFactory.create(WorkerModule);

  // Necessário para o consumidor terminar a mensagem atual no SIGTERM.
  app.enableShutdownHooks();

  return app;
}

if (import.meta.main) {
  const app = await bootstrapWorker();
  const port = Number(process.env.WORKER_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  new Logger('Worker').log({ message: 'worker started', port });
}
