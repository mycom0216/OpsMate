/**
 * 실제 호스트 지표와 선택한 UTF-8 로그 파일의 추가 내용을 OpsMate에 전송하는 실행 스크립트입니다.
 * 실행 전 OPSMATE_URL, AGENT_TOKEN, 선택적인 AGENT_LOG_PATH를 환경변수에 설정합니다.
 * 서버에서 내려온 명령을 실행하는 기능은 없으며 지표와 로그를 밖으로 전송하는 방향만 있습니다.
 */
import { createCollector } from '../src/telemetry.js';
import { stat, open } from 'node:fs/promises';
/**
 * 관제 수신 주소를 설정합니다. localhost 예외 외의 원격 통신은 HTTPS만 허용합니다.
 * 토큰은 환경변수로 받고 요청 헤더에만 사용하며 로그에 출력하지 않습니다.
 */
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
/**
 * 처음 호출할 때 현재 파일 끝을 기억하고 이후 새로 추가된 부분만 읽습니다.
 * 한 번에 최대 32KB를 읽고, 비어 있지 않은 줄 중 마지막 50줄을 최대 4000자로 제한합니다.
 * 파일 크기가 줄어들면 읽기 위치를 0으로 돌립니다. 동일 크기 교체와 UTF-8 경계는 정교하게 처리하지 않습니다.
 * 읽기 위치가 HTTP 전송 전에 증가하므로 전송 실패 시 재전송을 보장하지 않는 단순 tail 방식입니다.
 * @returns {Promise<Array<Object>>} level과 message를 가진 로그 배열. 미설정/파일 오류 시 빈 배열
 */
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
/**
 * OS 지표와 새 로그를 수집해 /api/ingest로 전송하고 HTTP 상태를 확인합니다.
 * 전송 타임아웃은 10초이며 종료 중이 아니면 완료 후 5초 뒤 다시 수행합니다.
 * 실패해도 무한 대기하지 않고 오류를 기록하지만 영속 재전송 큐는 제공하지 않습니다.
 */
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
/**
 * 프로세스 종료 신호가 오면 다음 수집을 중단합니다. 원격 서버를 조작하거나 서비스를 재시작하지 않습니다.
 */
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    process.exit(0);
  });
void cycle();
