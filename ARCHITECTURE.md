# Arquitetura, decisões e limitações

Documento de decisões do desafio. Cada seção registra a escolha, o porquê e a
alternativa descartada. Referências `§x` apontam para o [`CHALLENGE.md`](./CHALLENGE.md).

---

## 1. Forma geral

Monorepo Bun workspaces com dependência sempre apontando para dentro:

```
apps/api     ┐
             ├→ packages/wiring → packages/infrastructure → packages/application → packages/domain
apps/worker  ┘
```

`packages/domain` tem uma única dependência: `decimal.js`. Nenhum decorator do
NestJS, nenhum tipo do ORM (§6.1). Dá para conferir no `package.json` do
pacote.

`packages/wiring` monta os adaptadores e casos de uso usados pela API e pelo
worker. Se a fiação fosse duplicada nos dois apps, eles poderiam acabar usando
adaptadores diferentes, e as duas entradas deixariam de usar o mesmo caso de
uso (§10).

**Dois processos:**

| App | Responsabilidade |
|---|---|
| `apps/api` | borda HTTP: controllers, validação, guard, filtro de exceções |
| `apps/worker` | consumidor SQS, publisher da outbox, worker de `PENDING_REFERENCE`, mais `/metrics` e health |

**Alternativa descartada:** aplicação única com papéis por variável de
ambiente. Acopla as escalas de API e worker e mistura o drain do consumidor
SQS com o encerramento de conexões HTTP em andamento.

## 2. ORM: MikroORM

Escolhido por ser o preferencial do enunciado e porque `em.transactional()`,
`LockMode.PESSIMISTIC_WRITE` e o Unit of Work explícito mapeiam diretamente nos
requisitos de atomicidade e concorrência.

**Alternativa:** TypeORM, aceito pelo enunciado, com `QueryRunner` manual e sem
identity map.

### Contexto transacional

`TransactionRunner.run()` envolve `em.transactional()`. Não há contexto passado
como parâmetro: o MikroORM instala a transação no `AsyncLocalStorage`, e os
repositórios que usam o `EntityManager` contextual se juntam a ela sozinhos.
É o que permite que wallet, conta, transação, ledger e outbox commitem juntos
sem threading manual de um objeto de contexto por toda a camada de aplicação.

`allowGlobalContext: false` está ligado para que usar o EM fora de um
contexto gere erro, em vez de gravar fora da transação.

### Migrations sem o CLI

O `@mikro-orm/cli` precisa de ts-node ou de arquivos compilados para carregar
config e migrations em TypeScript, o que não compensa no Bun.
`scripts/migrate.ts` usa a API do `Migrator` direto, e as migrations ficam
listadas em `migrationsList`, sem glob.

### Por que as migrations são escritas à mão

O caminho convencional seria `migration:create`, que gera a DDL diferenciando o
metadata do ORM contra o banco. Aqui ele produziria tabelas sem as garantias,
que é a falha descrita na §5.9.

O motivo é que os `EntitySchema` deste projeto mapeiam row classes anêmicas:
declaram colunas e tipos, e nada mais. Boa parte das garantias não dá para
expressar neles:

