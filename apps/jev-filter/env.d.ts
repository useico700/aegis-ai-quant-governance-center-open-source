interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<{ meta: { changes: number } }>;
  all<T>(): Promise<{ results: T[] }>;
}
interface D1Database { prepare(query: string): D1PreparedStatement; }
declare module "cloudflare:workers" { export const env: unknown; }
