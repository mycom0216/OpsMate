/** SQLite 온라인 백업을 별도 파일로 생성합니다. 원본 DB를 덮어쓰지 않습니다. */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
const source = resolve(process.env.DB_PATH || 'data/opsmate.sqlite');
const target = resolve(process.argv[2] || `data/backup-${Date.now()}.sqlite`);
if (source === target) throw new Error('백업 경로는 원본과 달라야 합니다.');
const db = new DatabaseSync(source);
try {
  db.prepare('VACUUM INTO ?').run(target);
  console.log('백업 완료', target);
} finally {
  db.close();
}
