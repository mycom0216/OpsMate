/** 초기화는 기존 데이터를 지우지 않습니다. 새 계정 비밀번호만 호출자에게 반환합니다. */
import os from 'node:os';
import { hashPassword, token, now } from './security.js';
export async function seed(db, { demo = process.env.DEMO_MODE !== 'false' } = {}) {
  const credentials = {};
  for (const role of ['admin', 'operator', 'viewer']) {
    if (await db.get('SELECT id FROM users WHERE username=?', [role])) continue;
    const password =
      role === 'admin' && process.env.ADMIN_PASSWORD
        ? process.env.ADMIN_PASSWORD
        : token().slice(0, 24);
    if (password.length < 12) throw new Error('초기 비밀번호는 12자 이상이어야 합니다.');
    await db.run('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)', [
      role,
      hashPassword(password),
      role,
    ]);
    credentials[role] = password;
  }
  if (!(await db.get('SELECT id FROM servers WHERE name=?', ['실행 호스트'])))
    await db.run('INSERT INTO servers(name,hostname,source,created_at) VALUES(?,?,?,?)', [
      '실행 호스트',
      os.hostname(),
      'local',
      now(),
    ]);
  if (demo && !(await db.get('SELECT id FROM servers WHERE name=?', ['데모 웹 서버']))) {
    const r = await db.run('INSERT INTO servers(name,hostname,source,created_at) VALUES(?,?,?,?)', [
      '데모 웹 서버',
      'demo-web-01',
      'demo',
      now(),
    ]);
    await db.run('INSERT INTO logs(server_id,level,message,source,created_at) VALUES(?,?,?,?,?)', [
      Number(r.lastInsertRowid),
      'ERROR',
      '가상 로그: 디스크 공간 부족, no space left on device',
      'demo',
      now(),
    ]);
  }
  return credentials;
}
