/**
 * 수동 작성한 15개 질의로 BM25 검색 순위를 확인하고 JSON 증빙을 저장합니다.
 * 실제 모델을 호출하지 않는 오프라인 검색 평가이며 현업 장애 원인 정확도와 구분해야 합니다.
 * 실제 모델의 출력 평가는 evaluate-live.js, 통신 계약은 test/ai.test.js에서 확인합니다.
 */
import { loadManuals, bm25, analyze } from '../src/rag.js';
import { mkdir, writeFile } from 'node:fs/promises';
/**
 * 각 항목은 [질의, 기대 매뉴얼 ID]입니다. 소규모 자체 질의라 독립적인 성능 보장은 아닙니다.
 */
const cases = [
  ['CPU 사용률이 높아요', 'cpu'],
  ['CPU 부하 상승', 'cpu'],
  ['프로세스 cpu 과부하', 'cpu'],
  ['메모리 부족 RAM', 'memory'],
  ['메모리 누수 확인', 'memory'],
  ['OOM 캐시 증가', 'memory'],
  ['디스크 공간 부족', 'disk'],
  ['no space left on device', 'disk'],
  ['로그 누적 볼륨 확장', 'disk'],
  ['네트워크 연결 단절', 'network'],
  ['수집 신호 없음', 'network'],
  ['DNS TLS timeout', 'network'],
  ['ERROR 시스템 로그 오류', 'log'],
  ['FATAL 예외 로그', 'log'],
  ['로그 오류 배포 버전', 'log'],
];
const docs = await loadManuals(),
  rows = cases.map(([query, expected]) => {
    const hits = bm25(query, docs);
    return {
      query,
      expected,
      ranked: hits.map((x) => x.id),
      top1: hits[0]?.id === expected,
      recall3: hits.some((x) => x.id === expected),
    };
  });
/**
 * 매뉴얼과 무관한 질의 한 개가 생성 호출 없이 답변 보류로 처리되는지 확인합니다.
 */
const abstain = await analyze('zxqv987654321', docs, { enabled: false });
/**
 * Top1은 첫 문서가 정답인 비율, Recall@3은 상위 3개에 정답이 포함된 비율입니다.
 * model_quality.measured=false는 이 스크립트가 생성 답변의 의미 정확도를 측정하지 않는다는 뜻입니다.
 */
const result = {
  evaluated_at: new Date().toISOString(),
  scope:
    '작성한 매뉴얼 5개와 수동 작성 질의 15개. 학습/운영 데이터 검증 아님. BM25 오프라인 검색 평가.',
  cases: rows,
  top1: rows.filter((x) => x.top1).length / rows.length,
  recall_at_3: rows.filter((x) => x.recall3).length / rows.length,
  unrelated_abstention: abstain.mode === 'abstain',
  model_quality: {
    measured: false,
    reason: '실제 Ollama 모델 응답 품질은 별도 실행 및 사람 검토 필요',
  },
};
await mkdir('evidence', { recursive: true });
await writeFile('evidence/rag-evaluation.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
/**
 * CI 회귀 기준은 Top1 0.8 이상과 무관 질의 보류입니다. 기준 미달은 종료 코드 1로 알립니다.
 */
if (result.top1 < 0.8 || !result.unrelated_abstention) process.exitCode = 1;
