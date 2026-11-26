/** 공개 제출용 데모 DB는 가상 서버와 가상 지표만 포함하며 계정/세션/토큰은 넣지 않습니다. */
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
await db.run('PRAGMA wal_checkpoint(TRUNCATE)');
await db.close();
console.log('fixtures/demo.sqlite: 가상 데이터만 포함');
