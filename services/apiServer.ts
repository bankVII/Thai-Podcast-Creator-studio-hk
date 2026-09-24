import type { IncomingMessage, ServerResponse } from 'node:http';

const models = 'gemini-(?:2\\.5-flash-preview-tts|3\\.1-flash-tts-preview)';
const allowed = new RegExp(`^/v1beta/(?:models/${models}:(?:generateContent|batchGenerateContent)|batches(?:/[a-zA-Z0-9_-]+)?)$`);

// Runs only in Vite's Node server, never in the client bundle.
export function geminiApiMiddleware(getKey: () => string | undefined, request = fetch) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/gemini/')) return next();
    const send = (status: number, message: string) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: status, message } })); };
    try {
      const url = new URL(req.url.slice('/api/gemini'.length), 'https://generativelanguage.googleapis.com');
      if (!allowed.test(url.pathname) || !['GET', 'POST'].includes(req.method ?? '')) return send(404, 'Unknown API route');
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, 'Cross-site request denied');
      const key = getKey();
      if (!key) return send(401, 'เซิร์ฟเวอร์ยังไม่มีคีย์จริง: กรุณากดปุ่ม "เลือก API key" ที่มุมขวาบนของแอปเพื่อตั้งค่าคีย์');
      if (req.method === 'POST' && !req.headers['content-type']?.includes('application/json')) return send(415, 'JSON required');
      const parts: Buffer[] = []; let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 20_000_000) return send(413, 'Request exceeds 20 MB');
        parts.push(Buffer.from(part));
      }
      // No retries here: a lost Batch response must never create a second job.
      const response = await request(url, { method: req.method, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, ...(req.method === 'POST' ? { body: Buffer.concat(parts) } : {}) });
      res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      if (response.body) {
        const reader = response.body.getReader();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); } }
        finally { reader.releaseLock(); }
      }
      res.end();
    } catch {
      if (!res.headersSent) send(502, 'ติดต่อ Google ไม่สำเร็จ ผลการส่งอาจยังไม่แน่นอน กรุณาตรวจสถานะก่อนส่งซ้ำ');
      else res.destroy();
    }
  };
}
