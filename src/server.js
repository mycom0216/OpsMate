/**
 * OpsMate의 HTTP API, 세션 인증, 권한 검사, WebSocket과 주기 수집을 연결하는 진입 모듈입니다.
 * 요청 흐름: 공통 보안 헤더 → 공개 로그인/수집 API → 세션 검사 → API별 권한·입력 검증 → 저장.
 * 수집기는 telemetry.js, 장애 생성은 incidents.js, 매뉴얼 검색과 AI 응답은 rag.js가 담당합니다.
 * 실행 명령을 받는 API는 없으며 모든 운영 조치는 담당자가 별도로 수행합니다.
 */
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { openDB } from './db.js';
import { seed } from './seed.js';
import {
  token,
  digest,
  verifyPassword,
  hashPassword,
  dummyHash,
  cookieToken,
  now,
  audit,
} from './security.js';
import { createCollector, demoSample } from './telemetry.js';
import { saveSample, openIncident } from './incidents.js';
import { loadManuals, analyze } from './rag.js';

/**
 * 실행 폴더가 달라도 모듈 위치를 기준으로 public 디렉터리를 찾습니다.
 */
const root = fileURLToPath(new URL('../public/', import.meta.url));
/**
 * HTTP 상태를 포함한 오류 객체를 만듭니다. 맨 아래 catch가 사용자에게 보낼 응답을 결정합니다.
 */
const fail = (status, message) => Object.assign(new Error(message), { status });
/**
 * 화면의 버튼 유무와 관계없이 서버에서 역할을 검사합니다. 허용 목록 밖이면 403을 던집니다.
 */
const requireRole = (user, roles) => {
  if (!roles.includes(user.role)) throw fail(403, '권한이 없습니다.');
};
/**
 * 필수 문자열의 타입·공백·최대 길이를 확인하고 양끝 공백을 제거합니다. 잘못된 입력은 400입니다.
 */
const text = (v, max = 1000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw fail(400, '문자열 입력을 확인하십시오.');
  return v.trim();
};
/**
 * URL에서 받은 ID를 양의 안전 정수로 변환합니다. 소수·0·음수·범위를 벗어난 값은 거부합니다.
 */
const idOf = (v) => {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(400, 'ID 형식 오류');
  return id;
};
/**
 * HTTP 본문을 청크 단위로 읽되 누적 64KiB를 넘으면 중단합니다.
 * 빈 본문은 빈 객체, 잘못된 JSON은 400으로 취급합니다.
 * @param {import("node:http").IncomingMessage} req 요청 스트림
 * @returns {Promise<Object>} JSON 파싱 결과. 각 API가 필요한 필드를 추가로 검증합니다.
 */
async function body(req) {
  let bytes = 0,
    chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536) throw fail(413, '요청 크기 초과');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw fail(400, 'JSON 형식 오류');
  }
}
/**
 * 저장소·초기 데이터·API·WebSocket·수집 루프를 묶은 앱 인스턴스를 만듭니다.
 * 테스트는 메모리 DB와 background=false를 주입해 실제 운영 파일과 타이머를 분리합니다.
 * 생성만으로 포트를 열지 않으며 반환한 start를 호출해야 요청을 받습니다.
 * @param {Object} options db, background, demo, aiOptions를 주입할 수 있습니다.
 * @returns {Promise<Object>} server, db, start, close, credentials, snapshot
 * credentials에는 이번 초기화로 만든 임시 비밀번호만 있으므로 외부 응답에 넣지 않습니다.
 */
