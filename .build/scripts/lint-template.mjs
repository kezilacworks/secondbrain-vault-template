#!/usr/bin/env node
/**
 * lint-template.mjs — 공개 템플릿 repo(secondbrain-vault-template) 오염 재발 방지 게이트 (P0-D / T0.2).
 *
 * 이 스크립트는 템플릿 repo의 `.build/scripts/`에 실려 CI(build-index.yml 선행 잡)에서 돌아간다.
 * **공개 repo에서 실행되므로 실명·개인정보 denylist를 절대 포함하지 않는다.** 그런 검사는
 * SaaS repo 쪽 배포 게이트(`worker/scripts/check-template.sh`)가 비공개로 수행한다.
 *
 * **중요(CI 배선 전제)**: 이 lint 잡은 템플릿 repo 자신에서만 실행되어야 한다 — 템플릿 generate로
 * 만들어진 고객 repo는 `.github/workflows`까지 그대로 복제받으므로, 무조건 실행되면 고객의 정상
 * 실데이터가 매번 rule1을 (승인 목록이 있을 리 없으니) FAIL시켜 고객 index 빌드를 영구히 막는다.
 * 그래서 build-index.yml의 lint 잡에는 `if: github.repository == 'kezilacworks/secondbrain-vault-template'`
 * 조건이 반드시 붙어야 하고(고객 repo에서는 lint가 skip), build 잡은 `needs.lint.result`가
 * success 또는 skipped일 때만 진행하도록 짜야 한다(단순 `needs: lint`만 쓰면 skip된 잡의
 * 하류도 기본적으로 skip되는 GitHub Actions 함정에 걸린다).
 *
 * 4가지 규칙:
 *   1. 개인값 필드 규칙 — frontmatter의 "개인값 필드"(예: 특이사항·메모·URL 등, 대소문자+유니코드
 *      NFC 정규화 후 비교)가 비어있지 않으면 `.build/template-fixtures.json`의 승인 목록
 *      (path+field+value 정확 일치)에 있어야 통과. 매니페스트가 없거나 personal_value_fields가
 *      비어있으면(우회 방지) 내장 기본 필드 목록으로 대체하고, 그 필드들은 전부 공란이어야 한다
 *      (승인 목록이 없으므로 그 무엇도 승인될 수 없음).
 *      **closed-world**: personal_value_fields에도, 알려진 스키마 필드(KNOWN_FRONTMATTER_FIELDS)에도
 *      속하지 않는 완전히 새로운 필드명이 비어있지 않으면 그 자체로 실패(경고가 아님) —
 *      "모르는 필드명을 새로 만들어 개인값을 숨기는" 우회를 차단한다. 빈 새 필드는 경고만.
 *   2. 링크 도메인 allowlist — frontmatter·본문의 모든 http(s) URL 호스트가
 *      `link_domain_allowlist`에 없으면 실패. 매니페스트 부재/공란 시 = 어떤 외부 링크도 불허(최강 기본값).
 *   3. 직군 어휘 denylist — "개발연구"·"바이브코딩" 등 실명이 아닌 일반명사만 하드코딩(공개 안전).
 *   4. 신규 최상위 폴더 감지 시 경고만(비차단). (신규 frontmatter 필드는 규칙1의 closed-world로 승격됨 —
 *      단, 값이 빈 경우는 여전히 경고만.)
 *
 * 값 비교는 YAML 파싱(gray-matter) 후 JSON 정규화 동등성(문자열/숫자/배열 그대로, 순서 무관,
 * 유니코드 NFC 정규화, Date 인스턴스는 YYYY-MM-DD 문자열로 정규화)으로 판정한다 — 따옴표 스타일 차이·
 * 중첩 위치·NFD 분해형 키·대소문자 변형·YAML 미인용 날짜(Date 객체화)로의 우회를 막기 위함.
 *
 * CI 로그 보안: 기본 출력에는 유출 의심 "값" 원문을 찍지 않는다(경로+필드명+값 길이만).
 * 원문이 필요한 로컬 디버깅은 `--verbose`로만 — CI에서 절대 켜지 않는다.
 *
 * 사용법:
 *   node lint-template.mjs                 # 이 스크립트 위치 기준(.build/scripts/../..)을 vault 루트로 검사
 *   node lint-template.mjs --root <경로>    # 임의 경로를 vault 루트로 검사 (게이트2 등 외부 호출용)
 *   node lint-template.mjs --verbose        # 위반 값 원문을 그대로 출력 (로컬 전용, CI 금지)
 *   node lint-template.mjs --self-test      # 내장 위반/정상 케이스로 자체 검증 (exit 0 = 전부 기대대로 검출)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { SKIP_DIRS, isSkippedFile } from './common.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// build-index.mjs와 동일한 관례: 스크립트 위치 기준 두 단계 상위 = vault 루트. cwd와 무관.
const DEFAULT_VAULT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

// ---------------------------------------------------------------------------
// 규칙 1 — 개인값 필드 기본 목록 (매니페스트 부재/공란 시 대체용, fail-safe).
// 필드 "이름"만 나열 — 실제 개인 값이 아니므로 공개해도 안전.
// ---------------------------------------------------------------------------
const DEFAULT_PERSONAL_VALUE_FIELDS = [
  'remarks', 'memo', 'summary', 'link', 'URL', 'source',
  'rating', 'watched_date', 'last_watched', 'keywords',
  'author', 'cast', 'creator', 'title',
  'topic', // MEDIUM-D: Health_지식 노트의 자유 서술 주제명 — enum이 아니라 자유 텍스트
];

// ---------------------------------------------------------------------------
// 규칙 3 — 직군 어휘 denylist (일반명사, 실명 아님 — 공개 안전). 소량 하드코딩.
// ---------------------------------------------------------------------------
const JOB_NEUTRALITY_DENYLIST = ['개발연구', '바이브코딩', 'W03_개발연구'];

// 허브 파일 자기참조 예외: 파일명 자체가 denylist 용어인 분류 허브 노트.
// 2026-07-31 EN 전환: 값-허브 개명으로 이 허브는 vibe_coding.md가 되어 자기참조가 사라졌다
// (경로·본문 어디에도 denylist 용어가 없어 위반 자체가 안 난다). 항목을 지우지 않고 남기는 건
// KO 트리·되돌림 트리를 --root로 검사할 때 여전히 필요하기 때문이다 — 남겨도 오탐은 없다.
const DENYLIST_SELF_EXEMPT = [
  { path: 'Scrap_DB/Scrap_용도/바이브코딩.md', term: '바이브코딩' },
];

// ---------------------------------------------------------------------------
// 규칙 4 — 최상위 폴더 경고 베이스라인 (비차단).
// ---------------------------------------------------------------------------
const KNOWN_TOP_LEVEL = new Set([
  'Contents_DB', 'Health_DB', 'People_DB', 'Scrap_DB', 'Inbox',
  '.build', '.github', '.gitignore', '.git',
  'README.md',
  'CONTENTS_META.md', 'CONTENTS_INDEX.json',
  'HEALTH_META.md', 'HEALTH_INDEX.json',
  'KNOWHOW_META.md', 'KNOWHOW_INDEX.json',
  'MATERIAL_WIKI_META.md', 'MATERIAL_WIKI_INDEX.json',
  'SCRAP_META.md', 'SCRAP_INDEX.json',
  'TRAVEL_META.md', 'TRAVEL_INDEX.json',
  'WORKS_META.md', 'WORKS_INDEX.json',
  'SEARCH_CORPUS.json', 'INDEX.md',
]);
const WORKSPACE_DIR_RE = /^W\d{2}_/;

// 규칙1 closed-world의 "알려진 비-개인값 스키마 필드" 목록 — 현재 정화된 템플릿(cleaned-template)
// 전체 소스 .md에서 실측 추출(2026-07-28). personal_value_fields(매니페스트)와 ENUM_FIELDS·
// PATTERN_FIELDS(아래)의 합집합이 "인식되는 필드" 전체이고, 그 밖의 필드는 값이 비어있지 않으면
// 즉시 실패(경고 아님) — 새 필드명을 만들어 개인값을 숨기는 우회를 차단한다. 스키마가 실제로
// 확장되면 이 배열도 같은 PR에서 함께 늘려야 한다.
//
// MEDIUM-D: enum 값이 고정된 필드(category·kind·genre·emotions·domain·stage·purpose·level·
// doc_role·status)와 위키링크 패턴 필드(parent)는 여기서 제외하고 아래 ENUM_FIELDS/PATTERN_FIELDS로
// 옮겼다 — "알려진 필드니까 무조건 통과"라는 프리패스가, enum 필드에 자유 서술 개인값을 숨기는
// 통로였다(리뷰어 재현: status 필드에 실제 투병 이력을 서술한 자유 텍스트를 넣은 사례가 이전에는
// 무검증 통과). topic은 자유 텍스트라 personal_value_fields로 이동.
// (주: 이 파일 자체가 공개 템플릿 repo에 실리고 게이트2가 .build까지 스캔하므로, 아래 셀프테스트
// 픽스처에는 실제 민감 키워드 원문을 절대 쓰지 않는다 — 이전 라운드에도 한 번 겪은 자기참조 오탐 함정.)
//
// 2026-07-31 EN 스키마 2차 전환(트랙 A-4 "전부 영어화"): 계약 키뿐 아니라 자유 필드도 전부 EN이다.
// 이름의 정본은 계획 20260731의 확장 명명표이고, 변환기 쪽 짝은 convert-vault-en.mjs의
// COMMON_KEYS·FAMILY_KEYS다. 한쪽만 고치면 vault 실물과 이 게이트가 어긋난다.
const KNOWN_FRONTMATTER_FIELDS = new Set([
  'BMI', 'type', 'created', 'updated', 'first_created',
  // Contents (release_day는 닫힌 7값이라 아래 ENUM_FIELDS로 옮겼다)
  'platform', 'season_volume', 'total_length', 'progress',
  // Works
  'start_date', 'end_date', 'write_done', 'superseded', 'total_projects', 'total_tasks', 'total_plans',
  // Health 계측 필드군
  'date', 'weight', 'muscle_mass', 'body_fat_pct', 'body_fat_mass', 'bmr',
  'inbody_score', 'sleep_hours', 'water',
]);

// MEDIUM-D: enum 필드 — 값 집합은 worker/src/taxonomy-en.ts의 계약 enum(CONTENTS_CATEGORY_ENUM·
// WORKS_KIND_ENUM·HEALTH_KIND_ENUM·TRAVEL_KIND_ENUM 등) + 템플릿 분류 허브 폴더명(Contents_장르·
// Contents_감정·Scrap_분야·Scrap_단계·Scrap_용도) + 템플릿 실측값(레벨·문서_역할 등)에서
// 도출했다(2026-07-31, EN 전환 기준).
//
// 2026-07-31 EN 스키마 전환:
//  - 계약 키를 EN명으로 옮겼다 — 카테고리→category, 장르→genre, 상태→status, 상위→parent.
//  - **종류·유형은 EN 계약에서 kind 하나로 합쳐진다**(convert-vault-en.mjs의 KIND_SOURCE). 그래서
//    두 목록도 kind 하나로 합쳤고, 값 집합은 DB별 kind 어휘의 합집합이다(place는 Health·Travel
//    양쪽에 있어 한 번만 등장). 여기서 DB를 구분하지 않는 이유는 status와 같다 — 이 게이트의 목적은
//    "enum 필드에 자유 서술을 숨기는 것"의 차단이지 DB별 정합성 판정이 아니다(그건 워커 L1 몫).
//  - genre는 두 계약이 같은 키를 다른 뜻으로 쓴다: Contents=작품 장르(열린 표현형), Travel=장소
//    성격(닫힌 4+1값, TRAVEL_GENRE_VALUES). 이 게이트는 필드명 전역 검사라 둘의 합집합을 싣는다.
//    Contents 장르 값은 원래 "사용자 언어 영역"이라 계약이 강제하지 않지만, **템플릿은 영어
//    사용자에게 주는 씨드**라 2차 패스에서 허브 노트와 함께 자연 영어로 갈았다(W2).
// `{...}` 형태 값은 템플릿 플레이스홀더 관례이므로 모든 enum 필드에서 통과시킨다.
const PLACEHOLDER_VALUE_RE = /^\{.+\}$/;

const ENUM_FIELDS = {
  category: ['film', 'series', 'animation', 'comic', 'book', 'webtoon', 'documentary', 'variety'],
  kind: [
    // WORKS (taxonomy-en WORKS_KIND_ENUM)
    'project', 'plan', 'task', 'action_plan', 'workspace', 'person', 'posting', 'wikipage',
    // HEALTH / TRAVEL (HEALTH_KIND_ENUM · TRAVEL_KIND_ENUM — place 공유)
    'daily', 'knowledge', 'insight', 'place', 'trip', 'wish', 'prep_base', 'travel_knowhow',
    // SCRAP (전환 전부터 EN)
    'article', 'tool', 'webpage', 'webtoon', 'resource', 'platform', 'instagram',
    // KNOWHOW. abbreviation_dictionary는 루트 KNOWHOW_약어.md 전용 — 계약 밖(resolveContract가
    // 루트 파일에 null을 주므로 워커 L1이 보지 않는다) 템플릿 로컬 값이라 lint에만 등재한다.
    'shortcut', 'config', 'technique', 'troubleshooting', 'toolhub', 'abbreviation_dictionary',
  ],
  genre: [
    // Contents — 작품 장르(허브 Contents_장르/와 1:1). SF는 영어권에서도 통용돼 원형 유지.
    'healing slice of life', 'black comedy', 'romantic comedy', 'romance', 'fantasy', 'drama',
    'coming of age', 'school', 'period drama', 'action', 'picaresque', 'disaster',
    'slice of life', 'comedy', 'horror', 'SF', 'thriller', 'adventure',
    // Travel — 장소 성격(vault-value-maps TRAVEL_GENRE_VALUES). 같은 키, 다른 값 집합.
    'restaurant', 'cafe', 'attraction', 'shopping', 'activity',
  ],
  emotions: [
    'overwhelmed', 'joy', 'intrigue', 'awe', 'neutral', 'daze', 'anger', 'tenderness', 'skepticism',
    'resolve', 'happiness', 'absurdity', 'conflicted', 'burnout', 'gloom', 'flutter', 'ease', 'tension',
  ],
  // Scrap 7+2 ∪ Knowhow 4 — 같은 domain 키인데 DB마다 값 집합이 다르다(vault-value-maps의
  // SCRAP_DOMAIN_VALUES / KNOWHOW_DOMAIN_VALUES). 필드명 전역 검사라 합집합을 싣는다.
  // design-aesthetics는 `{domain}-{theme}` 테마 허브 표기의 실측 사례다(하이픈 보존).
  domain: [
    'design', 'marketing', 'development', 'education', 'technology', 'culture', 'insight',
    'sports', 'design-aesthetics',
    'design_video', 'it_dev', 'system_env', 'daily_life',
  ],
  stage: ['aware', 'studying', 'studied', 'reference'],
  // 연재요일 — 요일은 본래 닫힌 7값이라 자유 텍스트로 둘 이유가 없다(2026-07-31 판정으로 명명표 등재).
  // 짝은 vault-value-maps.mjs의 RELEASE_DAY_VALUES.
  release_day: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  purpose: ['design_work', 'vibe_coding', 'video_work', 'writing_work', 'daily_work', 'tool'],
  level: [1, 2, 3, 4],
  doc_role: ['canonical', 'record', 'pending'],
  condition: ['good', 'fair', 'poor'],
  // 정본 = worker/src/contracts.ts EN_STATUS_VOCAB의 DB별 어휘 전체 합집합. 필드가 DB마다 다른
  // 의미로 재사용되므로 DB 구분 없이 전역 합집합으로 검사한다(narrative 텍스트 차단이 목적이라
  // 이 정도 느슨함은 무해). EN_STATUS_VOCAB이 바뀌면 이 배열도 같은 PR에서 함께 고쳐야 한다.
  //   WORKS    active·done·hold·planned·ready·following_up
  //   PEOPLE   active·dormant·closed
  //   CONTENTS done·watching·planned·hold
  //   TRAVEL   planned·visited·want_revisit·wishlist·done·cancelled
  //   HEALTH   published·active·done·learning·draft·in_review·wishlist
  status: [
    'active', 'done', 'hold', 'planned', 'ready', 'following_up',
    'dormant', 'closed', 'watching',
    'visited', 'want_revisit', 'wishlist', 'cancelled',
    'published', 'learning', 'draft', 'in_review',
  ],
};

const PATTERN_FIELDS = {
  parent: /^\[\[.+\]\]$/,
};

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

// ---------------------------------------------------------------------------
// .build/.github 사각지대 해소 (HIGH-4): 이 두 디렉토리는 dot-prefix라도 걸어 들어간다.
// 단, package-lock.json은 npm 레지스트리 URL을 정상적으로 포함하므로 스캔에서 제외.
// (node_modules·scripts 등은 기존 SKIP_DIRS가 이 두 디렉토리 안에서도 그대로 걸러낸다.)
// ---------------------------------------------------------------------------
const SCANNED_DOT_DIRS = new Set(['.build', '.github']);
const ALWAYS_EXCLUDE_FILENAMES = new Set(['package-lock.json']);

// ---------------------------------------------------------------------------
// 유틸: 유니코드 정규화 + 값 비교 (NFD 분해형 키/값, 대소문자 변형 우회 방지)
// ---------------------------------------------------------------------------
function foldKey(k) {
  return String(k).normalize('NFC').toLowerCase();
}

function toNFC(v) {
  if (typeof v === 'string') return v.normalize('NFC');
  if (v instanceof Date) return isoDateOnly(v);
  if (Array.isArray(v)) return v.map(toNFC);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k.normalize('NFC')] = toNFC(val);
    return out;
  }
  return v;
}

function isoDateOnly(d) {
  // Date-only YAML 타임스탬프(예: 2025-11-02)는 gray-matter/js-yaml이 UTC 자정으로 파싱하므로
  // toISOString().slice(0,10)이 원래 문자열과 동일하게 돌아온다.
  return d.toISOString().slice(0, 10);
}

/** 순서 무관 깊은 동등성 (양쪽 다 NFC 정규화 후 비교). */
function deepEqual(a, b) {
  const na = toNFC(a);
  const nb = toNFC(b);
  if (Array.isArray(na) && Array.isArray(nb)) {
    if (na.length !== nb.length) return false;
    return na.every((v, i) => deepEqual(v, nb[i]));
  }
  if (na && nb && typeof na === 'object' && typeof nb === 'object') {
    const ak = Object.keys(na);
    const bk = Object.keys(nb);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(nb, k) && deepEqual(na[k], nb[k]));
  }
  return na === nb;
}