| Garantia | Mecanismo | Expressável no metadata? |
|---|---|---|
| Ledger append-only | trigger `BEFORE UPDATE OR DELETE` | não |
| Partidas dobradas balanceadas | constraint trigger deferida | não |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` | em tese, via `checks` |
| Reversão única | unique parcial com `WHERE ... AND status = 'PROCESSED'` | só por expressão crua |
| Conta de sistema por moeda | unique parcial com `WHERE wallet_id IS NULL` | só por expressão crua |

Rodar `getUpdateSchemaSQL()` contra o schema atual confirma isso: o ORM pede
para derrubar todas as constraints, FKs e índices parciais, porque não sabe que
eles existem.

**O custo:** perdi o `migration:check` como detector de drift. Um campo novo numa row class sem a migration correspondente
passaria batido até quebrar em runtime.

Para compensar, um teste em `schema.e2e.test.ts` compara as colunas que o ORM
espera com as que existem em `information_schema.columns`.

## 3. Money

```ts
Money.from({ amount: "25.00", currency: "BRL" })
```

- **String decimal, nunca `number`.** A validação é um regex
  (`/^\d+(\.\d{1,2})?$/`) aplicado antes de o `Decimal` ver o valor, porque
  `new Decimal("1e3")` é válido para a biblioteca e a §6.1 exige rejeitar
  notação científica. O regex já barra `NaN`, `Infinity`, `1e3`, `""`, `1.234`
  e negativos.
- **Nunca arredonda.** Mais de 2 casas é erro. Truncar perderia centavos sem
  aviso, e a §6.1 lista essa entrada como inválida.
- **`from` é o contrato de entrada e recusa negativos; a aritmética não.**
  `subtract` e `negate` produzem valores negativos legítimos — `isNegative()`
  existe para isso, e a diferença numa reconciliação pode ser negativa.
  `rehydrate` é a porta separada para reconstruir valores da persistência.

### Persistência

Colunas `NUMERIC(20,2)` + `CHAR(3)`, lidas como **string**.

No MikroORM a coluna é declarada assim:

```ts
{ type: 'string', columnType: 'numeric(20,2)' }
```

O `DecimalType` padrão converte para `number`, o que violaria a §5.1. Tratando a coluna como string, o valor exato do Postgres chega
intacto até `Money.rehydrate`.

Pelo mesmo motivo, a soma do ledger na reconciliação é escalada **no SQL**
(`::numeric(20,2)::text`) e não em JavaScript: formatar a escala com
`parseFloat().toFixed(2)` colocaria ponto flutuante no caminho do dinheiro.

**Alternativa descartada:** `BIGINT` em centavos. Exato, mas ilegível no ledger
e frágil com moedas de escala diferente.

## 4. Garantias no schema, não só em código

A §5.9 exige que unicidade, imutabilidade e não-negatividade estejam no banco:

| Garantia | Mecanismo |
|---|---|
| Uma wallet por `playerId` + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance_amount >= 0)` |
| `version >= 1` | `CHECK` |
| Ledger append-only | **trigger `BEFORE UPDATE OR DELETE`** que lança exceção |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| Valor do lançamento positivo | `CHECK (amount > 0)` |
| Um lançamento por conta por transação | `UNIQUE (account_id, transaction_id)` |
| Partidas dobradas balanceadas | **constraint trigger `DEFERRABLE INITIALLY DEFERRED`** |
| Idempotency key única | `UNIQUE (idempotency_key)` |
| Reversão única por tipo | `UNIQUE (reference_transaction_id, kind) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| `REFUND`/`ROLLBACK` com referência | `CHECK` |

Os testes em `test/e2e/schema.e2e.test.ts` escrevem direto no banco, sem passar
pelo domínio, para confirmar que a garantia vem da constraint.

O trigger de partidas dobradas precisa ser `DEFERRABLE INITIALLY DEFERRED`: se
validasse por statement, o primeiro `INSERT` de qualquer par já falharia,
porque o par só fecha no segundo. Há testes para os dois casos.

## 5. Ledger de partidas dobradas

Diferencial opcional (§6.4), implementado.

| Operação | Débito | Crédito |
|---|---|---|
| `OPENING` | `EXTERNAL_FUNDING` | wallet |
| `BET` | wallet | `HOUSE_WAGERING` |
| `WIN` / `REFUND` | `HOUSE_WAGERING` | wallet |
| `ROLLBACK` | inverso da referência | inverso da referência |
| `LOSS` | — | — |

### Saldo das contas de contrapartida

Partidas dobradas pedem que toda conta tenha saldo. Guardar o saldo da conta
da casa criaria uma linha tocada por todas as transações de todas as wallets,
que é o lock global proibido pela §5.6.

**Decisão:** só contas `PLAYER_WALLET` materializam saldo e carregam
`balance_before`/`balance_after`. Nas contas de contrapartida esses campos são
`NULL` e o saldo é derivado por agregação quando necessário.

**Custo:** saber o saldo da casa exige um `SUM` sobre os lançamentos dela. Para
este escopo é aceitável; num sistema real, um snapshot periódico resolveria.

`UNIQUE (account_id, transaction_id)` preserva a regra de §6.4 ("no máximo um
lançamento por wallet por transação"), já que a contrapartida vive em outra
conta.

## 6. Concorrência

A unidade de concorrência é a `walletId` (§8). A estratégia é **lock pessimista
por linha**: `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`, via
`LockMode.PESSIMISTIC_WRITE`.

Wallets diferentes nunca se bloqueiam (§5.6), e uma wallet muito disputada
não gera uma enxurrada de retries.

**Alternativa descartada:** optimistic locking com `version` e retry limitado.
Tem menos contenção quando há pouca disputa, mas desperdiça trabalho
justamente no cenário da §8, em que duas apostas disputam o mesmo saldo.

A coluna `version` é mantida mesmo assim: incrementa só quando o saldo muda
(§6.2), vai no payload de `WalletBalanceChanged` e serve de proteção extra,
junto com o `CHECK (balance_amount >= 0)`.

> A abertura de wallet não usa o lock: não há linha anterior para travar, e a
> corrida de duas criações simultâneas é resolvida pela unique constraint.

### O que está comprovado

`test/e2e/concurrency.e2e.test.ts` roda paralelismo real contra PostgreSQL:

| Cenário | Resultado verificado |
|---|---|
| §8: saldo 100.00, duas apostas de 80.00 simultâneas | uma `PROCESSED`, uma `REJECTED`, saldo 20.00, **um** débito no ledger |
| Mesma aposta 50× em paralelo | uma transação, dois lançamentos, 49 replays, saldo debitado uma vez |
| 20 apostas de 10.00 sobre 100.00 | 10 aceitas, 10 rejeitadas, saldo 0.00, `version` 11 |
| 30 apostas de 7.00 sobre 50.00 | saldo final 1.00, nunca negativo |
| Duas wallets, 5 apostas cada | nenhuma interferência |
| `REFUND` e `ROLLBACK` simultâneos na mesma `BET` | só um credita |
| Três instâncias da aplicação disputando a mesma wallet | 10 aceitas de 21, saldo 0.00, 10 débitos |

As "três instâncias" são três aplicações NestJS completas, cada uma com pool de
conexões, identity map e porta próprios, subindo no mesmo processo de teste.
Isso mostra que a correção depende do banco, e não do estado em memória de um
processo. Três **processos** separados são cobertos pelos testes de
resiliência (seção 11).

### Ordem dentro da transação

Fixa, para evitar deadlock:

1. lock da wallet (`FOR UPDATE`)
2. insert da transação — violação de `UNIQUE(idempotency_key)` é replay ou conflito
3. resolução da referência
4. movimentação do saldo no agregado
5. lançamentos no ledger
6. update da wallet
7. inbox marcado como processado (origem SQS)
8. insert na outbox
9. **commit** — só então o `ack`, e só então o publisher enxerga o evento

## 7. Decisões de interpretação do enunciado

§7 pede que qualquer interpretação adicional seja documentada.

### 7.1 Reversão dupla (§7.4) — interpretação estrita

O texto diz que "uma referência não pode ser revertida duas vezes **pelo mesmo
tipo** de operação". Lido ao pé da letra, uma `BET` poderia receber um `REFUND`
**e** um `ROLLBACK`, creditando o jogador duas vezes — o que viola a invariante
global de §3 ("não duplicar créditos") e a falha eliminatória de §14.

**Adotado:** a constraint do banco implementa a letra da regra
(`UNIQUE (reference_transaction_id, kind)`), e a camada de domínio recusa
**qualquer** segunda reversão da mesma referência, com `failureCode`
`REFERENCE_ALREADY_REVERSED`.

### 7.2 `version` nasce 1 com o saldo inicial

§6.2 diz que `version` inicia em 1 e incrementa só quando o saldo muda; o
exemplo de `POST /wallets` em §9 mostra `version: 1` junto de `balance
1000.00`. Interpretação: o crédito de abertura é parte da criação, não uma
alteração posterior. `Wallet.open` devolve a wallet já com o saldo e a
`BalanceChange` correspondente, sem passar por `credit()`.

### 7.3 Moeda da wallet

`POST /wallets` não tem campo de moeda fora de `initialBalance`. A moeda da
wallet é derivada de `initialBalance.currency`. Saldo inicial `"0.00"` é
permitido e **não** gera transação `OPENING` nem lançamento.

### 7.4 `OPENING` interno

`WagerTransaction.create()` recusa o kind `OPENING` com
`INTERNAL_KIND_NOT_ALLOWED`; a única porta para ele é a factory
`WagerTransaction.opening()`, usada apenas pela abertura de wallet. A restrição
é estrutural, não uma checagem no controller.

Os campos sintéticos da transação de abertura são
`providerId = "internal"`, `externalTransactionId = "opening:{walletId}"` e
`idempotencyKey = "internal:opening:{walletId}"` — o prefixo `internal:` não
colide com o default `{providerId}:{externalTransactionId}` dos provedores.

### 7.5 Idempotency key e `(providerId, externalTransactionId)`

O header `Idempotency-Key` identifica a operação e só precisa ser único. O
formato `{providerId}:{externalTransactionId}` é só uma sugestão. Existem **duas** unique constraints independentes:
`idempotency_key` e `(provider_id, external_transaction_id)`.

Quem decide é um `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, sem alvo
explícito, para cobrir as duas de uma vez. Deixar a unique violation estourar
seria mais simples, mas no Postgres ela aborta a transação inteira e libera o
lock da wallet. O replay, que é comum com entrega at-least-once, ficaria mais
caro que uma submissão normal.

