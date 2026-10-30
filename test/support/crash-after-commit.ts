/**
 * Consome uma mensagem, commita e morre antes do `ack`, com um `SIGKILL` real
 * e sem gancho de falha no código de produção: monta o mesmo `CoreModule` e o
 * mesmo caso de uso que o worker.
 *
 * Códigos de saída: morre por sinal quando funciona; `2` se nenhuma mensagem
 * apareceu dentro da janela.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConsumeWagerMessageUseCase } from '@wagering/application';
import {
  SqsGateway,
  parseWagerTransactionMessage,
} from '@wagering/infrastructure';
import { CoreModule } from '@wagering/wiring';

@Module({ imports: [CoreModule] })
class CrashModule {}

const app = await NestFactory.createApplicationContext(CrashModule, {
  logger: false,
});
const gateway = app.get(SqsGateway);
const consume = app.get(ConsumeWagerMessageUseCase);

const queue = gateway.options.transactionsQueue;
const deadline = Date.now() + 30_000;

while (Date.now() < deadline) {
  const [message] = await gateway.receive(queue);
  if (!message?.Body) {
    continue;
  }

  const envelope = parseWagerTransactionMessage(message.Body);

  // O commit acontece aqui dentro.
  await consume.execute(envelope);

  // Morre aqui, sem `deleteMessage` nem shutdown hook: a mensagem continua na
  // fila, invisível até o timeout.
  process.kill(process.pid, 'SIGKILL');
}

process.exit(2);
