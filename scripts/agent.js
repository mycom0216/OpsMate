/** 지정한 OpsMate 서버에 실제 호스트 지표와 선택한 로그 파일의 새 줄을 보냅니다. */
import { createCollector } from '../src/telemetry.js';
import { stat, open } from 'node:fs/promises';
const endpoint = process.env.OPSMATE_URL || 'http://127.0.0.1:3100';
const secret = process.env.AGENT_TOKEN;
if (!secret) throw new Error('AGENT_TOKEN을 지정하십시오.');
if (
  !endpoint.startsWith('https://') &&
  !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(endpoint)
)
  throw new Error('원격 수집에는 HTTPS가 필요합니다.');
const collect = createCollector();
let offset = null,
  stopping = false;
async function logs() {
  if (!process.env.AGENT_LOG_PATH) return [];
  try {
    const s = await stat(process.env.AGENT_LOG_PATH);
    if (offset === null) {
      offset = s.size;
      return [];
    }
    if (s.size < offset) offset = 0;
    const length = Math.min(s.size - offset, 32000);
    if (length <= 0) return [];
    const file = await open(process.env.AGENT_LOG_PATH, 'r');
    const buffer = Buffer.alloc(length);
    try {
      await file.read(buffer, 0, length, offset);
    } finally {
      await file.close();
    }
    offset += length;
    return buffer
      .toString('utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-50)
      .map((message) => ({
        level: /error|fatal/i.test(message) ? 'ERROR' : /warn/i.test(message) ? 'WARN' : 'INFO',
        message: message.slice(0, 4000),
      }));
  } catch (e) {
    console.error('로그 수집 실패', e.message);
    return [];
  }
}
async function cycle() {
  try {
    const sample = await collect();
    sample.logs = await logs();
    const response = await fetch(`${endpoint}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(sample),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`수집 서버 HTTP ${response.status}`);
    console.log('실제 지표 전송', sample.sampled_at);
  } catch (e) {
    console.error(e.message);
  } finally {
    if (!stopping) setTimeout(cycle, 5000);
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    process.exit(0);
  });
void cycle();
