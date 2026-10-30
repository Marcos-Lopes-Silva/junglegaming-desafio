import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './app.module.js';

export async function bootstrapWorker() {
  const app = await NestFactory.create(WorkerModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  // Necessário para o consumidor terminar a mensagem atual no SIGTERM.
  app.enableShutdownHooks();

  return app;
}

if (import.meta.main) {
  const app = await bootstrapWorker();
  const port = Number(process.env.WORKER_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  app.get(Logger).log({ message: 'worker started', port });
}
