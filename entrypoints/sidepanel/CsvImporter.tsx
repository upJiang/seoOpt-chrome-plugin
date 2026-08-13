import { AlertCircle, Check, FileSpreadsheet, Square, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  MAX_CSV_BYTES,
} from '../../src/lib/imports/csv';
import { createDataWorker, requestDataWorker } from '../../src/lib/imports/worker-client';
import type { CsvPreviewSummary } from '../../src/lib/imports/worker-protocol';
import type { ColumnMapping, DatasetKind, ImportDataset, SearchProject } from '../../src/lib/projects/types';
import { SelectField } from './SelectField';

const KIND_LABELS: Record<DatasetKind, string> = {
  seo_performance: '搜索表现',
  analytics_performance: 'GA4 分析数据',
  sem_performance: '广告表现',
  sem_creative: '创意数据',
  business_outcome: '业务结果',
};

const FIELD_LABELS: Record<string, string> = {
  platform: '平台', date: '日期', query: '查询', page: '页面', impressions: '展示', clicks: '点击', ctr: 'CTR', position: '平均位置',
    source: '来源', medium: '媒介', sessions: '会话数', engagedSessions: '互动会话', users: '用户数', eventName: '事件名称', keyEvents: '关键事件数', analyticsRevenue: 'GA4 收入', currency: '货币',
    campaign: '系列/计划', adGroup: '广告组/单元', keyword: '关键词', searchTerm: '搜索词', matchType: '匹配类型', landingPage: '落地页', cost: '成本', platformConversions: '平台转化', conversionValue: '转化价值',
    conversionAction: '转化动作', conversionType: '主要/观察转化', campaignType: '系列类型', bidStrategy: '出价策略', budget: '预算', device: '设备', location: '地域', hour: '时段', clickId: '点击 ID', utmCampaign: 'UTM 系列', assetGroup: '素材组', finalUrlExpansion: '最终网址扩展',
    headline: '标题', description: '描述', attributionKey: '归因键', status: '业务状态', validConversions: '有效转化', revenue: '收入', refunds: '退款', grossProfit: '毛利', conversionDelayDays: '转化延迟天数',
};

export function CsvImporter({ kind, project, onImported }: {
  kind: DatasetKind;
  project: SearchProject;
  onImported: (dataset: ImportDataset) => Promise<void> | void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const [preview, setPreview] = useState<CsvPreviewSummary | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ value: number; stage: string } | null>(null);

  const worker = () => {
    workerRef.current ??= createDataWorker();
    return workerRef.current;
  };
  useEffect(() => () => workerRef.current?.terminate(), []);

  const cancelProcessing = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setSaving(false);
    setProgress(null);
    setError('已取消本次数据处理，原始文件没有保存。');
  };

  const chooseFile = async (file: File | undefined) => {
    setError('');
    setPreview(null);
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) { setError('CSV 超过 20MB，请按日期或账户拆分后再导入。'); return; }
    try {
      setSaving(true);
      setProgress({ value: 5, stage: '正在读取文件' });
      const content = await file.text();
      const next = await requestDataWorker<CsvPreviewSummary>(worker(), { id: crypto.randomUUID(), type: 'PARSE_CSV', content, kind, filename: file.name }, (value, stage) => setProgress({ value, stage }));
      setFilename(file.name);
      setPreview(next);
      setMapping(next.mapping);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'CSV 解析失败。');
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  const importRows = async () => {
    if (!preview) return;
    setSaving(true);
    setError('');
    try {
      setProgress({ value: 5, stage: '准备导入' });
      const dataset = await requestDataWorker<ImportDataset>(worker(), { id: crypto.randomUUID(), type: 'IMPORT_CSV', token: preview.token, projectId: project.id, brandTerms: project.brandTerms, mapping, filename }, (value, stage) => setProgress({ value, stage }));
      setPreview(null);
      setMapping([]);
      setFilename('');
      if (inputRef.current) inputRef.current.value = '';
      await onImported(dataset);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入失败。');
    } finally {
      setSaving(false);
      setProgress(null);
    }
  };

  const missing = preview ? mapping.filter((item) => preview.missingRequired.includes(item.target) && !item.source).map((item) => item.target) : [];
  return (
    <section className="csv-importer" aria-label={`导入${KIND_LABELS[kind]} CSV`}>
      <div className="csv-import-heading">
        <span className="sticker-icon" aria-hidden="true"><FileSpreadsheet size={18} /></span>
        <div><h3>{KIND_LABELS[kind]} CSV</h3><p>最大 20MB / 100,000 行，仅保存映射后的规范字段。</p></div>
      </div>
      <input ref={inputRef} hidden type="file" accept=".csv,text/csv" id={`csv-${kind}`} onChange={(event) => void chooseFile(event.target.files?.[0])} />
      <button type="button" className="secondary-button csv-choose" disabled={saving} onClick={() => inputRef.current?.click()}><Upload size={17} />选择 CSV</button>
      {progress ? <div className="import-progress" role="status"><div><span>{progress.stage}</span><span>{progress.value}%</span></div><progress max="100" value={progress.value} /><button type="button" className="text-button" onClick={cancelProcessing}><Square size={15} />取消</button></div> : null}
      {error ? <div className="inline-alert" role="alert"><AlertCircle size={16} />{error}</div> : null}
      {preview ? (
        <div className="mapping-panel">
          <div className="mapping-summary"><span>{filename}</span><span>{preview.rowCount.toLocaleString()} 行 · {preview.platform}</span></div>
          {preview.blockedHeaders.length ? <p className="mapping-warning">已排除敏感列：{preview.blockedHeaders.join('、')}</p> : null}
          {preview.errors.length ? <p className="mapping-warning">解析提示：{preview.errors[0]}</p> : null}
          <div className="mapping-grid">
            {mapping.map((item, index) => (
              <SelectField
                key={item.target}
                label={`${FIELD_LABELS[item.target] || item.target}${preview.missingRequired.includes(item.target) ? '（必填）' : ''}`}
                value={item.source}
                error={missing.includes(item.target)}
                onChange={(value) => setMapping((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, source: value, confirmed: Boolean(value) } : entry))}
                options={[{ value: '', label: '不导入' }, ...preview.headers.filter((header) => !preview.blockedHeaders.includes(header)).map((header) => ({ value: header, label: header }))]}
              />
            ))}
          </div>
          {missing.length ? <p className="field-error-text">请完成必填映射：{missing.map((field) => FIELD_LABELS[field] || field).join('、')}</p> : null}
          <button type="button" className="primary-button" disabled={saving || missing.length > 0} onClick={() => void importRows()}>{saving ? '正在导入…' : <><Check size={17} />确认导入</>}</button>
        </div>
      ) : null}
    </section>
  );
}
