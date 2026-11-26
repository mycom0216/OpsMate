/**
 * 실행 중인 SQLite DB의 일관된 복사본을 VACUUM INTO로 별도 파일에 만드는 스크립트입니다.
 * 인자 없이는 시각이 포함된 새 백업 경로를 사용합니다. MariaDB 백업 기능은 아닙니다.
 * 원본과 대상이 같으면 중단하고, 대상 파일이 이미 있으면 SQLite가 덮어쓰지 않고 실패합니다.
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
/**
 * 환경변수의 실행 DB와 명령행의 백업 경로를 절대 경로로 바꿔 같은 파일인지 비교합니다.
 */
const source = resolve(process.env.DB_PATH || 'data/opsmate.sqlite');
const target = resolve(process.argv[2] || `data/backup-${Date.now()}.sqlite`);
if (source === target) throw new Error('백업 경로는 원본과 달라야 합니다.');
const db = new DatabaseSync(source);
try {
  /**
   * 파일 경로도 문자열 SQL에 직접 붙이지 않고 ? 매개변수로 넘깁니다. finally에서 연결을 닫습니다.
   */
  db.prepare('VACUUM INTO ?').run(target);
  console.log('백업 완료', target);
} finally {
  db.close();
}