/**
 * CRITICAL-2 수정: Date 인스턴스는 own-enumerable 프로퍼티가 없어 예전 코드에서
 * `typeof v === 'object'` 분기를 타 "빈 값"으로 오판했다 — YAML에서 따옴표 없이 쓴 날짜
 * (예: `감상일: 2024-10-04`)가 통째로 검증을 피해가는 구멍이었다. Date는 항상 비공란으로 취급.
 */
function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (v instanceof Date) return false;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmptyValue);
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// ---------------------------------------------------------------------------
// 매니페스트 로딩 (.build/template-fixtures.json)
// ---------------------------------------------------------------------------
function finalizeManifest(json, present) {
  // 부재 시도, 존재하지만 공란 배열이어도 fail-safe 기본값으로 대체(빈 배열로 게이트를 무력화하는
  // 우회를 막기 위해 "존재하되 비어있음"도 "부재"와 동일하게 취급한다).
  const personalFieldsRaw = Array.isArray(json.personal_value_fields) ? json.personal_value_fields : [];
  const personal_value_fields = personalFieldsRaw.length > 0
    ? personalFieldsRaw.map((f) => String(f).normalize('NFC'))
    : DEFAULT_PERSONAL_VALUE_FIELDS;
  const fellBackPersonalFields = personalFieldsRaw.length === 0;

  // 대소문자+NFC 폴딩 조회 맵 — 'URL'/'url'/'Url'을 같은 필드로 인식(CRITICAL-4).
  const personalFoldMap = new Map();
  for (const f of personal_value_fields) personalFoldMap.set(foldKey(f), f);

  const link_domain_allowlist = Array.isArray(json.link_domain_allowlist)
    ? json.link_domain_allowlist.map((d) => String(d).toLowerCase())
    : [];

  const approved = Array.isArray(json.approved) ? json.approved : [];

  return {
    present,
    fellBackPersonalFields,
    personal_value_fields,
    personalFoldMap,
    link_domain_allowlist,
    approved,
  };
}

