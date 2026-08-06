/**
 * orbitdb-core.d.ts — @orbitdb/core 最小类型声明 (2026-08-06)
 * 官方包无 TS 类型 (@types/orbitdb__core 不存在), 只声明本项目用到的 API 子集。
 */

declare module '@orbitdb/core' {
  export interface KeyValue {
    readonly address: string;
    put(key: string, value: unknown): Promise<void>;
    get(key: string): Promise<unknown>;
    del(key: string): Promise<void>;
    all(): Promise<Record<string, unknown>>;
    close(): Promise<void>;
  }

  export interface OrbitDB {
    readonly id: string;
    open(
      name: string,
      options?: {
        type?: string;
        meta?: Record<string, unknown>;
        sync?: boolean;
        overwrite?: boolean;
      },
    ): Promise<KeyValue>;
    stop(): Promise<void>;
  }

  export function createOrbitDB(options: {
    ipfs: unknown;
    directory?: string;
    identity?: unknown;
  }): Promise<OrbitDB>;
}
