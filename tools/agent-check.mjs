/**
 * 실제 에이전트 프로세스를 loopback 수집 API에 붙이는 수동 통합 검사입니다.
 * 관리자 로그인 → 검사 전용 서버 등록 → 첫 실제 지표 대기 → 새 파일 로그 추가 → 수신 검증 순서입니다.
 * 토큰은 자식 프로세스 환경변수에만 넣습니다. 종료 시 자식을 멈추고 등록 서버를 비활성화합니다.
 * 검사용 오류 로그는 실제 현업 장애가 아니며 증빙은 evidence/agent-check.json입니다.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const credentials = JSON.parse(await readFile('data/bootstrap.json', 'utf8'));
const base = 'http://127.0.0.1:3100';
const login = await fetch(base + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: credentials.admin }),
});
if (!login.ok) throw new Error('테스트 관리자 로그인 실패');
const cookie = login.headers.get('set-cookie').split(';')[0];
const req = async (p, method = 'GET', data) => {
  const r = await fetch(base + '/api' + p, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
};
const registered = await req('/servers', 'POST', {
  name: '실제 에이전트 검증 ' + Date.now(),
  hostname: 'loopback-agent-test',
  source: 'agent',
});
const logPath = new URL('../data/agent-test.log', import.meta.url);
await writeFile(logPath, '');
const child = spawn(process.execPath, ['scripts/agent.js'], {
  env: {
    ...process.env,
    OPSMATE_URL: base,
    AGENT_TOKEN: registered.agentToken,
    // 한글·공백과 Windows 드라이브 문자를 포함한 file URL은 표준 API로 변환합니다.
    AGENT_LOG_PATH: fileURLToPath(logPath),
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (c) => (output += c));
child.stderr.on('data', (c) => (output += c));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let first = false;
  for (let i = 0; i < 20; i++) {
    await pause(1000);
    const rows = await req('/metrics?serverId=' + registered.id);
    if (rows.length) {
      first = true;
      break;
    }
  }
  if (!first) throw new Error('첫 실제 지표 미수신');
  await writeFile(
    logPath,
    'INFO 실제 에이전트 파일 로그 검증\nERROR 실제 에이전트 통합 테스트용 오류\n',
  );
  let success = false;
  for (let i = 0; i < 20; i++) {
    await pause(1000);
    const rows = await req('/logs?q=' + encodeURIComponent('실제 에이전트 통합 테스트용 오류'));
    if (rows.some((x) => x.server_id === registered.id && x.source === 'agent')) {
      success = true;
      break;
    }
  }
  if (!success) throw new Error('실제 파일 로그 미수신');
  const metrics = await req('/metrics?serverId=' + registered.id);
  await writeFile(
    'evidence/agent-check.json',
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        transport: '실제 Node 에이전트 → loopback HTTP',
        server_id: registered.id,
        metric_samples: metrics.length,
        source: metrics[0].source,
        log_received: true,
        note: '발생시킨 테스트 오류 로그이며 현업 장애가 아님. 테스트 후 수집 비활성화.',
      },
      null,
      2,
    ),
  );
  console.log('실제 에이전트 지표 및 파일 로그 수집 검증 통과');
} finally {
  child.kill();
  await req('/servers/' + registered.id, 'PATCH', { enabled: 0 });
}
