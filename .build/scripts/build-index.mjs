import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { SKIP_DIRS, isSkippedFile } from './common.mjs';

// vault 루트 = 이 스크립트(.build/scripts/) 기준 두 단계 상위. cwd와 무관하게 동작하므로
// 어디서 호출하든(루트 / .build / Actions working-directory) 산출물이 항상 vault 루트로 간다.
const VAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * META_CONFIGS — 폴더는 정규식 패턴으로 매칭.
 *
 * W>P>S>T 트리는 본 시스템의 시그니처지만, 각 prefix 뒤 작명(글쓰기작업/외주_디자이너/...)은
 * 고객마다 다른 변수. 따라서 풀 폴더명 매칭이 아니라 prefix 패턴 매칭.
 *
 * dirsPattern 예시:
 *   /^W\d{2}_/         → W01_*, W02_*, W03_* (어떤 작명이든 매칭)
 *   /^Contents_DB$/    → 완전 일치 (고정 약속)
 *   /^[Ii]nbox$/       → 대소문자 변형 허용
 *
 * 출력은 두 가지:
 *   1) `<NAME>_META.md`  — 사람(Obsidian 그래프 wikilink) + LLM(claude.ai read_index)용 큐레이션 테이블.
 *                          `columns`로 추린 핵심 필드만. 하위호환 유지(절대 깨지면 안 됨).
 *   2) `<NAME>_INDEX.json` — 기계(대시보드/Worker)용 전체 프론트매터 lossless 인덱스.
 *                          고정 컬럼 없음 → 어떤 필드든 생성기 재수정 없이 소비 가능.
 *
 * 두 출력 모두 같은 파이프라인(노트 frontmatter)에서 파생. 원본은 노트.
 */
const META_CONFIGS = [
  {
    output: 'WORKS_META.md',
    json: 'WORKS_INDEX.json',
    dirsPattern: /^W\d{2}_/,
    filter: (fm) => ['프로젝트', '기획', '업무', '실행계획'].includes(fm.종류),
    columns: ['종류', '카테고리', '상태', '상위', '기간_시작', '기간_종료', '작성일', '문서_역할', '대체됨'],
  },
  {
    output: 'CONTENTS_META.md',
    json: 'CONTENTS_INDEX.json',
    dirsPattern: /^Contents_DB$/,
    filter: (fm) => fm.카테고리 !== undefined || fm.장르 !== undefined,
    // ⚠️ 신규 열은 반드시 끝에 append — 워커 parseMetaTable이 위치 기반이라 중간 삽입 시 기존 열 위치가 밀려 깨짐.
    columns: ['카테고리', '장르', '상태', '별점', '감상일', '작성일', '감정', '창작자'],
  },
  {
    output: 'SCRAP_META.md',
    json: 'SCRAP_INDEX.json',
    dirsPattern: /^Scrap_DB$/,
    filter: (fm) => fm.유형 !== undefined,
    columns: ['유형', '분야', '단계', '용도', '생성일', '작성일'],
  },
  {
    // 여행 DB. 종류 = 여행(일정) / 장소(다녀온 곳 카드) / 위시(가보고싶음).
    // 허브 노트(국가·지역·유형 카드)는 frontmatter가 type: 이라 filter에서 자연 제외.
    output: 'TRAVEL_META.md',
    json: 'TRAVEL_INDEX.json',
    dirsPattern: /^Travel_DB$/,
    // 템플릿 폴더는 종류 값이 있어도 실데이터가 아니므로 경로로 제외
    filter: (fm, relPath) => ['여행', '장소', '위시'].includes(fm.종류) && !relPath.includes('Travel_템플릿/'),
    columns: ['종류', '국가', '지역', '분류', '상태', '별점', '기간_시작', '기간_종료', '최근_방문', '작성일'],
  },
  {
    // 노하우(개인 세팅·도구 팁). md는 도구/분야/유형 3축 그룹 형식(render). 허브 노트(유형:도구허브)는 제외.
    output: 'KNOWHOW_META.md',
    json: 'KNOWHOW_INDEX.json',
    dirsPattern: /^Knowhow_DB$/,
    filter: (fm) => fm.유형 !== undefined && fm.유형 !== '도구허브',
    columns: ['도구', '분야', '유형', '작성일'], // JSON 사이드카·하위호환용 (md는 아래 render가 그룹 형식 생성)
    render: ({ rows, matchedDirs, parseFail }) =>
      [
        '# Knowhow DB 메타데이터',
        '',
        '> 자동 생성됨 (인덱서/GitHub Actions). 직접 수정 금지 — 다음 push에 덮어써짐.',
        '> 소소한 개인 세팅·도구 노하우 인덱스. 3축 = 분야 / 유형 / 도구.',
        `> 마지막 업데이트: ${new Date().toISOString()} · 항목 수: ${rows.length}${parseFail ? ` (파싱 실패: ${parseFail})` : ''} · 매칭 폴더: ${matchedDirs.join(', ') || '(없음)'}`,
        '> 약어 사전은 별도 파일 `KNOWHOW_약어.md`에 있다 (스킬 관리 — 인덱서가 건드리지 않음).',
        '',
        '## 도구별 목록',
        groupSection(rows, '도구'),
        '',
        '## 분야별 빠른 참조',
        groupSection(rows, '분야'),
        '',
        '## 유형별 빠른 참조',
        groupSection(rows, '유형'),
        '',
        '---',
        '*이 파일은 .github/workflows/build-index.yml에 의해 자동 생성됩니다.*',
        '',
      ].join('\n'),
  },
  {
    // 건강 DB. 종류 = 데일리(하루 1장 YYMMDD, 운동·인바디·컨디션) / 지식(갱신형) / 깨달음(게시형).
    // 주제 허브·가이드는 frontmatter가 type: 이라 filter에서 자연 제외. 종목 전용 필드(달리기_페이스 등)는
    // 종목×지표 조합이 많아 md 컬럼에 안 싣는다 — JSON 사이드카(무손실)로 소비.
    output: 'HEALTH_META.md',
    json: 'HEALTH_INDEX.json',
    dirsPattern: /^Health_DB$/,
    filter: (fm, relPath) => ['데일리', '지식', '깨달음'].includes(fm.종류) && !relPath.includes('Health_템플릿/'),
    columns: ['종류', '날짜', '운동', '운동시간', '칼로리', '평균심박', '체중', '체지방률', '상태', '작성일'],
  },
  {
    // 소재위키 (W01/P06 — material-wiki 파이프라인이 매일 22시 자동 생성하는
    // 컴파일 레이어). 종류=위키페이지만 등재 — 원본 소재(종류: 소재)와
    // Work_DB 위계(프로젝트/기획/업무)는 WORKS 인덱스 소관, 리포트는 로그라 제외.
    output: 'MATERIAL_WIKI_META.md',
    json: 'MATERIAL_WIKI_INDEX.json',
    dirsPattern: /^W\d{2}_/,
    // 테마 필드가 있는 실 페이지만 — MOC(목차)는 네비게이션이라 제외.
    filter: (fm) => fm.종류 === '위키페이지' && fm.테마 !== undefined,
    columns: ['테마', '태그', '장르', '감정', '소재수', '갱신일', '작성일'],
  },
];

