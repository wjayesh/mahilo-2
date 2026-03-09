declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: string): string;
}

declare module "node:crypto" {
  interface Hmac {
    digest(encoding: "hex"): string;
    update(value: string): Hmac;
  }

  export function createHmac(algorithm: string, key: string): Hmac;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

interface Buffer extends Uint8Array {
  toString(encoding?: string): string;
}

declare const Buffer: {
  from(value: string, encoding?: string): Buffer;
  from(value: ArrayBuffer | ArrayBufferView | ArrayLike<number>): Buffer;
  concat(values: readonly Uint8Array[]): Buffer;
};

declare function setTimeout(
  handler: (...args: never[]) => void,
  timeout?: number
): unknown;
