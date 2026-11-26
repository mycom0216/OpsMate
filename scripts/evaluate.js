/** 고정된 소규모 검색 평가입니다. 실제 장애 정확도나 모델 응답 정확도를 뜻하지 않습니다. */
import { loadManuals, bm25, analyze } from '../src/rag.js';
import { mkdir, writeFile } from 'node:fs/promises';
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
const abstain = await analyze('zxqv987654321', docs, { enabled: false });
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
if (result.top1 < 0.8 || !result.unrelated_abstention) process.exitCode = 1;
