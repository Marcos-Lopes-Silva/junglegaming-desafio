/**
 * Só `PLAYER_WALLET` guarda saldo. Guardar o saldo das contas de contrapartida
 * faria todas as wallets disputarem a mesma linha.
 */
export enum LedgerAccountKind {
  PlayerWallet = 'PLAYER_WALLET',
  HouseWagering = 'HOUSE_WAGERING',
  ExternalFunding = 'EXTERNAL_FUNDING',
}

export interface LedgerAccountState {
  id: string;
  kind: LedgerAccountKind;
  walletId: string | undefined;
  currency: string;
  createdAt: Date;
}

export class LedgerAccount {
  private constructor(
    public readonly id: string,
    public readonly kind: LedgerAccountKind,
    public readonly walletId: string | undefined,
    public readonly currency: string,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static openForWallet(props: {
    id: string;
    walletId: string;
    currency: string;
    at: Date;
  }): LedgerAccount {
    return new LedgerAccount(
      props.id,
      LedgerAccountKind.PlayerWallet,
      props.walletId,
      props.currency,
      props.at,
    );
  }

  static openSystemAccount(props: {
    id: string;
    kind: LedgerAccountKind.HouseWagering | LedgerAccountKind.ExternalFunding;
    currency: string;
    at: Date;
  }): LedgerAccount {
    return new LedgerAccount(
      props.id,
      props.kind,
      undefined,
      props.currency,
      props.at,
    );
  }

  static rehydrate(state: LedgerAccountState): LedgerAccount {
    return new LedgerAccount(
      state.id,
      state.kind,
      state.walletId,
      state.currency,
      state.createdAt,
    );
  }

  tracksBalance(): boolean {
    return this.kind === LedgerAccountKind.PlayerWallet;
  }
}
