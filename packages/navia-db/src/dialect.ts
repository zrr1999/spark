import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  SelectQueryNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";

export interface NodeSqliteDialectConfig {
  database: DatabaseSync | (() => DatabaseSync | Promise<DatabaseSync>);
  onCreateConnection?: (connection: DatabaseConnection) => Promise<void>;
}

export class NodeSqliteDialect implements Dialect {
  readonly #config: NodeSqliteDialectConfig;

  constructor(config: NodeSqliteDialectConfig) {
    this.#config = Object.freeze({ ...config });
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class NodeSqliteDriver implements Driver {
  readonly #config: NodeSqliteDialectConfig;
  readonly #connectionMutex = new ConnectionMutex();
  #db?: DatabaseSync;
  #connection?: NodeSqliteConnection;

  constructor(config: NodeSqliteDialectConfig) {
    this.#config = config;
  }

  async init(): Promise<void> {
    this.#db =
      typeof this.#config.database === "function"
        ? await this.#config.database()
        : this.#config.database;
    this.#connection = new NodeSqliteConnection(this.#db);

    if (this.#config.onCreateConnection) {
      await this.#config.onCreateConnection(this.#connection);
    }
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#connectionMutex.lock();

    if (!this.#connection) {
      this.#connectionMutex.unlock();
      throw new Error("NodeSqliteDriver has not been initialized");
    }

    return this.#connection;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    _settings: TransactionSettings,
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {
    this.#connectionMutex.unlock();
  }

  async destroy(): Promise<void> {
    this.#db?.close();
  }
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const statement = this.#db.prepare(sql);

    if (isReadStatement(statement)) {
      return {
        rows: statement.all(...toSqliteParameters(parameters)) as R[],
      };
    }

    const { changes, lastInsertRowid } = statement.run(...toSqliteParameters(parameters));
    const result: QueryResult<R> = { rows: [] };
    const numAffectedRows = bigintOrUndefined(changes);
    const insertId = bigintOrUndefined(lastInsertRowid);

    if (numAffectedRows !== undefined) {
      Object.assign(result, { numAffectedRows });
    }

    if (insertId !== undefined) {
      Object.assign(result, { insertId });
    }

    return result;
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    _chunkSize?: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    const { sql, parameters, query } = compiledQuery;

    if (!SelectQueryNode.is(query)) {
      throw new Error("NodeSqliteDriver only supports streaming select queries");
    }

    const statement = this.#db.prepare(sql);
    for (const row of statement.iterate(...toSqliteParameters(parameters))) {
      yield {
        rows: [row as R],
      };
    }
  }
}

class ConnectionMutex {
  #promise: Promise<void> | undefined;
  #resolve: (() => void) | undefined;

  async lock(): Promise<void> {
    while (this.#promise) {
      await this.#promise;
    }

    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.#resolve;
    this.#promise = undefined;
    this.#resolve = undefined;
    resolve?.();
  }
}

type SqliteParameter = null | number | bigint | string | Uint8Array;

function toSqliteParameters(parameters: readonly unknown[]): SqliteParameter[] {
  return parameters.map((parameter) => {
    if (
      parameter === null ||
      typeof parameter === "number" ||
      typeof parameter === "bigint" ||
      typeof parameter === "string" ||
      parameter instanceof Uint8Array
    ) {
      return parameter;
    }

    if (typeof parameter === "boolean") {
      return parameter ? 1 : 0;
    }

    if (parameter instanceof Date) {
      return parameter.toISOString();
    }

    throw new TypeError(`Unsupported SQLite parameter type: ${typeof parameter}`);
  });
}

function isReadStatement(statement: StatementSync): boolean {
  const columns = statement.columns();
  return columns.length > 0;
}

function bigintOrUndefined(value: number | bigint | null | undefined): bigint | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return BigInt(value);
}
