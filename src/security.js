/**
 * 인증에 필요한 비밀번호 해시, 무작위 토큰, 쿠키 해석과 감사 기록을 모은 모듈입니다.
 * 비밀번호는 scrypt, 세션·수집 토큰의 조회 키는 SHA256을 사용합니다. 두 용도는 다릅니다.
 * 읽는 순서: hashPassword → verifyPassword → cookieToken → server.js의 로그인 처리.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
/**
 * 예측하기 어려운 32바이트 난수를 64자리 16진수 문자열로 반환합니다.
 * 세션 쿠키와 서버별 수집 토큰을 발급할 때 사용하며 사용자 정보는 담지 않습니다.
 */
export const token = () => randomBytes(32).toString('hex');
/**
 * 토큰 원문을 DB에 저장하지 않기 위한 SHA256 조회 키를 만듭니다.
 * 이 함수는 비밀번호 저장용이 아닙니다. 비밀번호에는 아래 scrypt 함수를 사용합니다.
 */
export const digest = (value) => createHash('sha256').update(value).digest('hex');
/**
 * 비밀번호마다 새 salt를 만들고 64바이트 scrypt 결과를 저장 문자열로 묶습니다.
 * 같은 비밀번호라도 salt가 달라 저장 문자열은 서로 다릅니다.
 * @param {string} password 평문 비밀번호. 로그나 응답에 넣지 않습니다.
 * @returns {string} salt:해시 형식의 저장 값. 복호화하는 값이 아닙니다.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
/**
 * 저장 문자열의 salt로 입력 비밀번호를 다시 계산해 해시가 같은지 검사합니다.
 * 길이를 먼저 확인한 뒤 timingSafeEqual로 비교하여 비교 과정의 시간 차이를 줄입니다.
 * @param {string} password 사용자가 입력한 평문
 * @param {string} stored hashPassword가 생성한 저장 문자열
 * @returns {boolean} 일치 여부. 계정 존재 여부 판단은 호출자가 별도로 수행합니다.
 */
export function verifyPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const expected = Buffer.from(hex, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/**
 * DB의 일반 시각 필드에 사용하는 UTC ISO8601 문자열을 반환합니다.
 * 세션 만료 필드는 이 문자열 대신 Date.now()의 epoch 밀리초를 사용합니다.
 */
export const now = () => new Date().toISOString();
/**
 * 행동 주체·작업명·상세·UTC 시각을 감사 테이블에 추가합니다.
 * 상세 문자열은 최대 2000자입니다. 호출자는 비밀번호나 토큰 원문을 넘기면 안 됩니다.
 * @param {Object} db openDB가 반환한 저장소
 * @param {string} actor 사용자명 또는 agent:서버ID 등의 주체 식별값
 * @param {string} action login, server_created 등의 작업명
 * @param {string} detail 선택적인 작업 설명
 * @returns {Promise<Object>} INSERT 결과
 */
export const audit = (db, actor, action, detail = '') =>
  db.run('INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)', [
    actor,
    action,
    String(detail).slice(0, 2000),
    now(),
  ]);
/**
 * Cookie 헤더에서 opsmate 세션 값만 추출합니다. 쿠키가 없으면 빈 문자열입니다.
 * 추출 자체는 인증이 아닙니다. server.js에서 해시·만료 시각·사용자를 DB와 대조합니다.
 * @param {import("node:http").IncomingMessage} req HTTP 요청
 * @returns {string} 쿠키에 담긴 토큰 또는 빈 문자열
 */
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
