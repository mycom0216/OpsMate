/**
 * 전용 Docker 앱 안에서 HTTP API부터 실제 MariaDB 저장까지 왕복을 검사합니다.
 * 컨테이너 로컬 bootstrap.json으로 로그인하고 검사 전용 서버·지표·오류 로그·처리 이력을 만듭니다.
 * 결과는 성공한 검사명 목록만 출력하며 비밀번호와 수집 토큰은 출력하지 않습니다.
 */
import { readFile } from 'node:fs/promises';
const credentials = JSON.parse(await readFile('data/bootstrap.json', 'utf8')),
  base = 'http://127.0.0.1:3100';
const login = await fetch(base + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: credentials.admin }),
});
if (!login.ok) throw new Error('Docker 로그인 실패');
const cookie = login.headers.get('set-cookie').split(';')[0];
const checks = ['로그인 세션'];
/**
 * 인증된 내부 HTTP 요청의 상태를 먼저 확인한 다음 본문을 반환합니다.
 * 쓰기 검사는 이 도구가 등록한 서버와 장애에만 수행하며 인증 원문은 결과에 출력하지 않습니다.
 */
async function request(path, method = 'GET', data, auth) {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${b.error}`);
  return b;
}
const s = await request('/servers', 'POST', {
  name: 'Docker MariaDB 검증 ' + Date.now(),
  hostname: 'verify-agent',
  source: 'agent',
});
checks.push('서버 생성 및 토큰');
await request(
  '/ingest',
  'POST',
  {
    cpu: 96,
    ram: 50,
    disk: 50,
    network_rx: 100,
    network_tx: 50,
    logs: [{ level: 'ERROR', message: 'MariaDB 통합 검증 오류' }],
  },
  s.agentToken,
);
checks.push('지표와 로그 저장');
const snapshot = await request('/snapshot');
const incident = snapshot.incidents.find((i) => i.server_id === s.id && i.category === 'CPU');
if (!incident) throw new Error('MariaDB 장애 생성 실패');
checks.push('장애 자동 감지');
const result = await request(`/incidents/${incident.id}/analysis`, 'POST', {});
if (result.mode !== 'source-only') throw new Error('대체 응답 모드 오류');
checks.push('분석 저장');
await request(`/incidents/${incident.id}`, 'PATCH', {
  status: 'resolved',
  note: 'Docker 및 MariaDB 검증 완료',
});
const events = await request(`/incidents/${incident.id}/events`);
if (events.length < 2) throw new Error('처리 이력 누락');
checks.push('해결과 처리 이력');
const logs = await request('/logs?q=' + encodeURIComponent('MariaDB 통합 검증'));
if (!logs.length) throw new Error('로그 검색 누락');
checks.push('로그 검색');
await request('/report');
checks.push('운영 보고서');
const audit = await request('/audit');
if (!audit.length) throw new Error('감사 기록 없음');
checks.push('감사 기록');
console.log(JSON.stringify({ checks, container_node: (await request('/health')).node }));