Quando o `INSERT` não insere, há dois desfechos:

- existe linha com a mesma key e o mesmo `payloadHash` → **replay**;
- existe linha com a mesma key e hash diferente, **ou** o conflito veio do par
  `(providerId, externalTransactionId)` com outra key → **409**. O mesmo
  `externalTransactionId` com outra key não é tratado como retry.

### 7.5.1 Saldo observado

§7.7 exige que o replay devolva "o saldo observado naquele momento".
`LOSS`, rejeições e `PENDING_REFERENCE` não geram lançamento, então não há
`balanceAfter` de onde derivar esse saldo. A coluna
`observed_balance_amount` (migration 0002) grava-o no desfecho, e o replay é
uma leitura de linha só.

Sem ela, o replay de uma aposta rejeitada por saldo insuficiente devolveria o
saldo **atual** — que pode ter subido depois de um depósito —, sugerindo ao
provedor que a rejeição não fazia sentido.

### 7.5.2 Rejeição não lança exceção

`SubmitWagerTransactionUseCase` nunca lança para rejeitar: ele persiste o
status `REJECTED` com o `failureCode` e devolve o resultado. Uma exceção
atravessando `em.transactional()` levaria o registro de auditoria junto no
rollback, e §7.6 exige que a rejeição permaneça auditável.

