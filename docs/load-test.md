# Teste de carga

## Ambiente

| Item | Valor |
|---|---|
| Data | 2026-10-28T14:24:08.108Z |
| Plataforma | linux x64, 12 vCPU |
| Runtime | Bun 1.4.4 |
| Alvo | http://localhost:33000 |
| Prometheus | http://localhost:39090 |

## Metodologia

Pool de 32 conexões concorrentes consumindo uma fila de
requisições, com mistura de 70% `BET`, 20% `WIN` e 10% `LOSS` de
1.00 BRL, cada uma com `Idempotency-Key` única.

Duas fases, para medir quanto custa a serialização por wallet:

1. **Distribuída** — 600 requisições espalhadas por
   10 wallets. Pouca disputa pelo mesmo lock.
2. **Hot wallet** — as mesmas 600 requisições concentradas numa
   **única** wallet. Toda requisição disputa o mesmo `SELECT ... FOR UPDATE`.

A diferença entre as duas mostra o custo do lock pessimista.

Latência é medida no cliente, da requisição até o corpo lido. O gerador roda na
mesma máquina que o sistema, então os números incluem a contenção entre os
dois e valem para desenvolvimento, não para produção. A API é um processo Bun,
single-threaded: um container satura um núcleo, e para escalar é preciso subir
mais réplicas.

Rejeição por regra de negócio (422) não conta como erro. Erro é 5xx ou falha
de rede.

## Resultados por fase

| Fase | Wallets | Reqs | Throughput | p50 | p95 | p99 | máx | Erros |
|---|---|---|---|---|---|---|---|---|
| distribuída | 10 | 600 | 152.96 req/s | 206.69 ms | 299.52 ms | 333.39 ms | 362.44 ms | 0 |
| hot wallet | 1 | 600 | 77.77 req/s | 389.06 ms | 586.16 ms | 648.73 ms | 656.87 ms | 0 |

Custo da contenção: o throughput da hot wallet é
**50.8%**
do throughput distribuído.

## Agregado

| Métrica | Valor |
|---|---|
| Duração total | 11.64 s |
| Requisições | 1200 |
| Taxa de erro | 0.00 % (0/1200) |
| Rejeições de negócio | 0 |
| Conflitos de idempotência | 0 |
| Tempo até a outbox drenar | 48.74 s |
| Outbox lag final | 0.00 s |
| Retries (todos os estágios) | 0 |
| Duplicatas barradas pelo inbox | 0 |
| Mensagens em DLQ | 0 |

### Desfechos

- `PROCESSED`: 1200

### Consistência

✅ 10 wallets
reconciliadas, 0 divergentes.

O saldo materializado de cada wallet foi comparado com o reconstruído pelo
ledger depois da carga.

## Análise

**Custo do lock pessimista.** Concentrar toda a carga numa
única wallet derruba o throughput para 51%,
mas não para perto de zero, porque a seção crítica é curta: o lock cobre uma transação de poucos
milissegundos, não a requisição inteira. Já o p99 vai de 333.39 ms para
648.73 ms, porque cada requisição espera na fila do lock pelas que
chegaram antes.

**O gargalo é o publisher da outbox.** A API
ingeriu 1200 requisições em 11.64 s, mas a outbox
levou 48.74 s para drenar depois disso. O publisher
processa um lote de 20 mensagens por tick de 1 s, publicando uma a uma —
cerca de 20 eventos/s contra um ingresso de
103 req/s, com até 2 eventos por
requisição.

Opções para melhorar, da mais vantajosa para a menos:

1. **`SendMessageBatch`** no lugar de `SendMessage` — o SQS aceita 10
   mensagens por chamada, o que reduz as chamadas de rede em até 10×.
2. **Lote maior e tick mais curto.** O limite de 20 e o intervalo de 1 s
   foram escolhidos para desenvolvimento, não medidos. O intervalo é
   configurável (`OUTBOX_PUBLISH_INTERVAL_MS`); o lote é uma constante.
3. **Mais réplicas de worker.** O `FOR UPDATE SKIP LOCKED` já permite isso;
   é a opção mais simples, mas a que rende menos por processo.

O atraso não perde eventos: a outbox é durável e o publisher continua de onde
parou. O efeito é só a demora para os eventos chegarem a quem consome.

**A API é single-threaded.** Um processo Bun satura um núcleo; durante a carga
o container ficou em ~100% de CPU com o Postgres em menos de 1%. O banco não é
o limite neste cenário; para escalar, o caminho é ter mais réplicas de API, e
os testes com três processos mostram que isso é seguro.

**Limitações deste experimento.** Gerador e sistema dividem a mesma máquina;
LocalStack não tem o perfil de latência do SQS real; a carga é curta demais
para expor vazamento de memória ou degradação de índice; e não houve fase de
rejeição por saldo (todas as wallets começaram com folga), então o caminho de
`INSUFFICIENT_FUNDS` não entrou na medição de latência.
