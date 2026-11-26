/**
 * 설치된 실제 Ollama에 세 질의를 보내 최종 응답 모드·인용·개별 소요 시간을 기록합니다.
 * 실제 모델과 로컬 하드웨어가 필요합니다. 모의 모델 테스트를 실제 모델 성공으로 기록하지 않습니다.
 * 계약 통과는 출력 구조/허용 후보 검사이며 원인이 실제로 맞는지 확인하는 정답률이 아닙니다.
 */
import { analyze, loadManuals } from '../src/rag.js';
import { writeFile, mkdir } from 'node:fs/promises';
const docs = await loadManuals(),
  results = [];
/**
 * 모델을 한 번에 여러 개 호출하지 않고 순서대로 평가해 각 응답과 걸린 시간을 보존합니다.
 * 90초 타임아웃을 주지만 실패하면 analyze의 대체 응답 모드가 그대로 기록됩니다.
 */
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
/**
 * ollama 모드만 model_answers에 포함합니다. source-only 대체 응답을 생성 성공에 합산하지 않습니다.
 */
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
