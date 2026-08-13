import { buildDataset, datasetFingerprint, normalizeCsvRows, parseCsvPreview, type CsvPreview } from './csv';
import { parseServerLog } from '../logs/parser';
import { listDatasets, saveDataset } from '../projects/db';
import type { DatasetKind } from '../projects/types';
import type { CsvPreviewSummary, DataWorkerRequest, DataWorkerResponse } from './worker-protocol';

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<DataWorkerRequest>) => void): void;
  postMessage(message: DataWorkerResponse): void;
}

const scope = globalThis as unknown as WorkerScope;
const previews = new Map<string, { preview: CsvPreview; kind: DatasetKind; fingerprint: string }>();

function progress(id: string, value: number, stage: string): void {
  scope.postMessage({ id, type: 'PROGRESS', progress: value, stage });
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === 'PARSE_CSV') {
        progress(message.id, 20, '正在解析 CSV');
        const preview = parseCsvPreview(message.content, message.kind, message.filename);
        const fingerprint = datasetFingerprint(message.content, message.kind);
        const token = crypto.randomUUID();
        previews.set(token, { preview, kind: message.kind, fingerprint });
        const summary: CsvPreviewSummary = {
          token,
          headers: preview.headers,
          rowCount: preview.rows.length,
          mapping: preview.mapping,
          missingRequired: preview.missingRequired,
          blockedHeaders: preview.blockedHeaders,
          platform: preview.platform,
          errors: preview.errors,
          fingerprint,
        };
        progress(message.id, 100, '解析完成');
        scope.postMessage({ id: message.id, type: 'SUCCESS', result: summary });
        return;
      }
      if (message.type === 'IMPORT_CSV') {
        const cached = previews.get(message.token);
        if (!cached) throw new Error('文件解析会话已失效，请重新选择 CSV。');
        progress(message.id, 15, '正在检查重复文件');
        const existing = await listDatasets(message.projectId);
        if (existing.some((dataset) => dataset.fingerprint === cached.fingerprint)) throw new Error('这个文件已经导入过，请先删除原数据集或选择其他文件。');
        progress(message.id, 45, '正在规范化字段');
        const datasetId = crypto.randomUUID();
        const rows = normalizeCsvRows(cached.preview, { kind: cached.kind, projectId: message.projectId, datasetId, mapping: message.mapping, brandTerms: message.brandTerms });
        const dataset = buildDataset({ id: datasetId, projectId: message.projectId, kind: cached.kind, platform: cached.preview.platform, name: message.filename, mapping: message.mapping, rows, fingerprint: cached.fingerprint });
        progress(message.id, 75, '正在保存本地数据');
        await saveDataset(dataset, rows);
        previews.delete(message.token);
        progress(message.id, 100, '导入完成');
        scope.postMessage({ id: message.id, type: 'SUCCESS', result: dataset });
        return;
      }
      progress(message.id, 20, '正在解析日志');
      const summary = parseServerLog({ projectId: message.projectId, content: message.content, sitemapUrls: message.sitemapUrls });
      progress(message.id, 100, '日志聚合完成');
      scope.postMessage({ id: message.id, type: 'SUCCESS', result: summary });
    } catch (error) {
      scope.postMessage({ id: message.id, type: 'ERROR', error: error instanceof Error ? error.message : '数据处理失败。' });
    }
  })();
});