function loadManifest(manifestPath) {
  let raw = null;
  let present = false;
  if (fs.existsSync(manifestPath)) {
    present = true;
    raw = fs.readFileSync(manifestPath, 'utf-8');
  }

  let json = {};
  if (present) {
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new Error(`template-fixtures.json 파싱 실패: ${e.message}`);
    }
  }

  return finalizeManifest(json, present);
}

function findApproval(approved, relPath, field, value) {
  return approved.some((a) => a && a.path === relPath && a.field === field && deepEqual(a.value, value));
}

const KNOWN_FRONTMATTER_FIELDS_FOLDED = new Set([...KNOWN_FRONTMATTER_FIELDS].map(foldKey));

// MEDIUM-D: enum/pattern 필드도 키 비교는 NFC+소문자 폴딩(대소문자 변형 우회 방지, CRITICAL-4와 동일 원칙).
const ENUM_FIELDS_FOLDED = new Map(
  Object.entries(ENUM_FIELDS).map(([name, allowed]) => [foldKey(name), { name, allowed }]),
);
const PATTERN_FIELDS_FOLDED = new Map(
  Object.entries(PATTERN_FIELDS).map(([name, pattern]) => [foldKey(name), { name, pattern }]),
);

function foldForCompare(v) {
  if (typeof v === 'string') return v.normalize('NFC').toLowerCase();
  return v;
}

/** enum 필드 값 검사 — 배열이면 원소 전부가 허용값(또는 `{...}` 플레이스홀더)이어야 통과. */
function valueMatchesEnum(value, allowed) {
  const items = Array.isArray(value) ? value : [value];
  return items.every((item) => {
    if (typeof item === 'string' && PLACEHOLDER_VALUE_RE.test(item)) return true;
    const folded = foldForCompare(item);
    return allowed.some((a) => foldForCompare(a) === folded);
  });
}

