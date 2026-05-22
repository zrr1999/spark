export interface AskConfig {
  schemaVersion: number;
}

export interface AskConfigStore {
  load(): AskConfig;
  save(config: AskConfig): void;
}
