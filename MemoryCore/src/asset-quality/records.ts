/** Persistent, optimistic-CAS records. A queue item and its payload are ONE durable write. */
export interface QualityRecord<T = Record<string, any>> {
  key: string; team: string; kind: string; rev: number; updated: number; data: T;
}
export interface QualityRecords {
  get(key: string): Promise<QualityRecord | null> | QualityRecord | null;
  list(kind: string, team?: string, after?: string, limit?: number): Promise<QualityRecord[]> | QualityRecord[];
  cas(record: QualityRecord, expected: number): Promise<boolean> | boolean;
  delete(key: string, expected: number): Promise<boolean> | boolean;
}
