import type { ColumnMapping, DatasetKind, ImportDataset, SearchPlatform, ServerLogSummary } from '../projects/types';

export interface CsvPreviewSummary {
  token: string;
  headers: string[];
  rowCount: number;
  mapping: ColumnMapping[];
  missingRequired: string[];
  blockedHeaders: string[];
  platform: SearchPlatform;
  errors: string[];
  fingerprint: string;
}

export type DataWorkerRequest =
  | { id: string; type: 'PARSE_CSV'; content: string; kind: DatasetKind; filename: string }
  | { id: string; type: 'IMPORT_CSV'; token: string; projectId: string; brandTerms: string[]; mapping: ColumnMapping[]; filename: string }
  | { id: string; type: 'PARSE_LOG'; projectId: string; content: string; sitemapUrls: string[] };

export type DataWorkerResult = CsvPreviewSummary | ImportDataset | ServerLogSummary;

export type DataWorkerResponse =
  | { id: string; type: 'PROGRESS'; progress: number; stage: string }
  | { id: string; type: 'SUCCESS'; result: DataWorkerResult }
  | { id: string; type: 'ERROR'; error: string };
