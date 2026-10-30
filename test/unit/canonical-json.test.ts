import { describe, expect, it } from 'bun:test';
import { Sha256PayloadHasher, canonicalJson } from '@wagering/infrastructure';

describe('canonicalJson', () => {
  it('ordena as chaves', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('é estável independente da ordem de escrita', () => {
    const one = canonicalJson({
      kind: 'BET',
      money: { currency: 'BRL', amount: '25.00' },
    });
    const two = canonicalJson({
      money: { amount: '25.00', currency: 'BRL' },
      kind: 'BET',
    });

    expect(one).toBe(two);
  });

  it('descarta undefined mas preserva null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('preserva a ordem dos arrays', () => {
    expect(canonicalJson({ xs: [3, 1, 2] })).toBe('{"xs":[3,1,2]}');
  });

  it('não insere espaços', () => {
    expect(canonicalJson({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
});

describe('Sha256PayloadHasher', () => {
  const hasher = new Sha256PayloadHasher();

  it('produz hex de 64 caracteres', () => {
    expect(hasher.hash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mesmo payload em ordem diferente produz o mesmo hash', () => {
    expect(hasher.hash({ a: 1, b: 2 })).toBe(hasher.hash({ b: 2, a: 1 }));
  });

  it('payload diferente produz hash diferente', () => {
    // É isto que separa replay de conflito de idempotência.
    expect(hasher.hash({ amount: '25.00' })).not.toBe(
      hasher.hash({ amount: '25.01' }),
    );
  });
});
