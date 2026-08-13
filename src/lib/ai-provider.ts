export function normalizeAiEndpoint(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('请填写 OpenAI-compatible 请求地址。');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('请填写有效的 AI 请求地址，例如 https://codecc.cc/v1。');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('AI 地址必须使用 HTTPS；本机 localhost/127.0.0.1 可使用 HTTP。');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(path)) url.pathname = path;
  else url.pathname = `${path || '/v1'}/chat/completions`;
  url.search = '';
  url.hash = '';
  return url;
}

export function permissionPatternForEndpoint(value: string): string {
  const url = normalizeAiEndpoint(value);
  return `${url.protocol}//${url.host}/*`;
}
