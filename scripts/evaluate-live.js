/** 로컬에 설치된 실제 모델의 결과를 보존합니다. 계약 통과와 의미 정확도는 별개입니다. */
import { analyze, loadManuals } from '../src/rag.js';
import { writeFile, mkdir } from 'node:fs/promises';
const docs = await loadManuals(),
  results = [];
for (const [query, expected] of [
  ['CPU 사용률 96% 상승 원인과 확인 방법', 'cpu'],
  ['DISK 디스크 공간 97% 부족 대응 방법', 'disk'],
  ['HEARTBEAT 수집 신호 60초 없음', 'network'],
]) {
  const started = performance.now();
  const result = await analyze(query, docs, { enabled: true, timeout: 90000 });
  results.push({
    query,
    expected,
    elapsed_ms: Math.round(performance.now() - started),
    ...result,
    expected_source: result.citations.some((c) => c.id === expected),
  });
  console.log(query, result.mode);
}
const report = {
  evaluated_at: new Date().toISOString(),
  model: process.env.OLLAMA_MODEL || 'kanana2:3b',
  embed_model: process.env.EMBED_MODEL || 'embeddinggemma:latest',
  scope:
    '실제 로컬 Ollama의 3개 질의. 계약 및 기대 문서 포함 여부만 자동 평가. 현업 장애 원인 정확도 검증 아님.',
  model_answers: results.filter((r) => r.mode === 'ollama').length,
  total: results.length,
  results,
};
await mkdir('evidence', { recursive: true });
await writeFile('evidence/ai-live-evaluation.json', JSON.stringify(report, null, 2));
