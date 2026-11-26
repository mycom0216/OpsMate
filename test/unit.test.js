/**
 * 외부 HTTP 없이 해시·임계치·중복 억제·검색·벡터와 실제 수집값 형식을 검사합니다.
 * DB가 필요한 검사는 :memory: 저장소를 사용해 실행 DB를 변경하지 않습니다.
 * 각 test의 이름은 검사하려는 동작입니다. 실제 수집 검사는 성능이나 정확도 벤치마크가 아닙니다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, digest } from '../src/security.js';
import { classify, saveSample } from '../src/incidents.js';
import { openDB } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createCollector } from '../src/telemetry.js';
import { tokenize, bm25, cosine, analyze, loadManuals } from '../src/rag.js';
test('비밀번호는 salt별로 다르고 올바른 원문만 통과', () => {
  const a = hashPassword('test-password-123');
  const b = hashPassword('test-password-123');
  assert.notEqual(a, b);
  assert(verifyPassword('test-password-123', a));
  assert(!verifyPassword('wrong', a));
  assert.equal(digest('x').length, 64);
});
test('임계치 직전과 경계값 및 미수집 구분', () => {
  assert.equal(classify({ cpu: 84.9, ram: 89.9, disk: null }).length, 0);
  assert.deepEqual(
    classify({ cpu: 85, ram: 90, disk: 97 }).map((x) => x.category),
    ['CPU', 'MEMORY', 'DISK'],
  );
  assert.equal(classify({ cpu: 97, ram: null, disk: null })[0].severity, 'critical');
});
test('같은 분류의 미해결 장애는 중복 생성되지 않음', async () => {
  const db = await openDB({ path: ':memory:', driver: 'sqlite' });
  try {
    await seed(db);
    const server = await db.get("SELECT * FROM servers WHERE source='local'");
    const s = {
      cpu: 90,
      ram: 50,
      disk: 50,
      network_rx: null,
      network_tx: null,
      sampled_at: new Date().toISOString(),
    };
    await saveSample(db, server, s);
    await saveSample(db, server, s);
    assert.equal((await db.all('SELECT * FROM metrics')).length, 2);
    assert.equal((await db.all('SELECT * FROM incidents')).length, 1);
    assert.equal((await db.all('SELECT * FROM incident_events')).length, 1);
  } finally {
    await db.close();
  }
});
test('실제 수집은 수치 또는 null이며 사용률이 범위 안에 있음', async () => {
  const s = await createCollector()();
  for (const k of ['cpu', 'ram', 'disk']) assert(s[k] === null || (s[k] >= 0 && s[k] <= 100));
  assert.equal(s.network_rx, null);
  assert(!Number.isNaN(Date.parse(s.sampled_at)));
});
test('한국어 부분 어절 검색과 무관 질의 거부', async () => {
  assert(tokenize('메모리가').includes('메모'));
  const docs = await loadManuals();
  assert.equal(bm25('디스크 공간 부족', docs)[0].id, 'disk');
  assert.equal(bm25('zxqv987654321', docs).length, 0);
  const r = await analyze('zxqv987654321', docs, { enabled: false });
  assert.equal(r.mode, 'abstain');
  assert.equal(r.citations.length, 0);
});
test('cosine은 차원과 유한 수치를 검증', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([0, 0], [1, 0]), 0);
  assert.throws(() => cosine([1], [1, 0]));
  assert.throws(() => cosine([NaN], [1]));
});
test('AI 비활성 시 출처를 포함한 매뉴얼 원문 안내', async () => {
  const r = await analyze('CPU 사용률 상승', await loadManuals(), { enabled: false });
  assert.equal(r.mode, 'source-only');
  assert(r.citations.some((c) => c.id === 'cpu'));
  assert(r.answer.includes('[cpu]'));
  assert(r.reviewRequired);
});