/** 패턴 필드 값 검사 — 배열이면 원소 전부가 패턴에 맞아야(또는 플레이스홀더) 통과. */
function valueMatchesPattern(value, pattern) {
  const items = Array.isArray(value) ? value : [value];
  return items.every((item) => {
    if (typeof item !== 'string') return false;
    if (PLACEHOLDER_VALUE_RE.test(item)) return true;
    return pattern.test(item);
  });
}

// ---------------------------------------------------------------------------
// 규칙 1: 개인값 필드 + closed-world 미지 필드 (중첩 위치 무관 — 재귀 탐색으로
// "새 부모 키 아래 숨기기" 우회 차단). 키 비교는 NFC+소문자 폴딩(CRITICAL-4).
// ---------------------------------------------------------------------------
function classifyFrontmatterFields(data, manifest, keyPathPrefix = []) {
  const personal = [];
  const closedWorldViolations = [];
  const enumViolations = [];
  const newFieldWarnings = [];

  function walk(node, prefix) {
    if (node === null || typeof node !== 'object') return;
    const isArr = Array.isArray(node);
    const entries = isArr ? node.map((v, i) => [i, v]) : Object.entries(node);
    for (const [rawKey, value] of entries) {
      if (!isArr) {
        const folded = foldKey(rawKey);
        const canonical = manifest.personalFoldMap.get(folded);
        const enumDef = ENUM_FIELDS_FOLDED.get(folded);
        const patternDef = PATTERN_FIELDS_FOLDED.get(folded);
        if (canonical) {
          personal.push({ field: canonical, value, keyPath: [...prefix, canonical] });
        } else if (enumDef) {
          // MEDIUM-D: enum 고정 필드 — 값이 비어있으면 통과(문제 없음), 비어있는데 허용값
          // 밖이면 즉시 실패(자유 서술 개인값을 enum 필드에 숨기는 우회 차단). 승인 목록으로도
          // 우회 불가 — enum 위반은 "가공 샘플이라 봐준다"가 성립하지 않는 구조적 오류이므로.
          if (!isEmptyValue(value) && !valueMatchesEnum(value, enumDef.allowed)) {
            enumViolations.push({ field: enumDef.name, value, keyPath: [...prefix, enumDef.name] });
          }
        } else if (patternDef) {
          if (!isEmptyValue(value) && !valueMatchesPattern(value, patternDef.pattern)) {
            enumViolations.push({ field: patternDef.name, value, keyPath: [...prefix, patternDef.name] });
          }
        } else if (!KNOWN_FRONTMATTER_FIELDS_FOLDED.has(folded)) {
          const keyPath = [...prefix, String(rawKey)];
          if (!isEmptyValue(value)) {
            // closed-world 위반: 알려진 필드도 개인값 필드도 아닌데 비어있지 않음 — 즉시 실패.
            closedWorldViolations.push({ field: String(rawKey), value, keyPath });
          } else {
            newFieldWarnings.push({ field: String(rawKey), keyPath });
          }
        }
      }
      if (value && typeof value === 'object') {
        walk(value, [...prefix, String(rawKey)]);
      }
    }
  }

  walk(data, keyPathPrefix);
  return { personal, closedWorldViolations, enumViolations, newFieldWarnings };
}

function checkPersonalValueFields(files, manifest) {
  const violations = [];
  const newFieldWarnings = [];
  const seenWarn = new Set();
  let checkedFields = 0;

  for (const file of files) {
    let data;
    try {
      data = matter(file.raw).data;
    } catch (e) {
      // fail-closed: 깨진/비정상 YAML은 검증 불가 상태이므로 "통과"가 아니라 위반으로 취급한다.
      // (조용히 건너뛰면 일부러 망가뜨린 frontmatter로 개인값을 숨기는 우회가 된다.)
      violations.push({
        rule: 'frontmatter-parse-error',
        path: file.relPath,
        errorMessage: e.message,
      });
      continue;
    }
    if (!data || typeof data !== 'object') continue;

    const { personal, closedWorldViolations, enumViolations, newFieldWarnings: nf } = classifyFrontmatterFields(data, manifest);

    for (const occ of personal) {
      if (isEmptyValue(occ.value)) continue;
      checkedFields++;
      if (!findApproval(manifest.approved, file.relPath, occ.field, occ.value)) {
        violations.push({
          rule: 'personal-value-field',
          path: file.relPath,
          field: occ.field,
          keyPath: occ.keyPath.join('.'),
          value: occ.value,
        });
      }
    }

    for (const cwv of closedWorldViolations) {
      violations.push({
        rule: 'closed-world-unknown-field',
        path: file.relPath,
        field: cwv.field,
        keyPath: cwv.keyPath.join('.'),
        value: cwv.value,
      });
    }

    for (const ev of enumViolations) {
      violations.push({
        rule: 'enum-mismatch',
        path: file.relPath,
        field: ev.field,
        keyPath: ev.keyPath.join('.'),
        value: ev.value,
      });
    }

    for (const nfw of nf) {
      const flag = `${file.relPath}::${nfw.keyPath.join('.')}`;
      if (seenWarn.has(flag)) continue;
      seenWarn.add(flag);
      newFieldWarnings.push(`신규 frontmatter 필드 감지(비차단, 값 공란): ${file.relPath} -> '${nfw.keyPath.join('.')}'`);
    }
  }

  return { violations, checkedFields, newFieldWarnings };
}

// ---------------------------------------------------------------------------
// 규칙 2: 링크 도메인 allowlist
//
// frontmatter/본문을 구분하지 않고 파일 원문 전체(raw)에서 바로 URL을 정규식으로 뽑는다.
// gray-matter YAML 파싱에 의존하지 않으므로 (a) frontmatter가 깨졌거나 없는 파일도 검사되고
// (b) .md가 아닌 파일에도 동일하게 적용할 수 있다 — "비md 파일에 숨기기" 우회 차단.
// ---------------------------------------------------------------------------
function isHostAllowed(host, allowlist) {
  return allowlist.some((d) => host === d || host.endsWith(`.${d}`));
}

function checkLinkDomains(files, manifest) {
  const violations = [];
  let checkedUrls = 0;
  for (const file of files) {
    const urls = [...file.raw.matchAll(URL_RE)].map((m) => m[0]);
    for (const url of urls) {
      checkedUrls++;
      let host;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        violations.push({ rule: 'link-parse-error', path: file.relPath, url });
        continue;
      }
      if (!isHostAllowed(host, manifest.link_domain_allowlist)) {
        violations.push({ rule: 'link-domain', path: file.relPath, url, host });
      }
    }
  }
  return { violations, checkedUrls };
}

// ---------------------------------------------------------------------------
// 규칙 3: 직군 어휘 denylist (경로 + 원문 전체를 그대로 substring 검색 —
// YAML 파싱을 거치지 않으므로 따옴표/중첩 구조와 무관하게 항상 검출됨).
// 파일당 용어당 위반은 최대 1건으로 합친다(경로/본문 둘 다 걸려도 중복 집계하지 않음).
// ---------------------------------------------------------------------------
function checkDenylist(files) {
  const violations = [];
  for (const file of files) {
    const relPathNFC = file.relPath.normalize('NFC');
    const rawNFC = file.raw.normalize('NFC');
    for (const term of JOB_NEUTRALITY_DENYLIST) {
      const exempt = DENYLIST_SELF_EXEMPT.some((e) => e.term === term && e.path === relPathNFC);
      if (exempt) continue;
      const hitPath = relPathNFC.includes(term);
      const hitContent = rawNFC.includes(term);
      if (!hitPath && !hitContent) continue;
      const locations = [];
      if (hitPath) locations.push('경로');
      if (hitContent) locations.push('본문/frontmatter');
      violations.push({ rule: 'job-denylist', path: file.relPath, term, locations });
    }
  }
  return { violations };
}

