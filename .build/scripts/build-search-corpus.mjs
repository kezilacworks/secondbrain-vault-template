import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKIP_DIRS, isSkippedFile } from './common.mjs';

// vault 루트 = 이 스크립트(.build/scripts/) 기준 두 단계 상위. cwd와 무관하게 동작하므로
// 어디서 호출하든(루트 / .build / Actions working-directory) 산출물이 항상 vault 루트로 간다.
const VAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * dir 하위 모든 .md 파일 경로를 재귀 수집.
 * - '.'으로 시작하는 숨김 폴더/파일 제외 (SKIP_DIRS와 별도로 일괄 처리)
 * - SKIP_DIRS·isSkippedFile 제외 규칙은 common.mjs에서 build-index.mjs와 공유
 *   (산출물 *_META.md/INDEX.md 자기참조 오염, *_Conflict.* 충돌 사본 방지)
 */
async function walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    // 숨김 항목(. 시작) 전체 제외
    if (entry.name.startsWith('.')) continue;
    // 명시적 제외 폴더
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.name.endsWith('.md') && !isSkippedFile(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

// vault 전체 .md 수집
const allFiles = await walk(VAULT_ROOT);

// 각 파일을 읽어 { path, title, body } 생성
// NFC 정규화: macOS 유래 NFD 파일명·본문이 섞여 있어도 corpus는 NFC 단일 형식.
// 워커 search_vault가 NFC 기준으로 매칭하므로 레거시 NFD 노트도 검색에 걸린다.
const corpus = [];
for (const file of allFiles) {
  let body;
  try {
    body = (await fs.readFile(file, 'utf-8')).normalize('NFC');
  } catch {
    // 읽기 실패 시 건너뜀
    continue;
  }
  // VAULT_ROOT 기준 상대경로, 슬래시 구분 (윈도우 path.sep 대응)
  const relPath = path.relative(VAULT_ROOT, file).split(path.sep).join('/').normalize('NFC');
  const title = path.basename(file, '.md').normalize('NFC');
  corpus.push({ path: relPath, title, body });
}

// 경로 기준 정렬 (안정적 출력)
corpus.sort((a, b) => a.path.localeCompare(b.path));

// compact JSON + 끝 개행
const json = JSON.stringify(corpus) + '\n';

await fs.writeFile(path.join(VAULT_ROOT, 'SEARCH_CORPUS.json'), json);

const byteSize = Buffer.byteLength(json, 'utf-8');
console.log(`SEARCH_CORPUS.json 생성 완료: ${corpus.length}개 항목, ${byteSize.toLocaleString()} bytes`);
