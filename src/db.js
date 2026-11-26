/** SQLite를 기본으로 사용하며 같은 저장소 인터페이스를 MariaDB에서도 제공합니다. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 외래키와 식별자 제약은 수집 오류 및 중복 장애가 데이터로 남는 일을 막습니다.
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
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    store = {
      all: async (sql, args = []) => db.prepare(sql).all(...args),
      get: async (sql, args = []) => db.prepare(sql).get(...args),
      run: async (sql, args = []) => db.prepare(sql).run(...args),
      close: async () => db.close(),
    };
  }
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
