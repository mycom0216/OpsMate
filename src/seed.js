/**
 * 사용자와 최초 서버를 추가하는 멱등 초기화 모듈입니다.
 * 같은 이름의 기존 계정·서버는 보존하며 기존 비밀번호를 재설정하지 않습니다.
 * 샘플 서버와 샘플 오류 로그는 demo 출처로만 생성합니다.
 */
import os from 'node:os';
import { hashPassword, token, now } from './security.js';
/**
 * 없는 초기 계정과 실행 호스트를 생성하고, 요청한 경우 가상 데모 서버를 추가합니다.
 * 반환되는 평문 비밀번호는 이번 호출에서 새로 만든 계정에 한정됩니다.
 * 기존 계정의 비밀번호를 읽거나 반환하지 않습니다. 반환값은 Git/ZIP에 넣으면 안 됩니다.
 * @param {Object} db 저장소
 * @param {Object} options demo=false이면 데모 서버를 추가하지 않습니다.
 * @returns {Promise<Object>} 새 사용자명과 임시 비밀번호의 대응 객체
 */
export async function seed(db, { demo = process.env.DEMO_MODE !== 'false' } = {}) {
  const credentials = {};
  /**
   * admin/operator/viewer는 서로 다른 무작위 초기 비밀번호를 받습니다.
   * ADMIN_PASSWORD는 새 admin을 만드는 경우에만 적용하며 최소 12자를 요구합니다.
   */
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
