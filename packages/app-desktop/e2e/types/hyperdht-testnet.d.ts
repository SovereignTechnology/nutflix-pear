// hyperdht ships no types. The e2e suites run under plain Node and are linted with their own
// project, which does not see the worker's declarations (src/worker/types/holepunch.d.ts); this
// repeats the one module they use.
declare module 'hyperdht/testnet.js' {
  export interface Testnet {
    readonly bootstrap: readonly { host: string; port: number }[];
    destroy(): Promise<void>;
  }
  function createTestnet(size?: number, opts?: { readonly host?: string }): Promise<Testnet>;
  export default createTestnet;
}
