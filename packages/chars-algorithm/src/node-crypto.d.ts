declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: string): { digest(encoding: "hex"): string };
  };
  export function createHmac(algorithm: "sha256", key: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
