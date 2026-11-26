/**
 * 계정·세션·토큰을 넣지 않은 공개 제출용 가상 SQLite 템플릿을 생성합니다.
 * 이 파일과 scripts/init.js는 목적이 다릅니다. 실제 로그인 계정은 사용자 환경에서 init이 만듭니다.
 * 처음 만든 가상 서버와 24개 지표가 있으면 재실행 시 같은 샘플을 덧붙이지 않습니다.
 */
import { openDB } from '../src/db.js';
import { demoSample } from '../src/telemetry.js';
import { saveSample } from '../src/incidents.js';
import { mkdir } from 'node:fs/promises';
await mkdir('fixtures', { recursive: true });
const db = await openDB({ path: 'fixtures/demo.sqlite', driver: 'sqlite' });
if (!(await db.get('SELECT id FROM servers LIMIT 1')))
  await db.run('INSERT INTO servers(name,hostname,source,created_at) VALUES(?,?,?,?)', [
    '데모 웹 서버',
    'demo-web-01',
    'demo',
    new Date().toISOString(),
  ]);
const server = await db.get('SELECT * FROM servers LIMIT 1');
if (!(await db.get('SELECT id FROM metrics LIMIT 1')))
  for (let i = 0; i < 24; i++)
    await saveSample(db, server, {
      ...demoSample(i),
      sampled_at: new Date(Date.now() - (24 - i) * 5000).toISOString(),
    });
/**
 * 공유할 DB 파일 하나에 WAL 변경 사항을 반영한 다음 연결을 닫습니다.
 */
await db.run('PRAGMA wal_checkpoint(TRUNCATE)');
await db.close();
console.log('fixtures/demo.sqlite: 가상 데이터만 포함');
