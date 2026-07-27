// 두 인덱서(build-index / build-search-corpus)가 공유하는 제외 규칙.
// 여기 한 곳만 고치면 두 스크립트에 동시 적용된다 (복붙 드리프트 방지).

export const SKIP_DIRS = new Set([
  'node_modules', '@eaDir', '.trash', '.obsidian', '.git', '.github', 'scripts',
  '.claude', '.omc', '.stfolder', '.SynologyWorkingDirectory', 'Scrievner',
]);

// 자동 생성 산출물 + 동기화 충돌 사본은 인덱스/코퍼스에 넣지 않는다.
// - *_META.md / *_INDEX.json / INDEX.md / SEARCH_CORPUS.json: 인덱서 자신의 산출물 (자기참조 오염 방지)
// - *_Conflict.*: Synology Drive 충돌 사본 (예: 노트명_호스트.local_Jul-05-135508-2026_Conflict.md)
// - *.sync-conflict-*: Syncthing 충돌 사본
const GENERATED_RE = /(_META\.md|_INDEX\.json)$/;
const CONFLICT_RE = /(_Conflict\.[A-Za-z0-9]+|\.sync-conflict-[^.]*\.[A-Za-z0-9]+)$/;
const EXACT_SKIP = new Set(['INDEX.md', 'SEARCH_CORPUS.json']);

export function isSkippedFile(basename) {
  return EXACT_SKIP.has(basename) || GENERATED_RE.test(basename) || CONFLICT_RE.test(basename);
}