// ---------- schema-ext (.vault/schema-ext.json) — 테넌트 확장 정본 중 인덱서 몫 ----------
// kind_extra: 등재 필터 화이트리스트 확장(커스텀 종류 개방) / meta_columns_extra: META 컬럼 끝-append.
// 파일이 없으면 완전 no-op. 워커 게이트(contracts.ts)와 같은 파일을 읽어 게이트·인덱서 드리프트가 없다.
let SCHEMA_EXT = {};
try {
  SCHEMA_EXT = JSON.parse(await fs.readFile(path.join(VAULT_ROOT, '.vault', 'schema-ext.json'), 'utf-8'));
} catch { /* 없음/파싱 실패 → 확장 없음 */ }
const EXT_FAMILY_BY_OUTPUT = {
  'WORKS_META.md': 'works', 'CONTENTS_META.md': 'contents', 'SCRAP_META.md': 'scrap',
  'TRAVEL_META.md': 'travel', 'KNOWHOW_META.md': 'knowhow', 'HEALTH_META.md': 'health',
};
for (const cfg of META_CONFIGS) {
  const fam = SCHEMA_EXT[EXT_FAMILY_BY_OUTPUT[cfg.output]];
  if (!fam) continue;
  if (Array.isArray(fam.kind_extra) && fam.kind_extra.length) {
    const extra = fam.kind_extra.map(String);
    const baseFilter = cfg.filter;
    // kind계 키(종류/유형/kind) 어느 쪽이든 확장값이면 등재 — KO/EN 로케일 공용. 템플릿 폴더 제외 관용구 유지.
    cfg.filter = (fm, relPath) =>
      baseFilter(fm, relPath) ||
      (extra.includes(String(fm.종류 ?? fm.유형 ?? fm.kind ?? '')) && !String(relPath ?? '').includes('_템플릿/'));
  }
  if (Array.isArray(fam.meta_columns_extra) && fam.meta_columns_extra.length && Array.isArray(cfg.columns)) {
    // ⚠️ 반드시 끝-append — 위치 기반 소비자 하위호환 관용구(중간 삽입 금지).
    cfg.columns = [...cfg.columns, ...fam.meta_columns_extra.map(String)];
  }
}

// 제외 규칙은 common.mjs로 일원화 (build-search-corpus.mjs와 공유).
// 산출물(*_META.md 등)·충돌 사본(*_Conflict.*)은 isSkippedFile이 걸러낸다.

async function walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
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

async function findMatchingDirs(pattern) {
  const entries = await fs.readdir(VAULT_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && pattern.test(e.name))
    .map((e) => e.name)
    .sort();
}

function formatCell(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) return isoDate(value);
  if (Array.isArray(value)) {
    return value.filter((v) => v != null && v !== '').join(', ').replace(/\|/g, '\\|');
  }
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

