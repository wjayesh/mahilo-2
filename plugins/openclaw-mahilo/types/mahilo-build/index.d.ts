declare module "node:fs" {
  export function existsSync(path: string | URL): boolean;
  export function mkdirSync(
    path: string | URL,
    options?: {
      mode?: number;
      recursive?: boolean;
    }
  ): void;
  export function readFileSync(path: string | URL, encoding: string): string;
  export function rmSync(
    path: string | URL,
    options?: {
      force?: boolean;
      recursive?: boolean;
    }
  ): void;
  export function writeFileSync(
    path: string | URL,
    data: string,
    options?: {
      encoding?: string;
      mode?: number;
    }
  ): void;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
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

declare const process: {
  env: Record<string, string | undefined>;
};

declare const Bun: {
  spawnSync(command: string[], options?: {
    stderr?: "pipe";
    stdout?: "pipe";
    timeout?: number;
  }): {
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  };
};
