/** 초기 DB 생성 및 초기 계정 정보 저장. 기존 DB/운영 이력은 보존합니다. */
import { mkdir, writeFile } from 'node:fs/promises';
import { openDB } from '../src/db.js';
import { seed } from '../src/seed.js';
const db = await openDB();
const credentials = await seed(db);
await mkdir('data', { recursive: true });
if (Object.keys(credentials).length) {
  await writeFile('data/bootstrap.json', JSON.stringify(credentials, null, 2), { mode: 0o600 });
  console.log('초기 계정: data/bootstrap.json. 외부 공유/커밋 금지.');
} else console.log('기존 계정을 보존했습니다.');
await db.close();
