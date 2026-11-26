/**
 * Docker 안의 API 검사 스크립트를 표준입력으로 전달하고 결과 JSON만 받아 증빙을 만듭니다.
 * 컨테이너 내부 검사와 Windows 호스트 공개 포트 검사를 분리합니다. 내부 성공이 외부 접속 성공은 아닙니다.
 * 대상은 opsmate-verify 프로젝트이며 증빙은 docker-mariadb-check.json입니다.
 */
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
const compose = [
  'compose',
  '--env-file',
  'data/docker-test.env',
  '-f',
  'deploy/compose.verify.yaml',
  '-p',
  'opsmate-verify',
];
const code = await readFile('tools/docker-api-check.mjs', 'utf8');
const output = execFileSync(
  'docker',
  [...compose, 'exec', '-T', 'opsmate', 'node', '--input-type=module', '-'],
  { input: code, encoding: 'utf8', windowsHide: true },
);
const result = JSON.parse(output);
let hostPort = false;
try {
  hostPort = (
    await fetch('http://127.0.0.1:3102/api/health', { signal: AbortSignal.timeout(3000) })
  ).ok;
} catch {
  /* Windows 호스트 포트 공개는 별도 검증 결과로 남깁니다. */
}
const version = execFileSync('docker', [...compose, 'exec', '-T', 'db', 'mariadb', '--version'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim();
await writeFile(
  'evidence/docker-mariadb-check.json',
  JSON.stringify(
    {
      checked_at: new Date().toISOString(),
      database: version,
      ...result,
      passed: result.checks.length,
      host_port_reachable: hostPort,
      scope:
        '독립 opsmate-verify 프로젝트의 실제 Docker 앱 내부 HTTP 및 MariaDB API 왕복. Windows 호스트 공개 포트 접근 결과는 별도.',
      note: hostPort
        ? '호스트 포트 접속 확인'
        : '이 환경의 Windows 127.0.0.1:3102 접속은 확인하지 못함. 컨테이너 내부 검증만 통과.',
    },
    null,
    2,
  ),
);
console.log(
  'Docker 및 MariaDB 실제 내부 통합 검사',
  result.checks.length,
  '개 통과, 호스트 포트:',
  hostPort,
);
