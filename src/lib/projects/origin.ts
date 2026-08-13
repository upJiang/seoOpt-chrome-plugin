export function normalizeProjectOrigin(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('请输入网站地址。');

  const hostnameWithPort = /^[^\s/?#]+:\d+(?:[/?#]|$)/.test(input);
  const explicitScheme = hostnameWithPort ? undefined : input.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLocaleLowerCase();
  if (explicitScheme) {
    if (explicitScheme !== 'http' && explicitScheme !== 'https') {
      throw new Error('只支持 HTTP 或 HTTPS 网站地址。');
    }
    if (!/^https?:\/\//i.test(input)) {
      throw new Error('协议格式不完整，请使用 http:// 或 https://。');
    }
  }

  const candidate = input.startsWith('//')
    ? `https:${input}`
    : explicitScheme
      ? input
      : `https://${input}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('无法识别这个地址，请输入域名，例如 example.com。');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 HTTP 或 HTTPS 网站地址。');
  }
  if (!parsed.hostname) throw new Error('地址中缺少网站域名。');
  if (parsed.username || parsed.password) throw new Error('网站地址不能包含用户名或密码。');

  return parsed.origin;
}
