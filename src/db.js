/**
 * SQLite와 MariaDB를 같은 all/get/run/close 인터페이스로 감싸는 저장소 모듈입니다.
 * 테이블과 인덱스는 없을 때 생성하며 기존 데이터를 삭제하는 초기화는 하지 않습니다.
 * SQLite 함수도 Promise 형태로 제공하지만 실제 SQLite 쿼리 자체는 동기 실행입니다.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 외래키와 식별자 제약은 수집 오류 및 중복 장애가 데이터로 남는 일을 막습니다.
/**
 * 데이터 관계: users → sessions, servers → metrics/logs/incidents, incidents → events/analyses.
 * 원본 토큰은 저장하지 않고 해시만 저장합니다. metric의 null은 0%가 아니라 미수집입니다.
 * incidents.active_key는 미해결 장애의 중복을 막는 유일키이며 해결하면 null로 바뀝니다.
 * 아래 이름과 SQL은 코드가 정한 상수입니다. 사용자 입력으로 테이블 이름을 만들지 않습니다.
 */
const tables = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username VARCHAR(80) NOT NULL UNIQUE, password_hash TEXT NOT NULL, role VARCHAR(20) NOT NULL CHECK(role IN ('admin','operator','viewer')))`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash VARCHAR(64) PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(100) NOT NULL UNIQUE, hostname VARCHAR(200) NOT NULL, source VARCHAR(20) NOT NULL CHECK(source IN ('local','agent','demo')), token_hash VARCHAR(64), enabled INTEGER NOT NULL DEFAULT 1, created_at VARCHAR(40) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL REFERENCES servers(id), cpu REAL, ram REAL, disk REAL, network_rx REAL, network_tx REAL, source VARCHAR(20) NOT NULL, sampled_at VARCHAR(40) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL REFERENCES servers(id), level VARCHAR(10) NOT NULL, message TEXT NOT NULL, source VARCHAR(20) NOT NULL, created_at VARCHAR(40) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL REFERENCES servers(id), category VARCHAR(30) NOT NULL, severity VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL, title VARCHAR(250) NOT NULL, source VARCHAR(20) NOT NULL, active_key VARCHAR(160) UNIQUE, opened_at VARCHAR(40) NOT NULL, resolved_at VARCHAR(40), resolution TEXT)`,
  `CREATE TABLE IF NOT EXISTS incident_events (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL REFERENCES incidents(id), actor VARCHAR(80) NOT NULL, status VARCHAR(20) NOT NULL, note TEXT NOT NULL, created_at VARCHAR(40) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS analyses (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL REFERENCES incidents(id), mode VARCHAR(40) NOT NULL, answer TEXT NOT NULL, citations TEXT NOT NULL, created_at VARCHAR(40) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor VARCHAR(80) NOT NULL, action VARCHAR(80) NOT NULL, detail TEXT NOT NULL, created_at VARCHAR(40) NOT NULL)`,
];

/**
 * 저장소를 연결하고 스키마와 조회 인덱스를 준비합니다.
 * all은 행 배열, get은 첫 행 또는 undefined, run은 변경 수와 생성 ID를 반환합니다.
 * 외부 입력값은 SQL 문자열에 연결하지 말고 args 배열의 ? 매개변수로 전달합니다.
 * @param {Object} options 연결 옵션. 생략하면 환경변수와 기본값을 사용합니다.
 * @param {string} options.path SQLite 파일 경로. 테스트에서는 :memory:를 사용합니다.
 * @param {string} options.driver sqlite 또는 mariadb
 * @param {string} options.url MariaDB 연결 URL. 전용 DB는 미리 만들어야 합니다.
 * @returns {Promise<Object>} all, get, run, close 메서드가 있는 저장소
 * @throws 연결 실패, 지원하지 않는 드라이버, 스키마 생성 실패
 */
export async function openDB({
  path = process.env.DB_PATH || 'data/opsmate.sqlite',
  driver = process.env.DB_DRIVER || 'sqlite',
  url = process.env.MARIADB_URL,
} = {}) {
  let store;
  if (driver === 'mariadb') {
    if (!url) throw new Error('MARIADB_URL이 필요합니다.');
    const { default: mariadb } = await import('mariadb');
    const u = new URL(url);
    /**
     * 동시 연결 수를 5개로 제한하고 정수 결과를 JS Number로 통일합니다.
     * URL의 사용자명·비밀번호는 퍼센트 인코딩을 해제하되 화면이나 로그로 출력하지 않습니다.
     */
    const pool = mariadb.createPool({
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1),
      connectionLimit: 5,
      insertIdAsNumber: true,
      bigIntAsNumber: true,
    });
    store = {
      all: (sql, args = []) => pool.query(sql, args),
      get: async (sql, args = []) => (await pool.query(sql, args))[0],
      run: async (sql, args = []) => {
        const r = await pool.query(sql, args);
        return { lastInsertRowid: Number(r.insertId), changes: r.affectedRows };
      },
      close: () => pool.end(),
    };
  } else {
    if (driver !== 'sqlite') throw new Error('지원하지 않는 DB_DRIVER');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    /**
     * 외래키 검사를 켜고 WAL 모드와 잠금 대기 5초를 설정합니다.
     * WAL은 읽기·쓰기 경합을 줄이지만 JS의 동기 쿼리를 비동기로 바꾸지는 않습니다.
     */
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    store = {
      all: async (sql, args = []) => db.prepare(sql).all(...args),
      get: async (sql, args = []) => db.prepare(sql).get(...args),
      run: async (sql, args = []) => db.prepare(sql).run(...args),
      close: async () => db.close(),
    };
  }
  /**
   * 두 DB가 다른 자동 증가 문법과 실수 타입만 변환합니다.
   * 이미 존재하는 테이블의 컬럼을 바꾸거나 SQLite 데이터를 MariaDB로 이관하지 않습니다.
   */
  for (let sql of tables) {
    if (driver === 'mariadb')
      sql = sql
        .replaceAll('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER PRIMARY KEY AUTO_INCREMENT')
        .replaceAll(' REAL', ' DOUBLE');
    await store.run(sql);
  }
  // 주요 시간순 조회에 쓰이는 인덱스는 재실행 시에도 안전하게 생성합니다.
  for (const [name, table, cols] of [
    ['idx_metrics_server_time', 'metrics', 'server_id, sampled_at'],
    ['idx_logs_time', 'logs', 'created_at'],
    ['idx_incidents_status', 'incidents', 'status'],
  ]) {
    if (driver === 'sqlite')
      await store.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
    else if (!(await store.all(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [name])).length)
      await store.run(`CREATE INDEX ${name} ON ${table} (${cols})`);
  }
  return store;
}