// ---------------------------------------------------------------------------
// 규칙 4: 신규 최상위 폴더 경고 (비차단). 신규 frontmatter 필드는 규칙1의
// closed-world로 승격되었으므로(값이 비어있으면 여전히 경고, 위는 checkPersonalValueFields 참고).
// ---------------------------------------------------------------------------
function checkNewTopLevel(rootEntries) {
  const warnings = [];
  for (const entry of rootEntries) {
    if (KNOWN_TOP_LEVEL.has(entry)) continue;
    if (WORKSPACE_DIR_RE.test(entry)) continue;
    warnings.push(`신규 최상위 항목 감지(비차단): ${entry}`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// 디스크 워킹 (build-index.mjs와 동일한 스킵 규칙 재사용 + HIGH-4 .build/.github 선별 스캔)
// ---------------------------------------------------------------------------
function shouldSkipDirEntry(name) {
  // SCANNED_DOT_DIRS는 무조건 스캔 — common.mjs의 SKIP_DIRS가 '.github'를 이름 그대로
  // 포함하고 있어(원래 build-index.mjs 용도), 아래 일반 규칙까지 내려가면 다시 걸러진다.
  // 그래서 이 예외를 SKIP_DIRS 검사보다 먼저, 그리고 그 검사와 무관하게 처리한다.
  if (SCANNED_DOT_DIRS.has(name)) return false;
  if (name.startsWith('.')) return true;
  if (SKIP_DIRS.has(name)) return true;
  return false;
}

function walkSourceFiles(root) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDirEntry(entry.name)) continue;
        walk(full);
        continue;
      }
      if (ALWAYS_EXCLUDE_FILENAMES.has(entry.name)) continue;
      if (entry.name.endsWith('.md') && !isSkippedFile(entry.name)) {
        // LOW: 디렉토리를 가리키는 심볼릭 링크는 dirent.isDirectory()가 false를 반환해
        // "파일"로 오분류되고, readFileSync가 EISDIR로 프로세스 전체를 죽였다 — 개별 스킵으로 방어.
        let raw;
        try {
          raw = fs.readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        raw = raw.normalize('NFC');
        const relPath = path.relative(root, full).split(path.sep).join('/').normalize('NFC');
        results.push({ relPath, raw });
      }
    }
  }
  walk(root);
  return results;
}

function listRootEntries(root) {
  return fs.readdirSync(root, { withFileTypes: true }).map((e) => e.name);
}

// 링크/직군어휘 검사(규칙2·3)는 frontmatter 유무와 무관하게 전 파일 대상 —
// .md 파일에만 숨기지 않고 다른 확장자 파일에 옮겨 심는 우회를 막기 위함.
// 텍스트로 읽을 수 없는 바이너리류만 확장자로 제외(오탐/낭비 방지 — 안전장치일 뿐, 보안 경계 아님).
const BINARY_EXT_SKIP = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.svg',
]);

function walkAllTextFiles(root) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDirEntry(entry.name)) continue;
        walk(full);
        continue;
      }
      if (isSkippedFile(entry.name)) continue;
      if (ALWAYS_EXCLUDE_FILENAMES.has(entry.name)) continue;
      if (BINARY_EXT_SKIP.has(path.extname(entry.name).toLowerCase())) continue;
      let raw;
      try {
        raw = fs.readFileSync(full, 'utf-8');
      } catch {
        continue;
      }
      raw = raw.normalize('NFC');
      const relPath = path.relative(root, full).split(path.sep).join('/').normalize('NFC');
      results.push({ relPath, raw });
    }
  }
  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// 실행 + 리포트
// ---------------------------------------------------------------------------
function runLint(root) {
  const manifestPath = path.join(root, '.build', 'template-fixtures.json');
  const manifest = loadManifest(manifestPath);
  const mdFiles = walkSourceFiles(root);
  const allFiles = walkAllTextFiles(root);
  const rootEntries = listRootEntries(root);

  const r1 = checkPersonalValueFields(mdFiles, manifest);
  const r2 = checkLinkDomains(allFiles, manifest);
  const r3 = checkDenylist(allFiles);
  const warnings = [...checkNewTopLevel(rootEntries), ...r1.newFieldWarnings];

  return { manifest, manifestPath, fileCount: mdFiles.length, allFileCount: allFiles.length, r1, r2, r3, warnings };
}

// HIGH-2: 기본 출력은 유출 의심 값 원문을 찍지 않는다 — 경로·필드명·값 길이만. --verbose는 로컬 전용.
function formatValueForReport(value, verbose) {
  if (verbose) return JSON.stringify(value);
  const len = JSON.stringify(value).length;
  return `(값 비공개 — ${len}자, --verbose로 로컬에서만 확인)`;
}

