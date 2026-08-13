import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.SEO_OPT_FIXTURE_PORT || 4173);
const aiPort = Number(process.env.SEO_OPT_AI_FIXTURE_PORT || 4174);
const root = fileURLToPath(new URL('./site/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/robots.txt') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`User-agent: *\nAllow: /\nSitemap: http://127.0.0.1:${port}/sitemap.xml\n`);
    return;
  }
  if (url.pathname === '/sitemap.xml') {
    response.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    response.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://127.0.0.1:${port}/healthy.html</loc></url><url><loc>http://127.0.0.1:${port}/overseas-demo.html</loc></url></urlset>`);
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    return;
  }

  const relative = url.pathname === '/' ? 'healthy.html' : decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    await stat(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Not found</title><h1>404</h1>');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`SEO优化 fixtures: http://127.0.0.1:${port}`));

const aiServer = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${aiPort}`);
  if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const userTurns = Array.isArray(payload.messages)
        ? payload.messages.filter((message) => message?.role === 'user').length
        : 0;
      const latestUserMessage = Array.isArray(payload.messages)
        ? [...payload.messages].reverse().find((message) => message?.role === 'user')?.content || ''
        : '';
      const sendResponse = () => {
        if (response.destroyed) return;
        if (latestUserMessage.includes('模拟失败')) {
          response.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: { message: '测试服务暂时繁忙，请稍后重试' } }));
          return;
        }
        const answer = `## 第 ${userTurns} 轮回答\n\n- 先按证据修复高优先级问题。\n- 修改后重新扫描并观察指标。`;
        if (payload.stream) {
          response.writeHead(200, {
            'Cache-Control': 'no-cache',
            'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive',
          });
          const parts = [answer.slice(0, 8), answer.slice(8, 30), answer.slice(30)];
          let index = 0;
          const writeNext = () => {
            if (response.destroyed) return;
            if (index >= parts.length) {
              response.write('data: [DONE]\n\n');
              response.end();
              return;
            }
            const content = JSON.stringify({ choices: [{ delta: { content: parts[index] } }] });
            response.write(`data: ${content}\n\n`);
            index += 1;
            setTimeout(writeNext, 35);
          };
          writeNext();
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: answer,
            },
          }],
        }));
      };
      if (latestUserMessage.includes('延迟回答')) setTimeout(sendResponse, 2_500);
      else sendResponse();
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
});

aiServer.listen(aiPort, '127.0.0.1', () => console.log(`SEO优化 AI fixture: http://127.0.0.1:${aiPort}`));
