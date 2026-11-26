/** 인증 토큰 원문은 저장하지 않으며 비밀번호는 임의 salt와 scrypt로 보호합니다. */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
export const token = () => randomBytes(32).toString('hex');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const expected = Buffer.from(hex, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const now = () => new Date().toISOString();
export const audit = (db, actor, action, detail = '') =>
  db.run('INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)', [
    actor,
    action,
    String(detail).slice(0, 2000),
    now(),
  ]);
export function cookieToken(req) {
  return (
    (req.headers.cookie || '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('opsmate='))
      ?.slice(8) || ''
  );
}
// 잘못된 로그인에도 동일한 해시 검증을 수행하여 사용자 존재 여부 노출을 줄입니다.
export const dummyHash = hashPassword(token());