export async function createApp({
  db,
  background = true,
  demo = process.env.DEMO_MODE !== 'false',
  aiOptions = {},
} = {}) {
  db ||= await openDB();
  const credentials = await seed(db, { demo });
  const manuals = await loadManuals();
  const sockets = new Set(),
    attempts = new Map();
  /**
   * 쿠키의 토큰 해시, DB 세션의 만료 시각, 연결된 사용자를 모두 대조합니다.
   * 조회 시마다 최신 역할을 읽으며 비밀번호 해시는 반환하지 않습니다.
   */
  const userFor = async (req) =>
    db.get(
      'SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?',
      [digest(cookieToken(req)), Date.now()],
    );
  /**
   * 브라우저가 Origin을 보냈다면 요청의 프로토콜·Host와 정확히 같은지 확인합니다.
   * Origin이 없는 CLI/에이전트 요청은 허용합니다. 로그인 쿠키의 SameSite 정책과 함께 사용합니다.
   */
  const originOK = (req) =>
    !req.headers.origin ||
    req.headers.origin === `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  /**
   * 모든 API 응답을 UTF-8 JSON으로 보내고 인증 관련 데이터의 브라우저 캐시를 방지합니다.
   */
  const send = (res, status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };
  /**
   * 서버별 최신 지표, 최근 장애 200건, 전체 출처별 집계를 묶어 반환합니다.
   * 서버 목록에 token_hash를 포함하지 않아 화면과 개발자 JSON 탭에 인증 키가 노출되지 않습니다.
   */
  const snapshot = async () => ({
    servers: await db.all(
      'SELECT s.id,s.name,s.hostname,s.source,s.enabled,m.cpu,m.ram,m.disk,m.network_rx,m.network_tx,m.sampled_at FROM servers s LEFT JOIN metrics m ON m.id=(SELECT MAX(x.id) FROM metrics x WHERE x.server_id=s.id) ORDER BY s.id',
    ),
    incidents: await db.all(
      'SELECT i.*,s.name AS server_name FROM incidents i JOIN servers s ON s.id=i.server_id ORDER BY i.id DESC LIMIT 200',
    ),
    stats: await db.all(
      'SELECT source,status,category,COUNT(*) AS count FROM incidents GROUP BY source,status,category',
    ),
    at: now(),
  });
  /**
   * 열려 있는 인증 WebSocket에 같은 스냅샷을 전송합니다.
   * 전송 대기량이 1MB를 넘는 느린 연결은 종료해 서버 버퍼의 무제한 증가를 줄입니다.
   */
  const broadcast = async () => {
    const data = JSON.stringify({ type: 'snapshot', data: await snapshot() });
    for (const ws of sockets) {
      if (ws.readyState === 1) {
        if (ws.bufferedAmount > 1000000) ws.terminate();
        else ws.send(data);
      }
    }
  };
  /**
   * 공통 보안 헤더를 먼저 설정한 다음 경로별 처리를 수행합니다.
   * 전체 요청을 try/catch로 감싸되 내부 오류의 상세는 클라이언트에 공개하지 않습니다.
   */
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      const method = req.method;
      /**
       * GET /api/health: 로그인 없이 실행 여부와 Node 버전을 확인하는 상태 검사입니다.
       */
      if (p === '/api/health' && method === 'GET')
        return send(res, 200, { status: 'ok', node: process.version });
      /**
       * POST /api/login: IP별 1분 15회 제한 → 입력 검증 → 해시 검증 → 8시간 세션 발급 순서입니다.
       * 존재하지 않는 계정도 dummyHash를 검증하고, 실패 이유를 아이디/비밀번호 중 하나로 구분하지 않습니다.
       * DB에는 세션 토큰 해시만 저장하고 원문은 HttpOnly 쿠키로만 전달합니다.
       */
      if (p === '/api/login' && method === 'POST') {
        if (!originOK(req)) throw fail(403, '허용되지 않는 Origin');
        const ip = req.socket.remoteAddress;
        const entry = attempts.get(ip) || { count: 0, until: Date.now() + 60000 };
        if (entry.until < Date.now()) {
          entry.count = 0;
          entry.until = Date.now() + 60000;
        }
        if (++entry.count > 15) throw fail(429, '로그인 시도 제한');
        attempts.set(ip, entry);
        const b = await body(req);
        const username = text(b.username, 80);
        const password = text(b.password, 256);
        const user = await db.get('SELECT * FROM users WHERE username=?', [username]);
        const valid = verifyPassword(password, user?.password_hash || dummyHash);
        if (!user || !valid) {
          await audit(db, username, 'login_failed');
          throw fail(401, '아이디 또는 비밀번호 오류');
        }
        const value = token();
        await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', [
          digest(value),
          user.id,
          Date.now() + 8 * 3600000,
        ]);
        res.setHeader(
          'Set-Cookie',
          `opsmate=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${req.socket.encrypted ? '; Secure' : ''}`,
        );
        await audit(db, user.username, 'login');
        return send(res, 200, { id: user.id, username: user.username, role: user.role });
      }
      // 원격 수집기는 서버별 토큰으로만 접근합니다. 서버 ID와 데이터 출처는 서버에서 결정합니다.
      /**
       * POST /api/ingest: 로그인 쿠키 대신 등록한 서버의 Bearer 토큰을 검사합니다.
       * 본문의 source·서버 ID는 신뢰하지 않으며 토큰으로 찾은 활성 agent 서버를 사용합니다.
       * 모든 지표와 로그를 먼저 검증한 뒤 저장하여 검증 오류로 인한 배치의 부분 반영을 줄입니다.
       */
      if (p === '/api/ingest' && method === 'POST') {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer ')) throw fail(401, '수집 토큰 필요');
        const target = await db.get(
          "SELECT * FROM servers WHERE token_hash=? AND source='agent' AND enabled=1",
          [digest(auth.slice(7))],
        );
        if (!target) throw fail(401, '수집 토큰 오류');
        const b = await body(req);
        const sample = {};
        for (const key of ['cpu', 'ram', 'disk', 'network_rx', 'network_tx']) {
          const value = b[key];
          if (
            value !== null &&
            (typeof value !== 'number' ||
              !Number.isFinite(value) ||
              value < 0 ||
              value > (key.startsWith('network') ? 1e15 : 100))
          )
            throw fail(400, `지표 범위 오류 ${key}`);
          sample[key] = value;
        }
        // 로그까지 검증한 뒤 쓰기 작업을 시작하여 잘못된 배치의 부분 반영을 막습니다.
        const logs = b.logs ?? [];
        if (!Array.isArray(logs) || logs.length > 100)
          throw fail(400, '로그는 100건 이하 배열이어야 합니다.');
        for (const l of logs) {
          if (!['INFO', 'WARN', 'ERROR'].includes(l.level)) throw fail(400, '로그 레벨 오류');
          text(l.message, 4000);
        }
        sample.sampled_at = now();
        await saveSample(db, target, sample);
        for (const l of logs) {
          await db.run(
            'INSERT INTO logs(server_id,level,message,source,created_at) VALUES(?,?,?,?,?)',
            [target.id, l.level, l.message, 'agent', now()],
          );
          if (l.level === 'ERROR')
            await openIncident(db, target, {
              category: 'LOG',
              severity: 'warning',
              title: '수집 로그 ERROR 감지',
            });
        }
        await audit(db, `agent:${target.id}`, 'ingest', `${logs.length}개 로그`);
        await broadcast();
        return send(res, 202, { accepted: true });
      }
      /**
       * 여기 아래 API는 공통으로 로그인 세션이 필요합니다.
       * 변경 요청에는 Origin 검사도 적용하고, 관리/운영 API에서는 추가 역할 검사를 수행합니다.
       */
      if (p.startsWith('/api/')) {
        const user = await userFor(req);
        if (!user) throw fail(401, '로그인이 필요합니다.');
        if (!['GET', 'HEAD'].includes(method) && !originOK(req))
          throw fail(403, '허용되지 않는 Origin');
        /**
         * GET /api/me: 현재 세션의 ID·계정명·역할을 반환합니다. 화면 재접속 시 로그인 상태 확인에 사용합니다.
         */
        if (p === '/api/me' && method === 'GET') return send(res, 200, user);
        /**
         * POST /api/logout: 현재 세션을 삭제하고 쿠키를 만료시킵니다.
         * 현재 구현은 같은 사용자의 열린 WebSocket도 함께 닫지만 다른 HTTP 세션까지 삭제하지는 않습니다.
         */
        if (p === '/api/logout' && method === 'POST') {
          await db.run('DELETE FROM sessions WHERE token_hash=?', [digest(cookieToken(req))]);
          res.setHeader('Set-Cookie', 'opsmate=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          for (const ws of sockets) if (ws.userId === user.id) ws.close(1000, '로그아웃');
          return send(res, 200, { ok: true });
        }
        /**
         * POST /api/password: 현재 비밀번호가 맞아야 새 해시를 저장합니다.
         * 변경 뒤 해당 사용자의 모든 세션과 WebSocket을 폐기하므로 새 비밀번호로 재로그인해야 합니다.
         */
        if (p === '/api/password' && method === 'POST') {
          const b = await body(req);
          const old = text(b.currentPassword, 256),
            next = text(b.newPassword, 256);
          if (next.length < 12) throw fail(400, '새 비밀번호는 12자 이상');
          const row = await db.get('SELECT password_hash FROM users WHERE id=?', [user.id]);
          if (!verifyPassword(old, row.password_hash)) throw fail(403, '현재 비밀번호 오류');
          await db.run('UPDATE users SET password_hash=? WHERE id=?', [
            hashPassword(next),
            user.id,
          ]);
          await db.run('DELETE FROM sessions WHERE user_id=?', [user.id]);
          for (const ws of sockets) if (ws.userId === user.id) ws.close();
          await audit(db, user.username, 'password_changed');
          return send(res, 200, { ok: true });
        }
        /**
         * GET /api/snapshot: 대시보드와 읽기 전용 코드 작업 공간이 함께 사용하는 최신 관제 데이터입니다.
         */
        if (p === '/api/snapshot' && method === 'GET') return send(res, 200, await snapshot());
        /**
         * POST /api/servers: 관리자만 agent/demo 서버를 등록할 수 있습니다.
         * 서버별 원문 토큰은 생성 응답에서 한 번만 보여 주고 DB에는 해시만 저장합니다.
         */
        if (p === '/api/servers' && method === 'POST') {
          requireRole(user, ['admin']);
          const b = await body(req);
          const name = text(b.name, 100),
            hostname = text(b.hostname, 200);
          if (!['agent', 'demo'].includes(b.source))
            throw fail(400, '신규 서버 출처는 agent 또는 demo');
          if (b.source === 'demo' && !demo) throw fail(400, '데모 모드 비활성화');
          if (await db.get('SELECT id FROM servers WHERE name=?', [name]))
            throw fail(409, '이미 등록된 서버 이름');
          const secret = b.source === 'agent' ? token() : null;
          const r = await db.run(
            'INSERT INTO servers(name,hostname,source,token_hash,created_at) VALUES(?,?,?,?,?)',
            [name, hostname, b.source, secret ? digest(secret) : null, now()],
          );
          await audit(db, user.username, 'server_created', name);
          await broadcast();
          return send(res, 201, { id: Number(r.lastInsertRowid), agentToken: secret });
        }
        /**
         * 경로의 숫자 부분만 정규식으로 추출합니다. 서버 변경은 삭제가 아니라 수집 활성 상태 변경입니다.
         */
        let match = p.match(/^\/api\/servers\/(\d+)$/);
        if (match && method === 'PATCH') {
          requireRole(user, ['admin']);
          const id = idOf(match[1]);
          const b = await body(req);
          if (![0, 1].includes(b.enabled)) throw fail(400, 'enabled는 0 또는 1');
          if (!(await db.get('SELECT id FROM servers WHERE id=?', [id])))
            throw fail(404, '서버 없음');
          await db.run('UPDATE servers SET enabled=? WHERE id=?', [b.enabled, id]);
          await audit(db, user.username, 'server_enabled', `${id}:${b.enabled}`);
          await broadcast();
          return send(res, 200, { ok: true });
        }
        /**
         * GET /api/users: 관리자 전용 계정 목록입니다. 비밀번호 해시나 세션은 목록에 포함하지 않습니다.
         */
        if (p === '/api/users' && method === 'GET') {
          requireRole(user, ['admin']);
          return send(res, 200, await db.all('SELECT id,username,role FROM users'));
        }
        /**
         * POST /api/users: 계정명 중복, 비밀번호 길이, 역할 허용값을 검사한 후 해시를 저장합니다.
         */
        if (p === '/api/users' && method === 'POST') {
          requireRole(user, ['admin']);
          const b = await body(req);
          const name = text(b.username, 80),
            pw = text(b.password, 256);
          if (pw.length < 12 || !['admin', 'operator', 'viewer'].includes(b.role))
            throw fail(400, '비밀번호 또는 역할 오류');
          if (await db.get('SELECT id FROM users WHERE username=?', [name]))
            throw fail(409, '계정 중복');
          const r = await db.run('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)', [
            name,
            hashPassword(pw),
            b.role,
          ]);
          await audit(db, user.username, 'user_created', name);
          return send(res, 201, { id: Number(r.lastInsertRowid) });
        }
        /**
         * PATCH /api/users/:id/role: 관리자만 타인의 역할을 바꿀 수 있습니다.
         * 자신의 역할 변경은 막고, 변경 대상의 모든 세션을 폐기해 기존 권한의 재사용을 방지합니다.
         */
        match = p.match(/^\/api\/users\/(\d+)\/role$/);
        if (match && method === 'PATCH') {
          requireRole(user, ['admin']);
          const id = idOf(match[1]);
          const b = await body(req);
          if (!['admin', 'operator', 'viewer'].includes(b.role)) throw fail(400, '역할 오류');
          if (id === user.id) throw fail(400, '자신의 역할은 변경할 수 없습니다.');
          if (!(await db.get('SELECT id FROM users WHERE id=?', [id])))
            throw fail(404, '사용자 없음');
          await db.run('UPDATE users SET role=? WHERE id=?', [b.role, id]);
          await db.run('DELETE FROM sessions WHERE user_id=?', [id]);
          for (const ws of sockets) if (ws.userId === id) ws.close();
          await audit(db, user.username, 'role_changed', `${id}:${b.role}`);
          return send(res, 200, { ok: true });
        }
        /**
         * GET /api/metrics: 선택한 서버의 최신 120개를 먼저 제한한 뒤 시간순으로 뒤집어 차트에 제공합니다.
         */
        if (p === '/api/metrics' && method === 'GET') {
          const id = idOf(url.searchParams.get('serverId'));
          return send(
            res,
            200,
            (
              await db.all('SELECT * FROM metrics WHERE server_id=? ORDER BY id DESC LIMIT 120', [
                id,
              ])
            ).reverse(),
          );
        }
        /**
         * GET /api/logs: 내용 부분 검색과 선택 레벨 필터를 적용하고 최신 200건을 반환합니다.
         * %, _, !는 LIKE에서 특별한 의미를 갖지 않게 이스케이프하고 검색값은 SQL 매개변수로 전달합니다.
         */
        if (p === '/api/logs' && method === 'GET') {
          const q = (url.searchParams.get('q') || '').slice(0, 200),
            level = url.searchParams.get('level');
          const args = [`%${q.replace(/[!%_]/g, '!$&')}%`];
          let sql =
            "SELECT l.*,s.name AS server_name FROM logs l JOIN servers s ON s.id=l.server_id WHERE l.message LIKE ? ESCAPE '!'";
          if (level) {
            if (!['INFO', 'WARN', 'ERROR'].includes(level)) throw fail(400, '로그 레벨 오류');
            sql += ' AND l.level=?';
            args.push(level);
          }
          return send(res, 200, await db.all(sql + ' ORDER BY l.id DESC LIMIT 200', args));
        }
        /**
         * 장애 경로는 처리 상태 변경, 처리 이벤트 조회, 분석 조회/생성을 한 곳에서 분기합니다.
         * 먼저 장애 존재 여부를 확인하고 쓰기 작업마다 admin/operator 역할을 다시 검사합니다.
         */
        match = p.match(/^\/api\/incidents\/(\d+)(?:\/(analysis|events))?$/);
        if (match) {
          const id = idOf(match[1]);
          const item = await db.get('SELECT * FROM incidents WHERE id=?', [id]);
          if (!item) throw fail(404, '장애 없음');
          if (match[2] === 'events' && method === 'GET')
            return send(
              res,
              200,
              await db.all('SELECT * FROM incident_events WHERE incident_id=? ORDER BY id', [id]),
            );
          if (match[2] === 'analysis' && method === 'GET')
            return send(
              res,
              200,
              await db.all('SELECT * FROM analyses WHERE incident_id=? ORDER BY id DESC LIMIT 10', [
                id,
              ]),
            );
          /**
           * 최근 지표 1건과 로그 5건을 장애 정보와 묶어 RAG에 전달합니다.
           * 성공/대체/보류 모드를 그대로 분석 이력에 저장해 원문 안내를 모델 분석 성공으로 오인하지 않게 합니다.
           */
          if (match[2] === 'analysis' && method === 'POST') {
            requireRole(user, ['admin', 'operator']);
            const latest = await db.get(
              'SELECT * FROM metrics WHERE server_id=? ORDER BY id DESC LIMIT 1',
              [item.server_id],
            );
            const recentLogs = await db.all(
              'SELECT level,message,created_at FROM logs WHERE server_id=? ORDER BY id DESC LIMIT 5',
              [item.server_id],
            );
            const result = await analyze(
              `${item.category} ${item.title} 지표 ${JSON.stringify(latest)} 최근 로그 ${JSON.stringify(recentLogs)}`,
              manuals,
              aiOptions,
            );
            await db.run(
              'INSERT INTO analyses(incident_id,mode,answer,citations,created_at) VALUES(?,?,?,?,?)',
              [id, result.mode, result.answer, JSON.stringify(result.citations), now()],
            );
            await audit(db, user.username, 'incident_analysis', `${id}:${result.mode}`);
            return send(res, 200, result);
          }
          /**
           * open → acknowledged/resolved 또는 acknowledged → resolved만 허용합니다.
           * 기존 상태를 WHERE 조건에 넣어 동시에 도착한 수정의 충돌을 감지합니다.
           * 해결 시 active_key를 null로 해제하므로 같은 분류의 재발은 새 장애로 기록할 수 있습니다.
           */
          if (!match[2] && method === 'PATCH') {
            requireRole(user, ['admin', 'operator']);
            const b = await body(req);
            const transitions = {
              open: ['acknowledged', 'resolved'],
              acknowledged: ['resolved'],
              resolved: [],
            };
            if (!transitions[item.status]?.includes(b.status))
              throw fail(409, '허용되지 않는 상태 전이');
            const note = text(b.note, 2000);
            // 조건부 갱신으로 동시에 도착한 처리 요청 중 하나만 반영합니다.
            const r = await db.run(
              'UPDATE incidents SET status=?,resolved_at=?,resolution=?,active_key=? WHERE id=? AND status=?',
              [
                b.status,
                b.status === 'resolved' ? now() : null,
                note,
                b.status === 'resolved' ? null : item.active_key,
                id,
                item.status,
              ],
            );
            if (!r.changes) throw fail(409, '다른 사용자가 먼저 처리했습니다.');
            await db.run(
              'INSERT INTO incident_events(incident_id,actor,status,note,created_at) VALUES(?,?,?,?,?)',
              [id, user.username, b.status, note, now()],
            );
            await audit(db, user.username, 'incident_updated', `${id}:${b.status}`);
            await broadcast();
            return send(res, 200, { ok: true });
          }
        }
        /**
         * GET /api/manuals: 앱 시작 시 읽어 둔 매뉴얼을 반환합니다. 파일 수정 반영에는 앱 재시작이 필요합니다.
         */
        if (p === '/api/manuals' && method === 'GET') return send(res, 200, manuals);
        /**
         * GET /api/audit: 관리자에게만 최근 감사 기록 200건을 제공합니다.
         */
        if (p === '/api/audit' && method === 'GET') {
          requireRole(user, ['admin']);
          return send(res, 200, await db.all('SELECT * FROM audit ORDER BY id DESC LIMIT 200'));
        }
        /**
         * GET /api/report: 화면의 최신 200건과 달리 전체 DB의 누적 집계를 출처별로 반환합니다.
         * 이 수치는 운영 기록 건수이며 AI 정확도·처리량·응답 속도를 뜻하지 않습니다.
         */
        if (p === '/api/report' && method === 'GET') {
          const incidents = await db.all(
            'SELECT source,status,category,COUNT(*) AS count FROM incidents GROUP BY source,status,category',
          );
          return send(res, 200, {
            title: 'OpsMate 운영 보고서',
            generated_at: now(),
            scope: '현재 DB 누적 집계. source별 실제와 가상 분리. 성능/정확도 지표가 아님.',
            incidents,
            servers: await db.all('SELECT source,COUNT(*) AS count FROM servers GROUP BY source'),
            metrics: await db.all('SELECT source,COUNT(*) AS count FROM metrics GROUP BY source'),
          });
        }
        throw fail(404, 'API 없음');
      }
      if (method !== 'GET' && method !== 'HEAD') throw fail(405, '허용되지 않는 메서드');
      /**
       * 허용한 정적 경로만 파일명으로 대응시킵니다. 임의 URL을 파일 경로로 붙이지 않아 경로 탈출을 막습니다.
       */
      const assets = {
        '/': 'index.html',
        '/app.js': 'app.js',
        '/styles.css': 'styles.css',
        '/theme.css': 'theme.css',
        '/developer.css': 'developer.css',
        '/developer.js': 'developer.js',
      };
      if (!assets[p]) throw fail(404, '파일 없음');
      const file = assets[p],
        data = await readFile(path.join(root, file));
      res.writeHead(200, {
        'Content-Type': file.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'text/html; charset=utf-8',
      });
      res.end(method === 'HEAD' ? undefined : data);
    } catch (e) {
      if (!res.headersSent)
        send(res, e.status || 500, { error: e.status ? e.message : '내부 오류가 발생했습니다.' });
      else res.end();
      if (!e.status) console.error(e);
    }
  });
  /**
   * HTTP 서버의 upgrade 요청을 직접 인증하기 위해 noServer를 사용합니다.
   * 큰 클라이언트 메시지가 들어오지 않도록 최대 프레임 본문을 1KiB로 제한합니다.
   */
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  /**
   * WebSocket도 /ws 경로·Origin·유효 세션을 확인한 뒤 연결합니다.
   * 연결에 사용자 ID와 세션 해시를 붙여 로그아웃/권한 변경/주기 검사에서 종료할 수 있게 합니다.
   */
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (req.url !== '/ws' || !originOK(req)) throw new Error();
      const user = await userFor(req);
      if (!user) throw new Error();
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = user.id;
        ws.sessionHash = digest(cookieToken(req));
        sockets.add(ws);
        ws.on('error', () => ws.terminate());
        ws.on('close', () => sockets.delete(ws));
        ws.send(JSON.stringify({ type: 'connected', at: now() }));
      });
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    }
  });
  const collect = createCollector();
  let tick = 0,
    timer = null,
    stopped = false,
    pending = null;
  /**
   * 활성 서버 수집 → 지표 저장/장애 감지 → 에이전트 60초 신호 검사 → 세션/보존 정리 → 방송 순서입니다.
   * local은 OS 수집기, demo는 가상 생성기만 사용합니다. agent 지표를 서버가 임의로 만들지 않습니다.
   * 이전 사이클 완료 뒤 5초를 기다리므로 OS 조회가 오래 걸리면 실제 샘플 간격은 더 길어집니다.
   * 실패는 기록하고 다음 사이클을 예약하며 pending으로 실행 중인 작업을 종료 시 기다립니다.
   */
  async function cycle() {
    try {
      const targets = await db.all('SELECT * FROM servers WHERE enabled=1');
      for (const target of targets) {
        if (target.source === 'local') await saveSample(db, target, await collect());
        else if (target.source === 'demo' && demo) await saveSample(db, target, demoSample(tick));
      }
      tick++;
      for (const target of targets.filter((s) => s.source === 'agent')) {
        const latest = await db.get(
          'SELECT sampled_at FROM metrics WHERE server_id=? ORDER BY id DESC LIMIT 1',
          [target.id],
        );
        if (Date.now() - Date.parse(latest?.sampled_at || target.created_at) > 60000)
          await openIncident(db, target, {
            category: 'HEARTBEAT',
            severity: 'critical',
            title: '60초 이상 수집 신호 없음',
          });
      }
      for (const ws of sockets) {
        if (
          !(await db.get('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?', [
            ws.sessionHash,
            Date.now(),
          ]))
        )
          ws.close(1008, '세션 만료');
        else ws.ping();
      }
      await db.run('DELETE FROM sessions WHERE expires_at<?', [Date.now()]);
      // 데모 장기 실행의 무한 증가를 막기 위한 7일 보존 정책입니다.
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      await db.run('DELETE FROM metrics WHERE sampled_at<?', [cutoff]);
      await db.run('DELETE FROM logs WHERE created_at<?', [cutoff]);
      for (const [ip, e] of attempts) if (e.until < Date.now()) attempts.delete(ip);
      await broadcast();
    } catch (e) {
      console.error('수집 오류', e.message);
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          pending = cycle();
        }, 5000);
    }
  }
  /**
   * 지정 주소로 HTTP 포트를 열고 background=true일 때만 주기 수집을 시작합니다.
   * 테스트의 port=0은 OS가 빈 포트를 선택하게 하여 기존 실행 앱과 충돌을 피합니다.
   */
  const start = async (
    port = Number(process.env.PORT || 3100),
    host = process.env.HOST || '127.0.0.1',
  ) => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    if (background) pending = cycle();
    return server.address();
  };
  /**
   * 새 타이머 예약을 멈추고 진행 중 수집이 끝난 다음 연결과 DB를 순서대로 닫습니다.
   * DB를 먼저 닫아 실행 중인 수집이 닫힌 DB에 접근하는 문제를 피합니다.
   */
  const close = async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
    for (const ws of sockets) ws.terminate();
    await new Promise((r) => server.close(r));
    await new Promise((r) => wss.close(r));
    await db.close();
  };
  return { server, db, start, close, credentials, snapshot };
}
/**
 * 이 파일을 직접 실행할 때만 앱을 시작합니다. import한 테스트에서는 자동 실행하지 않습니다.
 * 새 계정 비밀번호는 로컬 data/bootstrap.json에만 쓰고, 종료 신호는 close로 정리합니다.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  if (Object.keys(app.credentials).length) {
    await mkdir('data', { recursive: true });
    await writeFile('data/bootstrap.json', JSON.stringify(app.credentials, null, 2), {
      mode: 0o600,
    });
    console.log('초기 계정 정보: data/bootstrap.json (제출/커밋 금지)');
  }
  const address = await app.start();
  console.log(`OpsMate http://${address.address}:${address.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => app.close().then(() => process.exit(0)));
}
