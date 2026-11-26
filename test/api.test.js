/** 격리된 메모리 DB에서 HTTP·RBAC·WebSocket·상태 전이·수집 검증을 통합 검사합니다. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { openDB } from '../src/db.js';
let app, base, admin, operator, viewer, agentToken, agentId, incidentId;
async function req(path, { cookie, method = 'GET', data, headers = {} } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...headers,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const payload = await r.json();
  return { status: r.status, body: payload, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
before(async () => {
  app = await createApp({
    db: await openDB({ path: ':memory:', driver: 'sqlite' }),
    background: false,
  });
  const a = await app.start(0);
  base = `http://127.0.0.1:${a.port}`;
  for (const role of ['admin', 'operator', 'viewer']) {
    const r = await req('/api/login', {
      method: 'POST',
      data: { username: role, password: app.credentials[role] },
    });
    assert.equal(r.status, 200);
    if (role === 'admin') admin = r.cookie;
    else if (role === 'operator') operator = r.cookie;
    else viewer = r.cookie;
  }
});
after(async () => app.close());
test('비인증 접근과 잘못된 로그인 차단', async () => {
  assert.equal((await req('/api/snapshot')).status, 401);
  assert.equal(
    (await req('/api/login', { method: 'POST', data: { username: 'admin', password: 'invalid' } }))
      .status,
    401,
  );
});
test('viewer와 operator는 서버 등록 불가', async () => {
  for (const cookie of [viewer, operator])
    assert.equal(
      (
        await req('/api/servers', {
          cookie,
          method: 'POST',
          data: { name: 'no', hostname: 'x', source: 'agent' },
        })
      ).status,
      403,
    );
});
test('관리자는 서버 등록과 서버별 수집 토큰 발급 가능', async () => {
  const r = await req('/api/servers', {
    cookie: admin,
    method: 'POST',
    data: { name: '테스트 에이전트', hostname: 'localhost', source: 'agent' },
  });
  assert.equal(r.status, 201);
  agentToken = r.body.agentToken;
  agentId = r.body.id;
  assert.equal(agentToken.length, 64);
  const row = await app.db.get('SELECT token_hash FROM servers WHERE id=?', [agentId]);
  assert.notEqual(row.token_hash, agentToken);
});
test('중복 서버와 부적절한 출처 거부', async () => {
  assert.equal(
    (
      await req('/api/servers', {
        cookie: admin,
        method: 'POST',
        data: { name: '테스트 에이전트', hostname: 'x', source: 'agent' },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await req('/api/servers', {
        cookie: admin,
        method: 'POST',
        data: { name: '잘못된 출처', hostname: 'x', source: 'local' },
      })
    ).status,
    400,
  );
});
test('교차 Origin 변경 요청 거부', async () => {
  assert.equal(
    (
      await req('/api/servers/1', {
        cookie: admin,
        method: 'PATCH',
        headers: { Origin: 'http://evil.example' },
        data: { enabled: 0 },
      })
    ).status,
    403,
  );
});
test('수집 토큰 검증과 이상 수치·로그 배치 사전 검사', async () => {
  const sample = { cpu: 50, ram: 50, disk: 50, network_rx: null, network_tx: null };
  assert.equal((await req('/api/ingest', { method: 'POST', data: sample })).status, 401);
  for (const data of [
    { ...sample, cpu: 101 },
    { ...sample, logs: {} },
    { ...sample, logs: [{ level: 'ERROR', message: '' }] },
  ])
    assert.equal(
      (
        await req('/api/ingest', {
          method: 'POST',
          headers: { Authorization: `Bearer ${agentToken}` },
          data,
        })
      ).status,
      400,
    );
  assert.equal((await app.db.all('SELECT * FROM metrics WHERE server_id=?', [agentId])).length, 0);
});
test('실제 에이전트 수집은 원격 출처로 기록하고 장애 생성', async () => {
  const r = await req('/api/ingest', {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken}` },
    data: {
      cpu: 95,
      ram: 50,
      disk: 50,
      network_rx: 100,
      network_tx: 50,
      source: 'demo',
      logs: [{ level: 'ERROR', message: '테스트 오류 <script>alert(1)</script>' }],
    },
  });
  assert.equal(r.status, 202);
  const rows = await app.db.all('SELECT * FROM incidents WHERE server_id=?', [agentId]);
  assert.equal(rows.length, 2);
  assert(rows.every((x) => x.source === 'agent'));
  incidentId = rows.find((x) => x.category === 'CPU').id;
});
test('로그 검색은 SQL 인젝션과 와일드카드를 데이터로 처리', async () => {
  assert.equal(
    (await req('/api/logs?q=' + encodeURIComponent("' OR 1=1 --"), { cookie: viewer })).body.length,
    0,
  );
  assert.equal((await req('/api/logs?q=%25', { cookie: viewer })).body.length, 0);
  const r = await req('/api/logs?q=' + encodeURIComponent('테스트 오류'), { cookie: viewer });
  assert.equal(r.body.length, 1);
  assert(r.body[0].message.includes('<script>'));
});
test('viewer는 분석과 처리 및 감사 조회 불가', async () => {
  assert.equal(
    (
      await req(`/api/incidents/${incidentId}/analysis`, {
        cookie: viewer,
        method: 'POST',
        data: {},
      })
    ).status,
    403,
  );
  assert.equal((await req('/api/audit', { cookie: viewer })).status, 403);
  assert.equal(
    (
      await req(`/api/incidents/${incidentId}`, {
        cookie: viewer,
        method: 'PATCH',
        data: { status: 'resolved', note: 'x' },
      })
    ).status,
    403,
  );
});
test('운영자 분석은 근거와 함께 저장', async () => {
  const r = await req(`/api/incidents/${incidentId}/analysis`, {
    cookie: operator,
    method: 'POST',
    data: {},
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'source-only');
  assert(r.body.citations.some((x) => x.id === 'cpu'));
  assert.equal(
    (await req(`/api/incidents/${incidentId}/analysis`, { cookie: viewer })).body.length,
    1,
  );
});
test('장애 상태 전이와 처리 이력 기록 및 재발 허용', async () => {
  for (const status of ['acknowledged', 'resolved'])
    assert.equal(
      (
        await req(`/api/incidents/${incidentId}`, {
          cookie: operator,
          method: 'PATCH',
          data: { status, note: '검증 완료' },
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await req(`/api/incidents/${incidentId}`, {
        cookie: operator,
        method: 'PATCH',
        data: { status: 'open', note: 'invalid' },
      })
    ).status,
    409,
  );
  const events = await req(`/api/incidents/${incidentId}/events`, { cookie: viewer });
  assert.equal(events.body.length, 3);
  const row = await app.db.get('SELECT * FROM incidents WHERE id=?', [incidentId]);
  assert.equal(row.active_key, null);
  assert(row.resolved_at);
});
test('관리자만 사용자 생성·역할 변경, 자기 권한 변경 방지', async () => {
  const r = await req('/api/users', {
    cookie: admin,
    method: 'POST',
    data: { username: 'newviewer', password: 'long-password-123', role: 'viewer' },
  });
  assert.equal(r.status, 201);
  assert.equal(
    (
      await req(`/api/users/${r.body.id}/role`, {
        cookie: admin,
        method: 'PATCH',
        data: { role: 'operator' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await req('/api/users/1/role', { cookie: admin, method: 'PATCH', data: { role: 'viewer' } }))
      .status,
    400,
  );
  assert.equal((await req('/api/users', { cookie: viewer })).status, 403);
});
test('운영 보고서는 출처별로 집계하고 측정하지 않은 성능 수치 없음', async () => {
  const r = await req('/api/report', { cookie: viewer });
  assert.equal(r.status, 200);
  assert(r.body.servers.some((x) => x.source === 'demo'));
  assert(r.body.metrics.some((x) => x.source === 'agent'));
  assert.equal(r.body.accuracy, undefined);
});
test('WebSocket은 인증을 요구하며 인증 세션은 연결 가능', async () => {
  const bad = new WebSocket(base.replace('http', 'ws') + '/ws');
  await new Promise((resolve, reject) => {
    bad.on('unexpected-response', (_req, res) => {
      assert.equal(res.statusCode, 401);
      res.resume();
      bad.terminate();
      resolve();
    });
    bad.on('error', () => {});
    setTimeout(() => reject(new Error('연결 검사 시간 초과')), 3000).unref();
  });
  const good = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Cookie: viewer } });
  const message = once(good, 'message');
  await once(good, 'open');
  const [data] = await message;
  assert.equal(JSON.parse(data).type, 'connected');
  good.close();
  await once(good, 'close');
});
test('정적 자산 보안 헤더 및 경로 탈출 차단', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert(r.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
});
test('비활성 서버는 에이전트 수집 차단', async () => {
  assert.equal(
    (await req(`/api/servers/${agentId}`, { cookie: admin, method: 'PATCH', data: { enabled: 0 } }))
      .status,
    200,
  );
  assert.equal(
    (
      await req('/api/ingest', {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentToken}` },
        data: {},
      })
    ).status,
    401,
  );
});
test('로그아웃 후 세션 재사용 불가', async () => {
  assert.equal(
    (await req('/api/logout', { cookie: viewer, method: 'POST', data: {} })).status,
    200,
  );
  assert.equal((await req('/api/me', { cookie: viewer })).status, 401);
});