function formatUrlForReport(url, verbose) {
  if (verbose) return url;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/... (경로 생략, --verbose로 전체 확인)`;
  } catch {
    return '(URL 원문 비공개, --verbose로 확인)';
  }
}

function formatViolationMessage(v, verbose) {
  switch (v.rule) {
    case 'frontmatter-parse-error':
      return `${v.path}: frontmatter YAML 파싱 실패 — 검증 불가 상태로 차단${verbose ? ` (${v.errorMessage})` : ' (사유는 --verbose)'}`;
    case 'personal-value-field':
      return `${v.path}: 개인값 필드 '${v.keyPath}' 값이 비어있지 않고 승인 목록에 없음 -> ${formatValueForReport(v.value, verbose)}`;
    case 'closed-world-unknown-field':
      return `${v.path}: 알려지지 않은 필드 '${v.keyPath}'가 비어있지 않음(closed-world 위반) -> ${formatValueForReport(v.value, verbose)}`;
    case 'enum-mismatch':
      return `${v.path}: 필드 '${v.keyPath}' 값이 허용된 enum/패턴 밖(자유 서술 의심) -> ${formatValueForReport(v.value, verbose)}`;
    case 'link-parse-error':
      return `${v.path}: URL 파싱 실패 -> ${formatUrlForReport(v.url, verbose)}`;
    case 'link-domain':
      return `${v.path}: 허용되지 않은 도메인 '${v.host}' -> ${formatUrlForReport(v.url, verbose)}`;
    case 'job-denylist':
      return `${v.path}: 직군 어휘 '${v.term}' 포함 (${v.locations.join(', ')})`;
    default:
      return `${v.path}: 알 수 없는 위반 유형(${v.rule})`;
  }
}

function printReport(result, verbose) {
  const lines = [];
  lines.push('='.repeat(70));
  lines.push('lint-template.mjs 실행 결과');
  lines.push(`매니페스트: ${result.manifestPath} (${result.manifest.present ? '발견' : '부재 — 기본값(fail-safe)으로 대체'})`);
  if (result.manifest.fellBackPersonalFields) {
    lines.push('  주의: personal_value_fields가 없거나 공란 — 내장 기본 목록으로 대체(모든 해당 필드는 공란이어야 함)');
  }
  if (!verbose) {
    lines.push('  (기본 모드: 위반 값 원문 비공개. 로컬 디버깅 시 --verbose)');
  }
  lines.push(`검사 대상 소스 .md 파일 수: ${result.fileCount} (규칙2·3은 비-md 포함 전체 ${result.allFileCount}개 파일 대상, .build·.github 포함)`);
  lines.push('='.repeat(70));

  const r1PersonalCount = result.r1.violations.filter((v) => v.rule === 'personal-value-field').length;
  const r1ClosedWorldCount = result.r1.violations.filter((v) => v.rule === 'closed-world-unknown-field').length;
  const r1EnumCount = result.r1.violations.filter((v) => v.rule === 'enum-mismatch').length;
  const r1ParseErrorCount = result.r1.violations.filter((v) => v.rule === 'frontmatter-parse-error').length;

  lines.push('');
  lines.push(`--- 규칙1 개인값 필드 + closed-world + enum/패턴 (frontmatter 파싱 실패는 fail-closed로 포함): ${result.r1.violations.length === 0 ? 'PASS' : 'FAIL'} ---`);
  lines.push(`  검사한 비공란 개인값 필드 수: ${result.r1.checkedFields}`);
  lines.push(`  위반 ${result.r1.violations.length}건 (개인값 미승인 ${r1PersonalCount} / closed-world 미지필드 ${r1ClosedWorldCount} / enum·패턴 불일치 ${r1EnumCount} / 파싱실패 ${r1ParseErrorCount})`);
  result.r1.violations.forEach((v) => lines.push(`    - ${formatViolationMessage(v, verbose)}`));

  lines.push('');
  lines.push(`--- 규칙2 링크 도메인 allowlist: ${result.r2.violations.length === 0 ? 'PASS' : 'FAIL'} ---`);
  lines.push(`  검사한 URL 수: ${result.r2.checkedUrls}`);
  lines.push(`  위반 ${result.r2.violations.length}건`);
  result.r2.violations.forEach((v) => lines.push(`    - ${formatViolationMessage(v, verbose)}`));

  lines.push('');
  lines.push(`--- 규칙3 직군 어휘 denylist: ${result.r3.violations.length === 0 ? 'PASS' : 'FAIL'} ---`);
  lines.push(`  위반 ${result.r3.violations.length}건`);
  result.r3.violations.forEach((v) => lines.push(`    - ${formatViolationMessage(v, verbose)}`));

  lines.push('');
  lines.push(`--- 규칙4 신규 최상위 폴더 감지 (경고 전용, 비차단): ${result.warnings.length}건 ---`);
  result.warnings.forEach((w) => lines.push(`    - ${w}`));

  const allPass = result.r1.violations.length === 0
    && result.r2.violations.length === 0
    && result.r3.violations.length === 0;

  lines.push('');
  lines.push('='.repeat(70));
  lines.push(`최종 결과: ${allPass ? 'ALL PASS' : 'FAIL 있음'}`);
  lines.push('='.repeat(70));

  const text = lines.join('\n');
  console.log(text);
  return allPass;
}

// ---------------------------------------------------------------------------
// 셀프테스트 — 위반/정상 케이스를 내장해 검출 여부를 자체 검증한다.
// ---------------------------------------------------------------------------
function buildSelfTestManifest() {
  return finalizeManifest({
    // EN 스키마 필드명 + NFD 회귀 케이스용 한국어 키 1개('메모'). 후자는 실물 스키마에는 더 이상
    // 없지만, foldKey의 NFC 정규화가 죽으면 조용히 통과되는 우회 경로라 커버리지를 남긴다
    // (셀프테스트는 격리된 자체 매니페스트를 쓰므로 실물과 어긋나도 무해하다).
    personal_value_fields: ['memo', 'remarks', 'rating', 'source', 'URL', 'watched_date', '메모'],
    link_domain_allowlist: ['example.com', 'example.org'],
    approved: [
      { path: 'Contents_DB/승인샘플.md', field: 'memo', value: '가공된 승인값' },
      { path: 'Contents_DB/따옴표샘플.md', field: 'rating', value: 5 },
      { path: 'Scrap_DB/허용도메인.md', field: 'source', value: 'https://www.example.com/post/1' },
      { path: 'Contents_DB/승인날짜.md', field: 'watched_date', value: '2025-11-02' },
    ],
  }, true);
}

function buildSelfTestFiles() {
  const nfdMemo = '메모'.normalize('NFD');
  return [
    {
      relPath: 'Contents_DB/미승인.md',
      raw: '---\nmemo: "승인되지 않은 개인 메모"\n---\n본문\n',
      expect: true,
      label: '미승인 개인값 필드 (기본 케이스)',
    },
    {
      relPath: 'Contents_DB/승인샘플.md',
      raw: '---\nmemo: "가공된 승인값"\n---\n본문\n',
      expect: false,
      label: '승인 목록과 정확 일치 (정상 케이스)',
    },
    {
      relPath: 'Contents_DB/따옴표샘플.md',
      raw: '---\nrating: 5\n---\n본문\n',
      expect: false,
      label: '숫자 스칼라 — 따옴표 없음도 정상 일치 (정상 케이스)',
    },
    {
      relPath: 'Contents_DB/중첩우회.md',
      raw: '---\nmeta:\n  memo: "중첩으로 숨긴 개인 메모"\n---\n본문\n',
      expect: true,
      label: '중첩 YAML 우회 시도 (새 부모 키 아래 개인값 필드 은닉)',
    },
    {
      relPath: 'Contents_DB/NFD우회.md',
      raw: `---\n${nfdMemo}: "분해형 키로 숨긴 개인 메모"\n---\n본문\n`,
      expect: true,
      label: 'NFD 분해형 필드명 우회 시도 (한국어 키 폴딩 회귀 방지 — 매니페스트에 짝 등록)',
    },
    {
      // 실제 유출 사고 도메인 문자열은 쓰지 않는다 — 이 파일은 공개 템플릿 repo에 실리므로,
      // 셀프테스트 픽스처가 우연히 비공개 게이트2의 민감 키워드와 겹치면 매 실행마다 오탐이 난다.
      relPath: 'Scrap_DB/불허도메인.md',
      raw: '---\nsource: "https://disallowed-example.test/comic/1"\n---\n본문\n',
      expect: true,
      label: 'frontmatter의 미승인 URL 도메인',
    },
    {
      relPath: 'Scrap_DB/본문링크.md',
      raw: '---\nkind: article\n---\n본문 중 https://evil-leak.example.net/x 링크\n',
      expect: true,
      label: '본문의 미승인 URL 도메인 (허용 도메인과 유사한 이름 함정)',
    },
    {
      relPath: 'Scrap_DB/허용도메인.md',
      raw: "---\nsource: 'https://www.example.com/post/1'\n---\n본문\n",
      expect: false,
      label: '허용 도메인 서브도메인 + 따옴표 스타일 변형 (정상 케이스)',
    },
    {
      relPath: 'W01_워크스페이스/샘플.md',
      raw: '---\ncategory: 개발연구\n---\n본문\n',
      expect: true,
      label: '직군 어휘 denylist — 본문/frontmatter 값',
    },
    {
      relPath: 'W03_개발연구/샘플.md',
      raw: '---\nkind: workspace\n---\n본문\n',
      expect: true,
      label: '직군 어휘 denylist — 경로 자체',
    },
    {
      relPath: 'Scrap_DB/Scrap_용도/바이브코딩.md',
      raw: '---\ntype: purpose\n---\n본문\n',
      expect: false,
      label: '분류 허브 자기참조 예외 (정상 케이스)',
    },
    {
      relPath: 'Inbox/메모.txt',
      raw: '비고: https://disallowed-example.test/leak 여기 적어둠 — 바이브코딩 관련 메모',
      expect: true,
      label: '비-md 파일로 옮겨 숨기기 우회 시도 (URL 도메인 + 직군 어휘 동시)',
    },
    {
      relPath: 'Contents_DB/깨진프론트매터.md',
      raw: '---\nmemo: "닫히지 않은 따옴표\n---\n본문\n',
      expect: true,
      label: 'frontmatter YAML 파싱 자체를 깨뜨려 규칙1을 우회하려는 시도 (fail-closed 확인)',
    },
    // --- CRITICAL-2: Date 인스턴스 오판 회귀 방지 ---
    {
      relPath: 'Contents_DB/미승인날짜.md',
      raw: '---\nwatched_date: 2026-01-15\n---\n본문\n',
      expect: true,
      label: '미승인 날짜값 (따옴표 없는 YAML 날짜 → Date 인스턴스, isEmptyValue 오판 회귀 방지)',
    },
    {
      relPath: 'Contents_DB/승인날짜.md',
      raw: '---\nwatched_date: 2025-11-02\n---\n본문\n',
      expect: false,
      label: '승인된 날짜값 (Date 인스턴스가 문자열 승인 목록과 정상 매칭, 정상 케이스)',
    },
    // --- CRITICAL-4: closed-world 미지 필드 (신규 필드명으로 개인값 은닉) ---
    {
      relPath: 'Contents_DB/신규필드비공란.md',
      raw: '---\nextra_field: "새 필드명으로 숨긴 개인 정보"\n---\n본문\n',
      expect: true,
      label: 'closed-world 위반 — personal_value_fields에도 알려진 스키마에도 없는 신규 필드가 비공란',
    },
    {
      relPath: 'Contents_DB/신규필드공란.md',
      raw: '---\nextra_field:\ncategory: film\n---\n본문\n',
      expect: false,
      label: '신규 필드지만 값이 공란 — 경고만(비차단), 정상 케이스',
    },
    // --- CRITICAL-4: 대소문자 변형으로 personal_value_fields를 우회하려는 시도 ---
    {
      relPath: 'Scrap_DB/케이스변형.md',
      raw: '---\nurl: "https://www.example.com/case-variant"\n---\n본문\n',
      expect: true,
      label: '대소문자 변형(URL→url)으로 개인값 필드 매칭을 피하려는 시도 — 폴딩으로 여전히 검출(허용 도메인이라 규칙2는 통과, 규칙1만으로 검출되어야 함)',
    },
    // --- MEDIUM-D: enum 고정 필드에 자유 서술을 숨기는 시도 (리뷰어 재현 re3-1785167027/known 그대로) ---
    {
      relPath: 'Contents_DB/상태우회.md',
      raw: '---\ncategory: film\ngenre: thriller\nstatus: "2024년 투병 중 시청. 담당 주치의 소견 참고."\n---\n본문\n',
      expect: true,
      label: 'enum 고정 필드(status)에 자유 서술 개인 정보를 숨기는 시도 — 이전에는 "알려진 필드"라 무검증 통과',
    },
    {
      relPath: 'Contents_DB/상태정상.md',
      raw: '---\ncategory: film\ngenre: thriller\nstatus: planned\n---\n본문\n',
      expect: false,
      label: 'status 필드에 정상 enum 값 — 정상 케이스',
    },
    {
      // EN 전환 회귀 방지: status에 한국어 값을 쓰면 enum 밖이라 여기서 잡혀야 한다(워커 L1의
      // checkStatusValue 한글 REJECT와 같은 취지를, 템플릿 커밋 시점에 한 번 더 거는 그물).
      relPath: 'Contents_DB/상태한글.md',
      raw: '---\ncategory: film\nstatus: 볼 예정\n---\n본문\n',
      expect: true,
      label: 'EN 전환 회귀 — status에 남은 한국어 어휘(볼 예정)는 enum 밖으로 검출돼야 함',
    },
    {
      relPath: 'W01_워크스페이스2/카테고리플레이스홀더.md',
      raw: '---\nkind: project\ncategory: "{workspace_name}"\n---\n본문\n',
      expect: false,
      label: 'category 필드의 {placeholder} 템플릿 관례 — enum 예외로 정상 통과(정상 케이스)',
    },
    {
      relPath: 'Contents_DB/상위우회.md',
      raw: '---\ncategory: film\nparent: "다니던 병원 이름과 진료과"\n---\n본문\n',
      expect: true,
      label: '패턴 고정 필드(parent)에 위키링크가 아닌 자유 서술을 숨기는 시도',
    },
    {
      relPath: 'Contents_DB/상위정상.md',
      raw: '---\ncategory: film\nparent: "[[W01_워크스페이스]]"\n---\n본문\n',
      expect: false,
      label: 'parent 필드에 정상 위키링크 패턴 — 정상 케이스',
    },
    {
      relPath: 'Health_DB/Health_지식/주제미승인.md',
      raw: '---\ntopic: "2024년 통원치료 중 알게 된 지식"\n---\n본문\n',
      expect: true,
      label: 'MEDIUM-D — 주제는 자유텍스트라 personal_value_fields로 이동, 미승인 값은 검출돼야 함',
    },
  ];
}

function runEmbeddedFixtureSelfTest() {
  const manifest = buildSelfTestManifest();
  const files = buildSelfTestFiles();

  const r1 = checkPersonalValueFields(files, manifest);
  const r2 = checkLinkDomains(files, manifest);
  const r3 = checkDenylist(files);

  const detectedPaths = new Set([...r1.violations, ...r2.violations, ...r3.violations].map((v) => v.path));

  let allOk = true;
  const lines = ['=== 1) 내장 픽스처 셀프테스트 ==='];
  for (const f of files) {
    const detected = detectedPaths.has(f.relPath);
    const ok = detected === f.expect;
    if (!ok) allOk = false;
    lines.push(
      `${ok ? 'OK  ' : 'FAIL'} ${f.relPath} — ${f.label} (기대: ${f.expect ? '위반 검출' : '위반 없음'}, 실제: ${detected ? '위반 검출' : '위반 없음'})`,
    );
  }
  console.log(lines.join('\n'));
  return allOk;
}

/**
 * 축 4: .build/.github 은닉 우회 — 실제 디스크에 임시 트리를 만들어 walkSourceFiles/walkAllTextFiles가
 * 진짜로 .build 안을 스캔하는지, package-lock.json은 여전히 제외되는지, .git 같은 다른 dot-dir은
 * 여전히 스킵되는지를 검증한다(순수 함수 유닛테스트만으로는 walk 함수 배선 실수를 못 잡는다).
 */
function runDotBuildRealDiskTest() {
  const lines = ['', '=== 2) .build/.github 사각지대 실디스크 검증 (HIGH-4) ==='];
  let allOk = true;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-selftest-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, '.build'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'Contents_DB'), { recursive: true });

    // (a) .build 안(빌드 도구 코드가 아닌 위치)에 숨긴 개인값 누출 — 이제는 잡혀야 한다.
    // (.build/scripts/ 자체는 common.mjs의 SKIP_DIRS('scripts')가 여전히 걸러낸다 — 빌드 툴링
    //  코드를 콘텐츠로 오인하지 않기 위한 기존 설계이므로 여기서는 일부러 건드리지 않는다.)
    fs.writeFileSync(
      path.join(tmpRoot, '.build', 'hidden-leak.md'),
      '---\nmemo: "빌드 폴더에 숨긴 개인 메모"\n---\n본문\n',
    );
    // (b) package-lock.json — npm 레지스트리 URL 정상 포함, 여전히 제외돼야 한다.
    fs.writeFileSync(
      path.join(tmpRoot, '.build', 'package-lock.json'),
      JSON.stringify({ note: 'https://registry.npmjs.org/gray-matter/-/gray-matter-4.0.3.tgz' }),
    );
    // (b2) .github 안에 숨긴 개인값 누출 — common.mjs의 SKIP_DIRS가 '.github'를 이름 그대로
    // 포함하고 있어(원래 build-index.mjs 용도) 잘못 짜면 다시 스킵되는 회귀가 있었다(자체 발견·수정).
    fs.writeFileSync(
      path.join(tmpRoot, '.github', 'hidden-leak.md'),
      '---\nmemo: ".github 폴더에 숨긴 개인 메모"\n---\n본문\n',
    );
    // (c) .git 안에 숨긴 누출 — SCANNED_DOT_DIRS에 없으니 여전히 스킵돼야 한다.
    fs.writeFileSync(
      path.join(tmpRoot, '.git', 'hidden-in-git.md'),
      '---\nmemo: ".git 안에 숨긴 개인 메모(이건 잡히면 안 됨)"\n---\n본문\n',
    );
    // (d) 대조군: 평소대로 스캔되는 일반 파일.
    fs.writeFileSync(
      path.join(tmpRoot, 'Contents_DB', '평범한노트.md'),
      '---\ncategory: film\n---\n본문\n',
    );

    const result = runLint(tmpRoot);
    const violationPaths = new Set(result.r1.violations.map((v) => v.path));
    const allTextPaths = new Set([...result.r2.violations, ...result.r3.violations].map((v) => v.path));

    const checks = [
      ['.build/hidden-leak.md 개인값 위반 검출', violationPaths.has('.build/hidden-leak.md')],
      ['.build/package-lock.json은 스캔 대상에서 제외(레지스트리 URL 오탐 없음)',
        !allTextPaths.has('.build/package-lock.json') && !violationPaths.has('.build/package-lock.json')],
      ['.github/hidden-leak.md 개인값 위반 검출', violationPaths.has('.github/hidden-leak.md')],
      ['.git/hidden-in-git.md는 여전히 스킵(잡히면 안 됨)', !violationPaths.has('.git/hidden-in-git.md')],
      ['대조군(Contents_DB/평범한노트.md)은 위반 없음', !violationPaths.has('Contents_DB/평범한노트.md')],
    ];
    for (const [label, ok] of checks) {
      if (!ok) allOk = false;
      lines.push(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(lines.join('\n'));
  return allOk;
}

/**
 * 축 5: CRITICAL-1 CI 조건식의 진리표 검증. 실제 GitHub Actions를 띄울 수 없으므로
 * (로컬 act 불가 전제) 문서화된 표현식 평가 규칙을 그대로 옮겨 각 needs.lint.result 값에 대해
 * build 잡이 의도대로 실행/스킵되는지 순수 로직으로 확인한다.
 *
 * HIGH-A: GitHub Actions는 `needs` 대상 잡이 skipped면, if 표현식 내용과 무관하게 하류 잡을
 * **자동으로 스킵**한다 — always()가 있어야만 이 자동 스킵을 무시하고 if 표현식을 실제로 평가한다.
 * (success()/failure()/cancelled() 중 하나 없이 needs.*.result만 비교하는 표현식은 여전히 암묵적
 * success()가 앞에 깔리는데, 그 success()는 needs 잡이 skipped인 순간 이미 false로 정해져서
 * always() 없이는 build가 절대 안 돈다.) 리뷰어 재현(wire-1785167090)이 always()를 지운 변형에서
 * 이 자동 스킵이 실제로 발생함을 확인했다 — 그 사실을 여기 진리표에도 회귀 케이스로 고정한다.
 */
function runCiConditionTruthTable() {
  const lines = ['', '=== 3) CI 조건식 진리표 검증 (CRITICAL-1/HIGH-A, 문서 기준 로직 시뮬레이션) ==='];
  let allOk = true;

  // lint 잡 자신의 if 조건 — 템플릿 repo에서만 true.
  function lintRuns(repository) {
    return repository === 'kezilacworks/secondbrain-vault-template';
  }

  // build 잡의 if 조건: always() && (needs.lint.result == 'success' || needs.lint.result == 'skipped')
  function buildRuns(needsLintResult, hasAlwaysGuard) {
    if (needsLintResult === 'skipped' && !hasAlwaysGuard) {
      // always() 없이는 GitHub이 if 표현식을 보지도 않고 build를 자동 스킵한다(문서화된 동작).
      return false;
    }
    return needsLintResult === 'success' || needsLintResult === 'skipped';
  }

  const cases = [
    // [설명, repository, lint가 돌았다면 나왔을 결과(또는 lintRuns()가 false면 'skipped' 강제), hasAlwaysGuard, 기대 buildRuns]
    ['고객 repo(원본 vault 통째 clone) — lint는 repository 불일치로 skip, build는 그래도 진행돼야 함(정상 사용 노트가 있어도 회귀 없음)',
      'someone/their-vault', null, true, true],
    ['템플릿 repo 자신, lint 통과 — build 진행', 'kezilacworks/secondbrain-vault-template', 'success', true, true],
    ['템플릿 repo 자신, lint 실패(진짜 오염 커밋) — build 차단돼야 함', 'kezilacworks/secondbrain-vault-template', 'failure', true, false],
    ['템플릿 repo 자신, lint가 취소됨 — build도 안전하게 차단', 'kezilacworks/secondbrain-vault-template', 'cancelled', true, false],
    ['[HIGH-A 회귀] always() 가드 제거 변형 — 고객 repo에서 lint skip 시 build도 자동 스킵(재현: wire-1785167090/noalways). 이 케이스는 always()가 왜 필수인지 증명하는 용도.',
      'someone/their-vault', null, false, false],
  ];

  for (const [label, repository, forcedResult, hasAlwaysGuard, expectedBuildRuns] of cases) {
    const lintWouldRun = lintRuns(repository);
    const needsLintResult = lintWouldRun ? forcedResult : 'skipped';
    const actualBuildRuns = buildRuns(needsLintResult, hasAlwaysGuard);
    const ok = actualBuildRuns === expectedBuildRuns;
    if (!ok) allOk = false;
    lines.push(`${ok ? 'OK  ' : 'FAIL'} ${label} -> needs.lint.result=${needsLintResult}, always=${hasAlwaysGuard}, build 실행=${actualBuildRuns}`);
  }
  console.log(lines.join('\n'));
  return allOk;
}

function runSelfTest() {
  const ok1 = runEmbeddedFixtureSelfTest();
  const ok2 = runDotBuildRealDiskTest();
  const ok3 = runCiConditionTruthTable();
  const allOk = ok1 && ok2 && ok3;
  console.log('');
  console.log(allOk
    ? '셀프테스트 전체 통과 (모든 위반 케이스 검출 + 정상 케이스 오탐 없음 + .build 실디스크 검증 + CI 조건식 진리표 통과)'
    : '셀프테스트 실패 — 위 FAIL 항목 확인 필요');
  return allOk ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    process.exit(runSelfTest());
    return;
  }

  const verbose = args.includes('--verbose');

  let root = DEFAULT_VAULT_ROOT;
  const rootIdx = args.indexOf('--root');
  if (rootIdx !== -1 && args[rootIdx + 1]) {
    root = path.resolve(args[rootIdx + 1]);
  }

  const result = runLint(root);
  const allPass = printReport(result, verbose);
  process.exit(allPass ? 0 : 1);
}

main();
