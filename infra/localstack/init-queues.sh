#!/bin/bash
# Criação das filas FIFO e suas DLQs.
#
# `wager-transactions.fifo` é a entrada assíncrona de transações;
# `wager-events.fifo` é a saída dos eventos de integração publicados pela
# outbox.
set -euo pipefail

ENDPOINT="http://localhost:4566"
ACCOUNT="000000000000"
MAX_RECEIVE_COUNT=5

create_pair() {
  local queue="$1"
  local dlq="$2"

  awslocal sqs create-queue \
    --queue-name "$dlq" \
    --attributes FifoQueue=true >/dev/null

  local dlq_arn
  dlq_arn=$(awslocal sqs get-queue-attributes \
    --queue-url "${ENDPOINT}/${ACCOUNT}/${dlq}" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' \
    --output text)

  # maxReceiveCount limita as tentativas antes da DLQ.
  awslocal sqs create-queue \
    --queue-name "$queue" \
    --attributes "$(printf '{"FifoQueue":"true","VisibilityTimeout":"30","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"%s\\"}"}' \
      "$dlq_arn" "$MAX_RECEIVE_COUNT")" >/dev/null

  echo "queue ready: $queue (dlq: $dlq)"
}

create_pair "wager-transactions.fifo" "wager-transactions-dlq.fifo"
create_pair "wager-events.fifo" "wager-events-dlq.fifo"
