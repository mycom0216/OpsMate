/**
 * 별도의 OpsMate 전용 MariaDB에 스키마와 초기 계정이 생성되는지 확인하는 스모크 테스트입니다.
 * MARIADB_URL이 반드시 필요하며 기존 타 프로젝트의 DB를 지정하면 안 됩니다.
 * 테이블을 삭제하지 않고 계정 목록이 최소 세 개인지만 확인합니다. 전체 통합 검사는 별도 Docker 도구입니다.
 */
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
