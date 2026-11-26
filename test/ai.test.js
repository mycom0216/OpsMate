/**
 * Ollama와 같은 HTTP 형태의 모의 서버로 정상 계약·허위 인용·근거 없는 조치·통신 실패를 검사합니다.
 * 실제 모델을 호출하지 않으므로 이 테스트 통과를 모델 답변의 의미 정확도로 해석하면 안 됩니다.
 * 실제 모델 호출 기록은 scripts/evaluate-live.js가 별도로 남깁니다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { analyze, loadManuals } from '../src/rag.js';
/**
 * OS가 선택한 빈 포트에 모의 Ollama 서버를 띄우고 work에 주소를 전달합니다.
 * 검사 중 오류가 나도 finally에서 서버를 닫아 다음 검사에 연결이 남지 않게 합니다.
 */
async function mock(fn, work) {
  const server = http.createServer(fn);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
test('모의 모델 정상 인용과 임베딩 결합 검색', async () =>
  mock(
    async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const b = JSON.parse(raw);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          req.url === '/api/embed'
            ? { embeddings: b.input.map((_, i) => (i === 0 || i === 1 ? [1, 0] : [0, 1])) }
            : {
                response: JSON.stringify({
                  hypothesis: b.format.properties.hypothesis.enum[0],
                  checks: [b.format.properties.checks.items.enum[0]],
                  actions: [b.format.properties.actions.items.enum[0]],
                  citations: ['cpu'],
                }),
              },
        ),
      );
    },
    async (url) => {
      const r = await analyze('CPU 부하', await loadManuals(), {
        enabled: true,
        url,
        timeout: 1000,
      });
      assert.equal(r.mode, 'ollama');
      assert.equal(r.retrieval, 'BM25+embedding RRF');
      assert(r.citations.some((x) => x.id === 'cpu'));
      assert(r.answer.includes('원인 가설'));
    },
  ));
test('모의 모델 허위 문서 인용은 원문 안내로 대체', async () =>
  mock(
    async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const b = JSON.parse(raw);
      res.end(
        JSON.stringify(
          req.url === '/api/embed'
            ? { embeddings: [] }
            : {
                response: JSON.stringify({
                  hypothesis: b.format.properties.hypothesis.enum[0],
                  checks: [b.format.properties.checks.items.enum[0]],
                  actions: [b.format.properties.actions.items.enum[0]],
                  citations: ['fake'],
                }),
              },
        ),
      );
    },
    async (url) => {
      const r = await analyze('디스크 공간 부족', await loadManuals(), {
        enabled: true,
        url,
        timeout: 1000,
      });
      assert.equal(r.mode, 'source-only');
      assert(r.reason.includes('계약'));
    },
  ));
test('문서 인용이 유효해도 매뉴얼에 없는 대응은 거부', async () =>
  mock(
    async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const b = JSON.parse(raw);
      res.end(
        JSON.stringify(
          req.url === '/api/embed'
            ? { embeddings: [] }
            : {
                response: JSON.stringify({
                  hypothesis: b.format.properties.hypothesis.enum[0],
                  checks: [b.format.properties.checks.items.enum[0]],
                  actions: ['근거 없는 전체 디스크 삭제'],
                  citations: ['disk'],
                }),
              },
        ),
      );
    },
    async (url) => {
      const r = await analyze('DISK 공간 부족', await loadManuals(), {
        enabled: true,
        url,
        timeout: 1000,
      });
      assert.equal(r.mode, 'source-only');
      assert(r.reason.includes('계약'));
    },
  ));
test('Ollama 연결 장애 시 원문 안내, AI 성공으로 표기하지 않음', async () => {
  const r = await analyze('메모리 부족', await loadManuals(), {
    enabled: true,
    url: 'http://127.0.0.1:1',
    timeout: 100,
  });
  assert.equal(r.mode, 'source-only');
  assert(r.reason.includes('사용 불가'));
});
