import { FailureCode } from './failure-code.js';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

/** `REFUND` só reverte `BET`; `ROLLBACK` reverte `BET`, `WIN` ou `REFUND`. */
const REVERSIBLE_BY: Readonly<
  Record<string, ReadonlySet<WagerTransactionKind>>
> = {
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

export interface ReferenceCheck {
  /** Transação que está revertendo (ou apenas citando) a referência. */
  transaction: WagerTransaction;
  reference: WagerTransaction;
  /** Já existe uma reversão `PROCESSED` apontando para esta referência. */
  alreadyReversed: boolean;
}

/**
 * Valida uma referência resolvida, devolvendo o `failureCode` da rejeição ou
 * `undefined` quando ela é aceitável.
 *
 * Devolve um código em vez de lançar porque a rejeição precisa ser gravada, e
 * uma exceção faria rollback do registro.
 */
export function checkReference(check: ReferenceCheck): FailureCode | undefined {
  const { transaction, reference, alreadyReversed } = check;

  if (
    reference.providerId !== transaction.providerId ||
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.money.currency !== transaction.money.currency ||
    reference.roundId !== transaction.roundId
  ) {
    return FailureCode.ReferenceScopeMismatch;
  }

  if (transaction.requiresReference()) {
    const reversible = REVERSIBLE_BY[transaction.kind];
    if (!reversible?.has(reference.kind)) {
      return FailureCode.ReferenceKindNotReversible;
    }
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }

  if (transaction.requiresReference()) {
    // Reversão parcial não é suportada: o valor tem que bater.
    if (!reference.money.equals(transaction.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }

    // Qualquer segunda reversão da mesma referência é recusada, não só a do
    // mesmo tipo: um REFUND somado a um ROLLBACK sobre a mesma BET creditaria
    // o jogador duas vezes.
    if (alreadyReversed) {
      return FailureCode.ReferenceAlreadyReversed;
    }
  }

  return undefined;
}
