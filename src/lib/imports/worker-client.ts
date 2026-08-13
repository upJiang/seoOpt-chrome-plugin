import type { DataWorkerRequest, DataWorkerResponse, DataWorkerResult } from './worker-protocol';

export function createDataWorker(): Worker {
  return new Worker(new URL('./data.worker.ts', import.meta.url), { type: 'module', name: 'seo-opt-data-import' });
}

export function requestDataWorker<T extends DataWorkerResult>(
  worker: Worker,
  request: DataWorkerRequest,
  onProgress: (progress: number, stage: string) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (event: MessageEvent<DataWorkerResponse>) => {
      const message = event.data;
      if (message.id !== request.id) return;
      if (message.type === 'PROGRESS') {
        onProgress(message.progress, message.stage);
        return;
      }
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (message.type === 'ERROR') reject(new Error(message.error));
      else resolve(message.result as T);
    };
    const onError = (event: ErrorEvent) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(new Error(event.message || '数据处理 Worker 发生错误。'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(request);
  });
}
