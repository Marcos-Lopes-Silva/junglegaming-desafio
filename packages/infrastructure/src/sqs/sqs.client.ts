import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

export interface SqsOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  transactionsQueue: string;
  transactionsDlq: string;
  eventsQueue: string;
  waitTimeSeconds: number;
  maxMessages: number;
  visibilityTimeoutSeconds: number;
}

export function readSqsOptions(
  env: NodeJS.ProcessEnv = process.env,
): SqsOptions {
  return {
    endpoint: env.AWS_SQS_ENDPOINT ?? 'http://localhost:4566',
    region: env.AWS_REGION ?? 'us-east-1',
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    transactionsQueue: env.SQS_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo',
    transactionsDlq: env.SQS_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo',
    eventsQueue: env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo',
    waitTimeSeconds: Number(env.SQS_WAIT_TIME_SECONDS ?? 20),
    maxMessages: Number(env.SQS_MAX_MESSAGES ?? 5),
    visibilityTimeoutSeconds: Number(env.SQS_VISIBILITY_TIMEOUT ?? 30),
  };
}

export interface SendOptions {
  queue: string;
  body: string;
  /** Ordenação é por grupo: `walletId` na entrada, `aggregateId` nos eventos. */
  groupId: string;
  /** Igual ao `eventId`/`messageId`, para que republicar seja inócuo. */
  deduplicationId: string;
}

export class SqsGateway {
  readonly client: SQSClient;
  private readonly urls = new Map<string, string>();

  constructor(readonly options: SqsOptions) {
    this.client = new SQSClient({
      endpoint: options.endpoint,
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  /** Resolvido uma vez por fila; o nome é estável durante a vida do processo. */
  async queueUrl(queue: string): Promise<string> {
    const cached = this.urls.get(queue);
    if (cached) {
      return cached;
    }

    const response = await this.client.send(
      new GetQueueUrlCommand({ QueueName: queue }),
    );
    const url = response.QueueUrl;
    if (!url) {
      throw new Error(`queue ${queue} has no URL`);
    }

    this.urls.set(queue, url);
    return url;
  }

  async send(options: SendOptions): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(options.queue),
        MessageBody: options.body,
        MessageGroupId: options.groupId,
        MessageDeduplicationId: options.deduplicationId,
      }),
    );
  }

  async receive(queue: string): Promise<Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        // `MessageSystemAttributeNames` e não `AttributeNames`: o segundo é
        // tipado para atributos da fila, não da mensagem.
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
    );

    return response.Messages ?? [];
  }

  /** Confirma a mensagem (ack). Só deve ser chamado depois do commit. */
  async deleteMessage(queue: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  /** Backoff de redelivery, e também o "devolver a visibilidade" do SIGTERM. */
  async changeVisibility(
    queue: string,
    receiptHandle: string,
    timeoutSeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(queue),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeoutSeconds,
      }),
    );
  }

  /** Readiness: a fila precisa existir e responder, não só o socket abrir. */
  async ping(): Promise<void> {
    await this.queueUrl(this.options.transactionsQueue);
  }
}
