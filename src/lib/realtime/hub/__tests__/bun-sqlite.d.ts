declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { create?: boolean });
    exec(sql: string): void;
    query(sql: string): {
      run(...values: (string | number)[]): { changes: number; lastInsertRowid: number | bigint };
      get(...values: (string | number)[]): unknown;
      all(...values: (string | number)[]): unknown[];
    };
    close(): void;
  }
}

declare module "bun:test" {
  export interface Expectation {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toBeTruthy(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeInstanceOf(expected: { readonly prototype: object }): void;
    not: Expectation;
  }
  export function expect(actual: unknown): Expectation;
  export function describe(name: string, run: () => void): void;
  export function it(name: string, run: () => void | Promise<void>): void;
  export function afterEach(run: () => void | Promise<void>): void;
}