/** Date → 'YYYY-MM-DD' (시각 정보 손실 OK; 노트 날짜는 day 단위). */
function isoDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * 프론트매터를 JSON 직렬화 가능 형태로 정규화.
 * - Date → 'YYYY-MM-DD' (gray-matter가 YAML date를 Date로 파싱 → ISO보다 day 포맷이 정렬·표시 모두 깔끔)
 * - 배열/원시값은 그대로. 중첩 객체는 재귀.
 */
function normalizeFm(fm) {
  const out = {};
  for (const [k, v] of Object.entries(fm)) {
    out[k] = normalizeValue(v);
  }
  return out;
}

function normalizeValue(v) {
  if (v instanceof Date) return isoDate(v);
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === 'object') return normalizeFm(v);
  return v;
}

/** rows를 frontmatter 필드값으로 묶어 "- {키} (n): [[a]], [[b]]" 줄 생성 (KNOWHOW 그룹 렌더용) */
function groupSection(rows, field) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.fm[field];
    if (key == null || key === '') continue;
    const k = String(key);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.title);
  }
  if (groups.size === 0) return '- (없음)';
  return [...groups.keys()]
    .sort((a, b) => a.localeCompare(b, 'ko'))
    .map((k) => {
      const titles = groups.get(k).sort((a, b) => a.localeCompare(b, 'ko'));
      return `- ${k} (${titles.length}): ${titles.map((t) => `[[${t}]]`).join(', ')}`;
    })
    .join('\n');
}

async function buildMeta(config) {
  const matchedDirs = await findMatchingDirs(config.dirsPattern);
  const allFiles = [];
  for (const dir of matchedDirs) {
    allFiles.push(...(await walk(path.join(VAULT_ROOT, dir))));
  }

  const rows = [];
  let parseFail = 0;
  for (const file of allFiles) {
    let fm;
    try {
      // NFC 정규화 후 파싱 — NFD 레거시 노트의 키·값도 META/INDEX에 NFC로 실린다.
      const raw = (await fs.readFile(file, 'utf-8')).normalize('NFC');
      fm = matter(raw).data;
    } catch {
      parseFail++;
      // 어떤 노트가 깨졌는지 Actions 로그에서 바로 보이게 경로를 남긴다.
      console.warn(`⚠️ frontmatter 파싱 실패: ${path.relative(VAULT_ROOT, file)}`);
      continue;
    }
    const relPath = path.relative(VAULT_ROOT, file).normalize('NFC');
    // filter는 (frontmatter, 상대경로) — 경로 기반 제외(템플릿 폴더 등)가 필요한 DB만 두 번째 인자 사용
    if (!fm || !config.filter(fm, relPath)) continue;
    const title = path.basename(file, '.md').normalize('NFC');
    rows.push({ title, path: relPath, fm });
  }

  rows.sort((a, b) => a.title.localeCompare(b.title, 'ko'));

  // 1) .md 생성: config.render가 있으면 커스텀(그룹) 렌더, 없으면 기본 큐레이션 테이블
  let mdContent;
  if (typeof config.render === 'function') {
    mdContent = config.render({ rows, matchedDirs, parseFail });
  } else {
    const header = `| 제목 | ${config.columns.join(' | ')} |`;
    const sep = `| --- | ${config.columns.map(() => '---').join(' | ')} |`;
    const body = rows.map((r) => {
      const cells = config.columns.map((c) => formatCell(r.fm[c]));
      const safeTitle = String(r.title).replace(/\|/g, '\\|');
      return `| [[${safeTitle}]] | ${cells.join(' | ')} |`;
    });
    mdContent = [
      `# ${config.output.replace('.md', '')}`,
      '',
      `> 자동 생성됨. 직접 수정하지 마세요.`,
      `> 마지막 업데이트: ${new Date().toISOString()}`,
      `> 매칭된 폴더: ${matchedDirs.join(', ') || '(없음)'}`,
      `> 항목 수: ${rows.length}${parseFail ? ` (파싱 실패: ${parseFail})` : ''}`,
      '',
      header,
      sep,
      ...body,
      '',
      '---',
      '*이 파일은 .github/workflows/build-index.yml에 의해 자동 생성됩니다.*',
      '',
    ].join('\n');
  }

  await fs.writeFile(path.join(VAULT_ROOT, config.output), mdContent);

  // 2) 전체 프론트매터 JSON 사이드카 (기계용)
  const jsonDoc = {
    db: config.output.replace('_META.md', ''),
    generated_at: new Date().toISOString(),
    matched_dirs: matchedDirs,
    count: rows.length,
    items: rows.map((r) => ({
      title: r.title,
      path: r.path,
      frontmatter: normalizeFm(r.fm),
    })),
  };

  await fs.writeFile(
    path.join(VAULT_ROOT, config.json),
    JSON.stringify(jsonDoc, null, 2) + '\n',
  );

  console.log(
    `✅ ${config.output} + ${config.json}: ${rows.length} entries (matched dirs: ${matchedDirs.join(', ') || 'none'})${parseFail ? ` (skipped ${parseFail} parse failures)` : ''}`,
  );
}

for (const config of META_CONFIGS) {
  await buildMeta(config);
}
