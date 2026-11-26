/**
 * 사용자 PC의 실행 DB와 최초 계정을 준비하는 일회성 진입 스크립트입니다.
 * 읽는 순서: openDB로 스키마 준비 → seed로 없는 데이터만 추가 → 새 비밀번호만 로컬 파일 저장.
 * 다시 실행해도 기존 계정·비밀번호·운영 기록은 삭제하지 않습니다.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { openDB } from '../src/db.js';
import { seed } from '../src/seed.js';
const db = await openDB();
const credentials = await seed(db);
await mkdir('data', { recursive: true });
/**
 * 새 계정이 있을 때만 초기 비밀번호 파일을 씁니다. Git과 제출 ZIP에서 제외해야 합니다.
 */
if (Object.keys(credentials).length) {
  await writeFile('data/bootstrap.json', JSON.stringify(credentials, null, 2), { mode: 0o600 });
  console.log('초기 계정: data/bootstrap.json. 외부 공유/커밋 금지.');
} else console.log('기존 계정을 보존했습니다.');
await db.close();
