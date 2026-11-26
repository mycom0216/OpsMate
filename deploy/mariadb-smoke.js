/** 반드시 OpsMate 전용 테스트 DB를 지정합니다. 기존 테이블을 삭제하지 않습니다. */
import { openDB } from '../src/db.js';
import { seed } from '../src/seed.js';
if (!process.env.MARIADB_URL) throw new Error('전용 MARIADB_URL 필요');
const db = await openDB({ driver: 'mariadb' });
try {
  await seed(db);
  const users = await db.all('SELECT username,role FROM users');
  if (users.length < 3) throw new Error('계정 초기화 실패');
  console.log('MariaDB 스키마와 초기화 스모크 통과');
} finally {
  await db.close();
}