Só estes casos lançam exceção, porque não há o que gravar:

| Situação | Código | Por quê |
|---|---|---|
| Wallet inexistente | `404` | a transação referencia a wallet por FK — não há onde gravar |
| `OPENING` submetido de fora | `422` | a factory recusa construir o objeto |
| `REFUND`/`ROLLBACK` sem referência | `422` | idem |
| Conflito de idempotência | `409` | a linha existente é de outro payload; sobrescrever seria perder histórico |

### 7.6 Hash canônico

SHA-256 hex sobre JSON com chaves ordenadas, sem espaços, `undefined`
descartado. Entram apenas campos de negócio: `providerId`,
`externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
`money.amount`, `money.currency`, `referenceExternalTransactionId`. O header e
metadados de transporte ficam de fora — senão dois envios idênticos por canais
diferentes teriam hashes diferentes.

O inbox usa a mesma função sobre o `data` completo do envelope SQS: escopos
diferentes, propósitos diferentes.

### 7.7 Reconciliação só lê

`POST` porque não é cacheável e tem custo, mas não grava nada. Divergência
responde `200` com `consistent: false`, porque a reconciliação rodou. Com um
status de erro, o cliente não distinguiria "não consegui verificar" de "está
divergente". A divergência é logada e contada em métrica, e nada é corrigido
automaticamente (§9).

### 7.8 Cursor do ledger

Base64url de `(createdAt, id)`, keyset sobre o índice
`(account_id, created_at DESC, id DESC)`. Keyset em vez de OFFSET porque o
ledger só cresce: o cursor continua apontando para o mesmo lugar mesmo com
lançamentos novos chegando. Opaco para que a codificação possa mudar sem
quebrar contrato.

### 7.8.1 `WIN` com referência ausente

§7 diz que `WIN` *pode* referenciar a `BET` da mesma rodada, e
`requiresReference()` continua `true` apenas para `REFUND` e `ROLLBACK`. Mas se
o provedor informa uma referência e ela não existe, ignorá-la seria creditar
sem conferir nada. Adotado: qualquer referência informada e não resolvida leva
a transação para `PENDING_REFERENCE`, independentemente do kind.

### 7.8.2 TTL do `PENDING_REFERENCE`

§7.1 manda definir e justificar o limite. Adotado: backoff exponencial de base
2s, fator 2, teto de 60s; **8 tentativas**, cobrindo cerca de 4 minutos; e um
**TTL absoluto de 10 minutos** desde a criação. O que vencer primeiro encerra.

A razão para os dois limites juntos: o backoff resolve o caso comum, de entrega
fora de ordem por poucos segundos, enquanto o TTL impede que uma transação cuja
referência nunca vai chegar fique pendente indefinidamente. A política está em
`pending-reference-policy.ts` e é consumida pelo worker de `PENDING_REFERENCE`.

### 7.9 Fila de saída

O enunciado nomeia só a fila de entrada. Os eventos de integração publicados
pela outbox vão para `wager-events.fifo`, com `wager-events-dlq.fifo`. O
`MessageGroupId` é o `walletId` na entrada (preserva ordem por wallet, que é a
unidade de concorrência) e o `aggregateId` nos eventos.

O `MessageDeduplicationId` é sempre o `eventId`/`messageId`. É o que torna
inócua a republicação depois de um crash entre a publicação e o commit.

> Numa fila FIFO o SQS descarta, sem erro, qualquer repetição do mesmo
> `MessageDeduplicationId` dentro de 5 minutos. Nos testes isso aparece como
> uma mensagem que não chega, e por isso o harness gera um sufixo único por
> envio.

### 7.10 Não existe inbox "recebida mas não processada"

O skeleton da §6.5 tem `processedAt` e `markProcessed`, o que sugere inserir a
linha do inbox antes de processar e marcá-la depois. Aqui o registro do inbox e
os efeitos financeiros commitam na **mesma** transação, então:

- se a linha existe, tudo commitou junto;
- se o processo morreu antes do commit, não há linha e a redelivery reprocessa
  do zero.

Por isso `processedAt` é preenchido no próprio insert. A entidade segue a API
do enunciado, mas o estado intermediário nunca aparece, então uma mensagem não
tem como ficar presa nele.

### 7.11 Erro de entrega: o que é permanente e o que é transitório

A §10 pede três categorias:

| Categoria | Tratamento |
|---|---|
| Rejeição de negócio | **não lança** — volta como resultado persistido, mensagem recebe `ack` |
| `DomainError` lançado | permanente: vai direto para a DLQ e recebe `ack` |
| Qualquer outro erro | transitório: sem `ack`, visibilidade devolvida com backoff |

O erro permanente vai direto para a DLQ, sem esperar as 5 entregas da redrive
policy, já que o resultado não mudaria. O backoff do transitório é exponencial (5s → 300s) a partir do
`ApproximateReceiveCount`, e esgotada a `maxReceiveCount` o próprio SQS move a
mensagem para a DLQ.

### 7.12 Ordem de locks entre a submissão e o worker

A submissão trava a wallet e depois mexe na transação. Se o worker de
`PENDING_REFERENCE` travasse a transação primeiro, os dois caminhos pegariam os
mesmos locks em ordem oposta e poderiam entrar em deadlock.

Por isso `findDuePendingReferenceIds` faz um `SELECT` **sem lock**, e o worker
então: lê a transação sem lock para descobrir a `walletId`, trava a wallet,
e só então relê a transação com `FOR UPDATE`, conferindo o status de novo.
Isso também permite várias instâncias do worker: quem chega depois encontra o
status já resolvido e desiste.

### 7.13 Evento de pendência sai uma vez só

`WagerTransactionPendingReference` é publicado na primeira vez que a
transação é estacionada. As retentativas do worker não republicam, porque
oito eventos iguais para a mesma transação não ajudariam o provedor. O desfecho (`Processed` ou `Rejected`) sempre gera evento.

## 8. Mapeamento HTTP

A §9 exige distinguir as situações abaixo de forma consistente entre todos os
endpoints. O mapa fica num lugar só (`DomainExceptionFilter`), assim todos os
controllers usam os mesmos códigos.

| Situação | Código |
|---|---|
| Payload inválido | `400` |
| Recurso não encontrado | `404` |
| Conflito (wallet duplicada, idempotency key com payload diferente) | `409` |
| Rejeição por regra de negócio | `422` |
| Aceite com processamento pendente (`PENDING_REFERENCE`) | `202` |
| Falha transitória de infraestrutura | `503` |

Em `POST /wagering/transactions` o código sai do **desfecho da transação**, não
de um `throw`: o controller tem um mapa `status → HTTP`. Isso faz o replay
devolver o mesmo código da requisição original — repetir uma aposta rejeitada
responde `422` de novo, com `idempotentReplay: true`, e não `200`.

**Alternativa descartada:** `400` para rejeição de negócio. Misturaria
rejeição com payload inválido, que o enunciado manda separar, e o provedor
teria que ler a mensagem de erro para decidir se reenvia.

## 9. Autenticação — não implementada

A §2 diz que autenticação não pontua e não deve tirar tempo de correção
financeira, concorrência e idempotência, que valem 70 dos 100 pontos. A decisão foi não implementar.

**O que já existe:**

- `NoopAuthGuard` registrado globalmente (`apps/api/src/auth/`), com decorator
  `@Public()` já aplicado aos health checks e ao `/metrics`;
- `ProviderIdentityPort` em `packages/application/src/ports/`, implementado por
  `TrustedPayloadProviderIdentity`, que hoje confia no `providerId` do payload.

**O desenho que seria adotado:** Keycloak no Compose como IdP OIDC, com um
client por provedor usando client credentials. O guard validaria o JWT contra o
JWKS do realm e o `ProviderIdentityPort` derivaria o `providerId` do claim em
vez do corpo, rejeitando divergência entre o token e o payload com um erro
equivalente ao `WALLET_PLAYER_MISMATCH`. Health checks permaneceriam abertos.
Mensagens da fila continuariam tratadas como canal interno confiável, mas o
`providerId` do payload seguiria sujeito às validações de domínio.

Para isso basta trocar o guard e a implementação do port; o resto da
aplicação não lida com identidade.

## 10. Observabilidade

- **Logs** em JSON via `nestjs-pino`, com `redact` removendo `authorization`,
  `cookie`, `idempotency-key`, corpo da requisição e campos monetários, para
  não logar payloads financeiros completos (§12).
- **`correlationId`** lido de `x-correlation-id` ou gerado como UUIDv7,
  devolvido no header da resposta e incluído no corpo de todo erro.
- **Métricas** em `/metrics` no formato Prometheus, exposto pelos **dois**
  processos.

| Métrica | Onde é produzida |
|---|---|
| `wager_transactions_total{status,kind}` | API e worker |
| `wallets_opened_total` | API |
| `reconciliations_total{result}` | API |
| `idempotent_replays_total`, `idempotency_conflicts_total` | API e worker |
| `inbox_duplicates_total` | worker |
| `retries_total{stage}` | worker (`consumer`, `outbox`, `pending-reference`) |
| `dlq_messages_total{reason}` | worker |
| `outbox_lag_seconds` | worker |
| `processing_latency_seconds{source}` | API e worker |

O worker só expõe HTTP por causa disso. `retries_total`, `dlq_messages_total`
e `outbox_lag_seconds` são incrementadas apenas nele, e cada processo tem seu
próprio registry do `prom-client`, então sem o endpoint essas métricas da §12
não seriam lidas.

Consequência de operar com réplicas: cada réplica do worker expõe o próprio
`/metrics` e precisa ser raspada individualmente. Os contadores são por
processo, e a agregação é do Prometheus.

Não existe `lock_conflicts_total`: com lock pessimista, a disputa vira espera
e não conflito. A espera aparece em `processing_latency_seconds`. É uma
diferença em relação à lista da §12.

## 11. Testes

| Suíte | Alvo |
|---|---|
| `test/unit` (178) | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, JSON canônico, regras das cinco operações, idempotência, dedup de inbox, backoff da outbox, política de TTL, parser de envelope |
| `test/e2e` (112) | Endpoints, atomicidade, constraints e triggers do banco, paginação, health, métricas, concorrência real, mensageria contra SQS real, resiliência com processos de verdade |

O consumidor é exercitado de duas formas: chamando o caso de uso diretamente,
quando o alvo é dedup e atomicidade, e rodando o loop de polling real contra
o LocalStack, quando o alvo é `ack`, DLQ e parada graciosa.

### Processos de verdade

`test/e2e/resilience.e2e.test.ts` sobe processos separados com `Bun.spawn` e
os mata com `SIGKILL`, sem handler nem drain.

Para reproduzir "morto depois do commit e antes do `ack`" existe
`test/support/crash-after-commit.ts`: um processo de teste que monta o mesmo
`CoreModule` do worker, usa o mesmo caso de uso, processa uma mensagem e se
mata antes do `deleteMessage`. Assim o consumidor não precisa de uma flag de
injeção de falha.

O teste confere o sinal de término, e não só o código de saída, porque um
processo que falha ao subir também sai com código diferente de zero. Isso
aconteceu na primeira versão: o processo morria por falta de uma dependência e
o teste passava sem testar nada.

Os dublês em memória existem só nos testes de unidade de caso de uso, para
isolar a orquestração. A suíte de integração usa PostgreSQL e LocalStack reais;
a §14 lista substituí-los por mocks como falha eliminatória.

Depois de cada teste e2e o harness verifica
`wallet.balance == saldo reconstruído pelo ledger` para todas as wallets.

A limpeza entre testes usa `TRUNCATE`, não `DELETE`: o trigger de imutabilidade
recusa `DELETE` por linha, e `TRUNCATE` não dispara triggers de linha.

## 11.1 O que o teste de carga mostrou

Relatório completo em [`docs/load-test.md`](./docs/load-test.md), gerado por
`bun run test:load`. Duas fases, para medir quanto custa a serialização por
wallet.

| Fase | Throughput | p50 | p99 |
|---|---|---|---|
| 600 reqs sobre 10 wallets | ~153 req/s | ~207 ms | ~333 ms |
| 600 reqs sobre **1** wallet | ~78 req/s | ~389 ms | ~649 ms |

**Custo do lock pessimista.** Concentrar tudo numa wallet
derruba o throughput para ~51%, não para perto de zero, porque a seção crítica
é curta: o lock cobre uma transação de poucos milissegundos, não a requisição
inteira. Já o p99 praticamente dobra, porque cada requisição espera na fila do
lock pelas que chegaram antes.

**O gargalo é o publisher da outbox.** A API recebeu 1200 requisições em
~12 s, e a outbox levou ~49 s para drenar depois disso. O publisher envia uma
mensagem por vez, em lotes de 20 a cada segundo — cerca de 20 eventos/s contra
um ingresso de ~103 req/s com até 2 eventos cada.

A melhor correção é trocar `SendMessage` por `SendMessageBatch` (o SQS aceita
10 por chamada), depois lote maior com tick mais curto e, por último, mais
réplicas. Não foi implementada: tratar falha parcial de um batch é um caminho
de erro novo, e preferi não colocá-lo no fim do projeto. Fica como próximo
passo.

O atraso não perde eventos: a outbox é durável e o publisher continua de onde
parou. O efeito é só latência de propagação, e a reconciliação de todas as
wallets depois da carga deu zero divergências.

**A API é single-threaded.** Durante a carga o container ficou em ~100% de um
núcleo com o Postgres abaixo de 1%. O banco não é o limite neste cenário; para
escalar, o caminho é ter mais réplicas, e os testes com três processos mostram
que isso é seguro.

## 12. Limitações conhecidas

1. **`SendMessageBatch` não implementado** no publisher da outbox, apesar de o
   teste de carga apontá-lo como a maior alavanca. Ver §11.1.
2. **O publisher mantém row lock durante I/O de rede.** O lote é reservado
   com `FOR UPDATE SKIP LOCKED` e o lock só é liberado no commit, depois do
   `SendMessage`, para que dois publishers não enviem a mesma mensagem. O lock
   fica preso durante uma chamada externa; isso é aceitável porque o lote é
   pequeno e ninguém mais disputa aquelas linhas, mas vale rever se a latência
   do broker piorar.
3. **Reenviar uma `PENDING_REFERENCE` não reavalia a referência**: é tratado
   como replay, porque é o que a idempotência manda. Quem converte a pendência
   em resultado é o worker agendado, no ritmo do `next_attempt_at`.
4. **Reconciliação não pagina.** É um `SUM`/`COUNT` agregado sobre todos os
   lançamentos da conta. Para wallets com histórico muito longo isso vira uma
   varredura; a resposta seria um saldo de checkpoint periódico.
5. **Saldo das contas de sistema é derivado.** Consequência da decisão da
   seção 5; a alternativa seria uma linha disputada por todas as wallets.
6. **`resolveSystemAccount` faz um SELECT por transação.** Daria para
   cachear, mas não foi feito: cachear o id de uma conta criada
   numa transação que depois sofre rollback produziria violação de chave
   estrangeira nas transações seguintes. Um cache correto só pode ser populado
   após o commit.
7. **Reversão parcial está fora de escopo**, conforme §7.5: o valor de
   `REFUND`/`ROLLBACK` tem que ser idêntico ao da referência.
8. **Lock pessimista serializa a hot wallet.** É a escolha certa para correção,
   mas o throughput por wallet é o de uma fila. O custo medido está na seção
   11.1.
9. **O consumidor processa o lote sequencialmente.** Correto para FIFO, onde a
   ordem dentro de um `MessageGroupId` importa, mas deixa throughput na mesa
   quando o lote traz grupos diferentes. Paralelizar **por grupo** seria o
   próximo passo; paralelizar o lote inteiro quebraria a ordenação.
10. **Sem `lock_conflicts_total`.** Lock pessimista não gera conflito
    contabilizável, gera espera, que aparece em `processing_latency_seconds`.
    Diferença em relação à lista da §12.
11. **Métricas são por processo.** Cada réplica do worker expõe o próprio
    `/metrics`; a agregação é responsabilidade do Prometheus.
12. **`prom-client` está marcado como deprecated** no npm, renomeado para
    `@prometheus-io/client`. Mantido porque o pacote novo está em `0.16.x` e o
    antigo em `15.x` amplamente usado; a migração é trivial quando o sucessor
    amadurecer.

## 13. Notas de ambiente

- **Bun + MikroORM 7** funcionam sem ajustes no driver.
- **`emitDecoratorMetadata` sob Bun** funciona, mas os ports usam
  `@Inject(TOKEN)` explícito de qualquer forma — interfaces TypeScript não
  existem em runtime, então não há tipo para a DI inferir.
- **Bun 1.4 instala por workspace** (linker isolado), então dependências usadas
  por `scripts/` e `test/` na raiz precisam estar declaradas na raiz.
- **Portas do Compose são configuráveis** porque 5432, 4566 e 3000 costumam
  estar ocupadas na máquina de quem avalia.
- **`docker compose up` não rebuilda por padrão.** `bun run docker:up` passa
  `--build`: sem isso, uma imagem antiga em cache sobe sem aviso e dá 404 em
  rotas que existem no código.
- **Long polling do SQS é reduzido a 2s nos testes** (`SQS_WAIT_TIME_SECONDS`).
  20s por `receive` só deixaria a suíte lenta.
