# Distributed Wagering Processor

Serviço financeiro distribuído para processamento de transações de apostas.
Resposta ao desafio técnico da Jungle Gaming, o enunciado original está em
[`CHALLENGE.md`](./CHALLENGE.md).

As decisões de projeto, trade-offs e limitações estão em
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | Bun 1.4 |
| Linguagem | TypeScript estrito |
| Framework | NestJS 12 |
| Banco | PostgreSQL 16 |
| ORM | MikroORM 7 |
| Mensageria | AWS SQS via LocalStack |
| Orquestração | Docker Compose |

## Pré-requisitos

- [Bun](https://bun.sh) 1.1+
- Docker com Compose v2

## Setup

```bash
bun install
bun run docker:up        # postgres, localstack, api, 2 workers, prometheus, grafana
bun run migration:up
```

| Serviço | Onde | Default |
|---|---|---|
| API | `http://localhost:3000` | `API_PORT` |
| Grafana | `http://localhost:3001` (acesso anônimo) | `GRAFANA_PORT` |
| Prometheus | `http://localhost:9090` | `PROMETHEUS_PORT` |

Os workers não publicam porta, eles consomem da fila e expõem `/metrics`
dentro da rede do Compose, raspados pelo Prometheus via descoberta DNS.

> `bun run docker:up` passa `--build`. O `docker compose up` sozinho não
> rebuilda, e uma imagem antiga em cache sobe sem aviso.


## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` | API em watch mode, fora do Compose |
| `bun run dev:worker` | Worker em watch mode, fora do Compose |
| `bun run typecheck` | TypeScript estrito sobre todo o monorepo |
| `bun test` | Testes de unidade (sem container) |
| `bun run test:integration` | Sobe Postgres e LocalStack reais, migra e roda os e2e |
| `bun run test:e2e` | Só os e2e, contra containers já de pé |
| `bun run migration:up` / `:down` / `:list` | Migrations versionadas e reversíveis |
| `bun run test:load` | Teste de carga em duas fases contra o stack no ar |
| `bun run docker:up` / `docker:down` | Stack local completa |

Os testes de integração usam `docker-compose.test.yml`, em portas isoladas
(`55432` e `44566`), então rodam com o ambiente de desenvolvimento no ar.

## API

| Método | Rota | Resposta |
|---|---|---|
| `POST` | `/wallets` | `201` · `400` payload inválido · `409` wallet duplicada |
| `GET` | `/wallets/:walletId` | `200` · `404` |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | `200` · `400` cursor inválido · `404` |
| `POST` | `/wallets/:walletId/reconciliation` | `200` (inclusive com `consistent: false`) · `404` |
| `POST` | `/wagering/transactions` | `200` aplicada · `202` `PENDING_REFERENCE` · `400` · `404` wallet inexistente · `409` conflito de idempotência · `422` rejeitada |
| `GET` | `/wagering/transactions/:transactionId` | `200` · `404` |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | `200` · `404` |
| `GET` | `/health/live` | `200` — processo vivo |
| `GET` | `/health/ready` | `200` · `503` — PostgreSQL e SQS alcançáveis |
| `GET` | `/metrics` | `200` — formato Prometheus |

Valores monetários trafegam sempre como `{ "amount": "25.00", "currency": "BRL" }`,
com string decimal de escala fixa 2.

### Exemplo

```bash
curl -XPOST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
       "initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

Erros têm shape único em todos os endpoints:

```json
{
  "statusCode": 409,
  "failureCode": "WALLET_ALREADY_EXISTS",
  "message": "a wallet already exists for player ... in BRL",
  "correlationId": "01a17ff6-fdd2-72dc-81e7-0055f20ed9a1"
}
```

O header `x-correlation-id` é aceito na requisição e devolvido na resposta; se
não vier, um UUIDv7 é gerado.

### Submeter uma transação

O header `Idempotency-Key` é obrigatório; é por ele que a API reconhece um
reenvio.

```bash
curl -XPOST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
       "walletId":"0192f291-27dd-7d3f-8071-5f8685deef37",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Repetir a requisição devolve o mesmo corpo com `idempotentReplay: true`, o
mesmo `transactionId` e o saldo observado na época. Repetir a key com payload
diferente responde `409`. Uma rejeição responde `422` com `failureCode`, e o
replay dela também responde `422`.

## Processamento por fila

Provedores também podem submeter operações pela fila `wager-transactions.fifo`,
com o envelope da §10 do enunciado:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

O consumidor usa o mesmo caso de uso da entrada HTTP. Deduplica por
`(consumerName, messageId)` num inbox persistente, dá `ack` somente após o
commit, e classifica a falha: rejeição de negócio recebe `ack`, payload
malformado vai para a DLQ, falha de infraestrutura volta para a fila com
backoff.

Os eventos de integração (`WagerTransactionProcessed`,
`WagerTransactionRejected`, `WalletBalanceChanged`,
`WagerTransactionPendingReference`) são gravados na mesma transação SQL da
operação financeira e publicados em `wager-events.fifo` por um worker separado,
depois do commit.

## Estrutura

Monorepo Bun workspaces, com a dependência sempre apontando para dentro:

```
packages/domain          regras e invariantes; só depende de decimal.js
packages/application     casos de uso e ports (interfaces)
packages/infrastructure  MikroORM, repositórios, migrations, SQS, logs, métricas
packages/wiring          fiação de DI compartilhada entre api e worker
apps/api                 controllers, DTOs, presenters, guard, filtro
apps/worker              consumidor SQS, publisher da outbox, worker de referências
test/{unit,e2e}          unidade sem container; e2e contra Postgres e SQS reais
infra/localstack         criação das filas FIFO e DLQs
scripts/                 runner de migrations e orquestrador dos testes
```

## Testes

```bash
bun test                  # 178 testes de unidade
bun run test:integration  # 112 testes e2e contra Postgres e LocalStack reais
```

Toda suíte e2e verifica, depois de cada teste, a invariante
`wallet.balance == saldo reconstruído pelo ledger`.

Os testes de schema escrevem direto no banco, sem passar pelo domínio, para
confirmar que as garantias vêm das constraints e dos triggers.

`test/e2e/concurrency.e2e.test.ts` roda paralelismo real, incluindo o cenário
obrigatório da §8 (saldo 100.00, duas apostas de 80.00 simultâneas), a mesma
aposta enviada 50 vezes em paralelo e três instâncias da aplicação disputando
a mesma wallet.

`test/e2e/messaging.e2e.test.ts` usa SQS de verdade: redelivery, 20 entregas
concorrentes da mesma mensagem, publishers concorrentes sobre a mesma outbox,
mensagem malformada indo para a DLQ, parada graciosa do consumidor e
referência fora de ordem resolvida pelo worker.

`test/e2e/resilience.e2e.test.ts` sobe processos separados e os mata com
`SIGKILL`: worker morto entre o commit e o `ack`, reinício no meio
do trabalho, três processos de API disputando a mesma wallet e dois publishers
em processos distintos.

## Autenticação

Não implementada: o enunciado (§2) diz que ela não pontua e não deve tirar
tempo de correção financeira, concorrência e idempotência. Os pontos de extensão
já existem (`NoopAuthGuard`, `ProviderIdentityPort`) e
o desenho que seria adotado está no `ARCHITECTURE.md`.

## Observabilidade

O Grafana já sobe com o datasource e o dashboard configurados.
O painel cobre transações por status e tipo, percentis de latência, outbox lag,
duplicatas e replays, retries por estágio, DLQ e divergências de reconciliação.

```bash
bun run docker:up
# http://localhost:3001 → dashboard "Wagering — visão geral"
```

O Prometheus descobre as réplicas do worker por DNS: cada processo tem seu
próprio registry, e um alvo estático resolveria para uma réplica só.

## O que ficou de fora

Os motivos estão no [`ARCHITECTURE.md`](./ARCHITECTURE.md):

- **autenticação** — o enunciado diz que não pontua; os pontos de extensão
  existem e o desenho está documentado;
- **OpenTelemetry** — fora do escopo acordado;
- **`SendMessageBatch` no publisher da outbox** — o teste de carga mostrou que
  o publisher é o gargalo, e esta seria a melhor correção. Ficou como próximo
  passo;
- **reversão parcial** — fora de escopo pelo enunciado.
