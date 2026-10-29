import { Migration } from '@mikro-orm/migrations';

/**
 * Inbox de deduplicação de mensagens.
 *
 * A chave primária é `(consumer_name, message_id)`, a própria chave da
 * deduplicação, então não precisa de índice extra.
 */
export class Migration0003Inbox extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(64) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // Diagnóstico: encontrar mensagens presas sem varrer a tabela inteira.
    this.addSql(`
      CREATE INDEX inbox_messages_unprocessed_idx
        ON inbox_messages (received_at) WHERE processed_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
  }
}
