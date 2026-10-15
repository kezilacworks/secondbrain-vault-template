// build-journal-index.mjs — 일지 목차(JOURNAL_TODO_META.md · JOURNAL_DIARY_META.md · JOURNAL_INDEX.json) 생성기.
//
// 세브렌이 배송하는 일지 목차 스크립트 — 이 파일을 고치면 다음 배송 때 대장에 없는 판으로 보고 자동 교체가 멈춘다.
// 배송처: 고객 vault `.build/scripts/build-journal-index.mjs` (같은 폴더에 common.mjs가 있어야 한다)
// 실행: `.build/package.json`의 `build-search-corpus` 값 끝 `&& node scripts/build-journal-index.mjs`
// 의존성: gray-matter 하나(템플릿 package.json에 이미 있다). 새 의존성을 들이지 않는다.
//
// 비유: 날짜 노트 두 묶음(할일·일기)을 넘겨 보며 차례표 두 장을 새로 쓴다. 개수·상태는 노트에 적지 않고
// 차례표를 쓸 때마다 본문에서 센다(계획 원칙 3 "본문이 정본").
//
// 인자(시험용, 없으면 인덱서 기본 동작):
//   --vault <dir>    vault 루트(기본: 이 스크립트 두 단계 위)
//   --out-dir <dir>  산출물 폴더(기본: vault 루트)
//
// 이 스크립트가 실패해도 다른 색인(META·코퍼스·라우팅 사전) 커밋을 막지 않는다 — 예외는 경고로 남기고 종료 코드 0.
// 산출물은 결정적이다(시각·커밋 sha를 싣지 않는다) — 노트가 그대로면 바이트도 그대로라 빈 커밋이 생기지 않는다.
//
// ⚠️ 쌍둥이 구현: 체크리스트 파싱·계산값은 서버의 일지 체크리스트 파서와 한 벌이다. 한쪽만 고치면
// 서버 응답과 목차 숫자가 어긋난다 — 배송 전 같은 픽스처로 두 구현을 대조한다.
// 폴더·접두·`종류` 값·섹션 제목은 서버의 일지 로케일 표와 같아야 한다(배송 전 시험이 대조한다).

import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 산출물 형식 버전 — JOURNAL_INDEX.json 필드 의미가 바뀔 때만 올린다. */
export const FORMAT = 1;
/** 스크립트 판본 — 배송 채널의 건강 확인(health.ts)이 JOURNAL_INDEX.json의 이 도장을 본다. 로직이 바뀌면 올린다. */
export const GENERATOR_VERSION = '1.0.1';

export const OUTPUT_TODO_META = 'JOURNAL_TODO_META.md';
export const OUTPUT_DIARY_META = 'JOURNAL_DIARY_META.md';
export const OUTPUT_INDEX = 'JOURNAL_INDEX.json';

// ---------------------------------------------------------------------------
// 로케일 표 — 서버의 일지 로케일 표와 같은 값(시험이 대조한다)
// ---------------------------------------------------------------------------

export const JOURNAL_ROOT = 'Journal_DB';
export const LOCALE = Object.freeze({
  ko: Object.freeze({
    kindFolder: Object.freeze({ todo: 'Journal_할일', diary: 'Journal_일기' }),
    filePrefix: Object.freeze({ todo: '할일_', diary: '일기_' }),
    kindValue: Object.freeze({ todo: '할일', diary: '일기' }),
    checklistTitle: '체크리스트',
    diaryTitle: '일기장',
  }),
  en: Object.freeze({
    kindFolder: Object.freeze({ todo: 'Journal_Todo', diary: 'Journal_Diary' }),
    filePrefix: Object.freeze({ todo: 'Todo_', diary: 'Diary_' }),
    kindValue: Object.freeze({ todo: 'todo', diary: 'diary' }),
    checklistTitle: 'Checklist',
    diaryTitle: 'Diary',
  }),
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const both = (pick) => [pick(LOCALE.ko), pick(LOCALE.en)].map(escapeRe).join('|');

/**
 * 등재 정규식 — dummy-vault/schema.json의 JOURNAL_TODO_META·JOURNAL_DIARY_META 등재 조건과 같다. 종류 폴더가
 * 종류를 정하고, 접두는 그 종류의 두 언어 것을 다 받는다(월 폴더·날짜 실재 검사는 쓰기 검사 몫, 목차는 넓게 보인다).
 * 그룹: 1 폴더 · 2 월 폴더 · 3 제목(basename) · 4 날짜.
 */
export const NOTE_RE = Object.freeze({
  todo: new RegExp(
    `^${escapeRe(JOURNAL_ROOT)}/(${both((l) => l.kindFolder.todo)})/(\\d{4}_\\d{2})/((?:${both((l) => l.filePrefix.todo)})(\\d{4}-\\d{2}-\\d{2}))\\.md$`,
  ),
  diary: new RegExp(
    `^${escapeRe(JOURNAL_ROOT)}/(${both((l) => l.kindFolder.diary)})/(\\d{4}_\\d{2})/((?:${both((l) => l.filePrefix.diary)})(\\d{4}-\\d{2}-\\d{2}))\\.md$`,
  ),
});

/** 목차 열 머리(계획 §10-2 표). `회상`·`검색어` 열은 넣지 않는다(코퍼스가 이미 싣는다). */
export const HEADERS = Object.freeze({
  ko: Object.freeze({
    todo: ['제목', '날짜', '요일', '체크리스트', '할일', '생활업무', '점검'],
    diary: ['제목', '날짜', '요일', '상태', '요약', '감정', '사건', '태그', '점검'],
  }),
  en: Object.freeze({
    todo: ['title', 'date', 'weekday', 'checklist', 'tasks', 'errands', 'check'],
    diary: ['title', 'date', 'weekday', 'status', 'summary', 'emotions', 'events', 'tags', 'check'],
  }),
});

/** 계산값 표시(§3-6). JSON에는 언어 무관 코드(none/open/closed·draft/done)를 싣고, 목차에만 이 표로 옮긴다. */
const CHECKLIST_LABEL = Object.freeze({
  ko: Object.freeze({ none: '없음', open: '진행중', closed: '마감' }),
  en: Object.freeze({ none: 'none', open: 'open', closed: 'closed' }),
});
const DIARY_STATUS_LABEL = Object.freeze({
  ko: Object.freeze({ none: '없음', draft: '작성중', done: '완료' }),
  en: Object.freeze({ none: 'none', draft: 'draft', done: 'done' }),
});
/** 머리 정보 `상태`/`status` 값 → 코드. schema.json catalog.status_pairs.JOURNAL(작성중→draft, 완료→done). */
const DIARY_STATUS_CODE = Object.freeze({ 작성중: 'draft', draft: 'draft', 완료: 'done', done: 'done' });

/** 점검 코드(JSON) → 목차 표시. */
export const CHECK_CODES = Object.freeze(['date_mismatch', 'missing_title', 'missing_kind', 'no_pair']);
const CHECK_LABEL = Object.freeze({
  ko: Object.freeze({ date_mismatch: '날짜≠파일명', missing_title: '제목 누락', missing_kind: '종류 누락', no_pair: '짝 없음' }),
  en: Object.freeze({ date_mismatch: 'date≠filename', missing_title: 'missing title', missing_kind: 'missing kind', no_pair: 'no pair' }),
});

const WEEKDAYS = Object.freeze({
  ko: ['일', '월', '화', '수', '목', '금', '토'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
});

/** 노션 이관 일기 표식(운영자 노션 이관 키) — 이 주석이 있는 일기는 짝 없음 점검에서 뺀다. */
const NOTION_MARK = '<!-- notion:';

// ---------------------------------------------------------------------------
// 계산 규칙(§3-5·§3-6) — 순수 함수, 쌍둥이 대조 대상
// ---------------------------------------------------------------------------

/** vault 텍스트 정규화(L-71): NFC + 줄끝 LF. */
export function normalizeText(text) {
  return String(text).normalize('NFC').replace(/\r\n?/g, '\n');
}

/**
 * `## <제목>` 구간들의 줄. 구간은 그 제목 줄 다음부터 다음 H1·H2 줄 전까지다(`###` 이하는 구간 안).
 * 같은 제목이 여러 번 나오면 전부 이어 붙인다. titles는 두 언어 제목 목록.
 */
export function sectionLines(body, titles) {
  const heading = new RegExp(`^## (?:${titles.map(escapeRe).join('|')})[ \\t]*$`);
  const out = [];
  let inside = false;
  for (const line of normalizeText(body).split('\n')) {
    if (/^#{1,2}[ \t]/.test(line)) {
      inside = heading.test(line);
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

const ITEM_RE = /^- \[( |x|X|>|-)\](?=\s|$)(.*)$/;
const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
const MARK_KIND = Object.freeze({ ' ': 'open', x: 'done', X: 'done', '>': 'moved', '-': 'cancelled' });

/**
 * 체크리스트 항목(§3-5) — `## 체크리스트`/`## Checklist` 구간의 들여쓰기 없는 `- [?]` 줄만 항목이다.
 * 바로 아래 들여쓴 줄은 그 항목에 딸리므로 세지 않는다. 반환: [{ mark: 'open'|'done'|'moved'|'cancelled', text, tags }].
 */
export function parseChecklist(body) {
  const items = [];
  for (const line of sectionLines(body, [LOCALE.ko.checklistTitle, LOCALE.en.checklistTitle])) {
    const m = ITEM_RE.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    items.push({ mark: MARK_KIND[m[1]], text, tags: extractTags(text) });
  }
  return items;
}

/** 항목 텍스트의 `#분류` — 공백(또는 줄 처음) 뒤의 `#` 낱말. 숫자만인 것(#3)은 태그가 아니다(Obsidian 규칙). */
export function extractTags(text) {
  const out = [];
  for (const m of String(text).matchAll(TAG_RE)) {
    const tag = m[1];
    if (/^\d+$/.test(tag)) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * 할일 노트 계산값(§3-6). total = [ ]+[x]+[>] ([-] 제외), done = [x].
 * 상태: 항목 0개 = none · [ ]가 1개 이상 = open · 항목이 있고 [ ] 없음 = closed(취소만 있어도 closed).
 * 시각과 무관한 정의다 — 인덱서는 테넌트 타임존을 모른다.
 */
export function computeTodo(body) {
  const items = parseChecklist(body);
  const count = (k) => items.filter((i) => i.mark === k).length;
  const open = count('open');
  const done = count('done');
  const moved = count('moved');
  const cancelled = count('cancelled');
  const status = items.length === 0 ? 'none' : open > 0 ? 'open' : 'closed';
  const errands = [];
  for (const i of items) for (const t of i.tags) if (!errands.includes(t)) errands.push(t);
  return { status, done, total: open + done + moved, open, moved, cancelled, errands };
}

/**
 * 일기 노트 상태(§3-6). 머리 정보 `상태`/`status`가 있으면 그 값(작성중·완료 / draft·done → 코드, 모르는 값은 원문),
 * 없으면 `## 일기장`/`## Diary` 구간에 내용이 있으면 draft(Obsidian에서 쓴 경우), 비었으면 none.
 * 내용으로 치지 않는 줄: 빈 줄 · `###`~`######` 소제목 · 한 줄짜리 HTML 주석(노션 이관 표식 등).
 */
export function computeDiaryStatus(fm, body) {
  const raw = pickValue(fm, '상태', 'status');
  if (raw != null && String(raw).trim() !== '') {
    const v = String(raw).trim();
    return { status: DIARY_STATUS_CODE[v] ?? v, source: 'frontmatter' };
  }
  const content = sectionLines(body, [LOCALE.ko.diaryTitle, LOCALE.en.diaryTitle]).some((line) => {
    const t = line.trim();
    return t !== '' && !/^#{3,6}(?:[ \t]|$)/.test(t) && !/^<!--.*-->$/.test(t);
  });
  return { status: content ? 'draft' : 'none', source: 'computed' };
}

/** `YYYY-MM-DD` → 요일 인덱스(0=일). 달력에 없는 날이면 null. */
export function weekdayIndex(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.getUTCDay();
}

// ---------------------------------------------------------------------------
// 머리 정보 다루기
// ---------------------------------------------------------------------------

/** KO 키가 있으면 그것, 없으면 EN 키(두 언어 vault 공용). */
export function pickValue(fm, ko, en) {
  if (fm && fm[ko] !== undefined && fm[ko] !== null) return fm[ko];
  if (fm && fm[en] !== undefined && fm[en] !== null) return fm[en];
  return undefined;
}

/** Date → 'YYYY-MM-DD'(gray-matter는 YAML 날짜를 Date로 읽는다 — 템플릿 build-index.mjs isoDate와 같다). */
function isoDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function normalizeValue(v) {
  if (v instanceof Date) return isoDate(v);
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = normalizeValue(x);
    return out;
  }
  return v;
}

/** 머리 정보 `날짜`/`date`를 문자열로(없으면 ''). */
function fmDate(fm) {
  const v = normalizeValue(pickValue(fm, '날짜', 'date'));
  return v == null ? '' : String(v).trim();
}

/** 목차 셀 — `|`는 표를 어긋나게 하므로(meta-filter splitCells는 `\|`도 가른다) `¦`로, 줄바꿈은 공백으로. */
export function cell(value) {
  const v = normalizeValue(value);
  if (v == null || v === '') return '';
  const s = Array.isArray(v) ? v.filter((x) => x != null && x !== '').join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, '¦').replace(/\s*\n\s*/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// vault 읽기 · 조립
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join('/');
}

async function walk(dir, common, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (common.SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, common, out);
    else if (e.name.endsWith('.md') && !common.isSkippedFile(e.name)) out.push(full);
  }
}

/**
 * 목차 언어 — 종류 폴더 이름으로 정한다(Journal_할일·Journal_일기 = ko, Journal_Todo·Journal_Diary = en).
 * 둘 다 있으면 노트가 많은 쪽, 같으면 ko. 노트가 하나도 없으면 KO 종류 폴더만 있을 때 ko, 그 밖(폴더도 없음)은
 * en(신규 가입자 기본 로케일, D-15) — 노트가 생기는 첫 push에 폴더 이름을 따라 바로 바뀐다.
 */
export function detectLocale(folderCounts) {
  const ko = folderCounts.ko ?? 0;
  const en = folderCounts.en ?? 0;
  if (ko === 0 && en === 0) return folderCounts.koFolder && !folderCounts.enFolder ? 'ko' : 'en';
  return ko >= en ? 'ko' : 'en';
}

const folderLocale = (folder) =>
  folder === LOCALE.ko.kindFolder.todo || folder === LOCALE.ko.kindFolder.diary ? 'ko' : 'en';

/**
 * vault → { index, todoMeta, diaryMeta }. 사용자 노트는 읽기만 한다(Journal_DB 아래만 걷는다).
 * opts.matter / opts.common: 주입용(시험). 없으면 형제 common.mjs와 gray-matter를 불러온다.
 */
export async function buildJournalIndex({ vaultRoot, ...opts }) {
  const common = opts.common ?? (await import('./common.mjs'));
  const matter = opts.matter ?? (await import('gray-matter')).default;

  const journalDir = path.join(vaultRoot, JOURNAL_ROOT);
  const files = [];
  await walk(journalDir, common, files);
  files.sort();

  const folderCounts = { ko: 0, en: 0, koFolder: false, enFolder: false };
  try {
    for (const e of await fs.readdir(journalDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const name = e.name.normalize('NFC');
      if (name === LOCALE.ko.kindFolder.todo || name === LOCALE.ko.kindFolder.diary) folderCounts.koFolder = true;
      if (name === LOCALE.en.kindFolder.todo || name === LOCALE.en.kindFolder.diary) folderCounts.enFolder = true;
    }
  } catch {
    // Journal_DB가 아직 없다 — 빈 목차를 만든다(건강 확인 도장이 필요하다).
  }

  const notes = { todo: [], diary: [] };
  let parseFail = 0;
  for (const abs of files) {
    const rel = toPosix(path.relative(vaultRoot, abs)).normalize('NFC');
    const kind = NOTE_RE.todo.test(rel) ? 'todo' : NOTE_RE.diary.test(rel) ? 'diary' : null;
    if (!kind) continue;
    const [, folder, , title, fileDate] = NOTE_RE[kind].exec(rel);
    let parsed;
    try {
      // 두 번째 인자 {}: 옵션 없이 부르면 gray-matter가 파싱 전에 입력을 캐시해, 실패한 파일이 다음 호출에서
      // 빈 frontmatter로 통과한다(build-routing-index.mjs와 같은 이유).
      parsed = matter(normalizeText(await fs.readFile(abs, 'utf8')), {});
    } catch {
      parseFail++;
      console.warn(`⚠️ frontmatter 파싱 실패: ${rel}`);
      continue;
    }
    folderCounts[folderLocale(folder)]++;
    const fm = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
    notes[kind].push({ rel, title, fileDate, fm, body: parsed.content ?? '' });
  }

  const locale = detectLocale(folderCounts);
  const dates = { todo: new Set(notes.todo.map((n) => n.fileDate)), diary: new Set(notes.diary.map((n) => n.fileDate)) };
  const weekdayOf = (date) => {
    const i = weekdayIndex(date);
    return i === null ? '' : WEEKDAYS[locale][i];
  };

  const common4 = (kind, n) => {
    const fmd = fmDate(n.fm);
    const date = weekdayIndex(fmd) !== null ? fmd : n.fileDate;
    const checks = [];
    if (fmd !== n.fileDate) checks.push('date_mismatch');
    if (!normalizeText(n.body).split('\n').some((l) => l.trim() === `# ${n.title}`)) checks.push('missing_title');
    const kv = pickValue(n.fm, '종류', 'kind');
    const kindOk = kv != null && [LOCALE.ko.kindValue[kind], LOCALE.en.kindValue[kind]].includes(String(kv).trim());
    if (!kindOk) checks.push('missing_kind');
    return { date, checks };
  };

  const byNewest = (a, b) => (a.fileDate === b.fileDate ? a.title.localeCompare(b.title, 'ko') : a.fileDate < b.fileDate ? 1 : -1);

  const todoItems = [...notes.todo].sort(byNewest).map((n) => {
    const { date, checks } = common4('todo', n);
    if (!dates.diary.has(n.fileDate)) checks.push('no_pair');
    const c = computeTodo(n.body);
    return {
      title: n.title,
      path: n.rel,
      date,
      weekday: weekdayOf(date),
      checklist: { status: c.status, done: c.done, total: c.total, open: c.open, moved: c.moved, cancelled: c.cancelled },
      errands: c.errands,
      checks,
      frontmatter: normalizeValue(n.fm),
    };
  });

  const diaryItems = [...notes.diary].sort(byNewest).map((n) => {
    const { date, checks } = common4('diary', n);
    const notion = n.body.includes(NOTION_MARK);
    if (!notion && !dates.todo.has(n.fileDate)) checks.push('no_pair');
    const s = computeDiaryStatus(n.fm, n.body);
    return {
      title: n.title,
      path: n.rel,
      date,
      weekday: weekdayOf(date),
      status: s.status,
      status_source: s.source,
      notion,
      checks,
      frontmatter: normalizeValue(n.fm),
    };
  });

  const index = {
    format: FORMAT,
    generator_version: GENERATOR_VERSION,
    locale,
    parse_fail: parseFail,
    todo: { count: todoItems.length, items: todoItems },
    diary: { count: diaryItems.length, items: diaryItems },
  };
  return { index, todoMeta: renderTodoMeta(index), diaryMeta: renderDiaryMeta(index) };
}

// ---------------------------------------------------------------------------
// 렌더
// ---------------------------------------------------------------------------

const checkCell = (locale, checks) => checks.map((c) => CHECK_LABEL[locale][c]).join(', ');
const titleCell = (title) => `[[${String(title).replace(/\|/g, '¦')}]]`;

function renderTable(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
}

function preamble(name, locale, count, parseFail, note) {
  const ko = locale === 'ko';
  return [
    `# ${name}`,
    '',
    ko ? '> 자동 생성(일지 인덱서 build-journal-index.mjs). 직접 고치지 마세요 — 다음 push에 다시 만들어집니다.' : '> Auto-generated (journal indexer build-journal-index.mjs). Do not edit — it is overwritten on the next push.',
    ko ? `> ${note.ko}` : `> ${note.en}`,
    ko
      ? `> 항목 수: ${count}${parseFail ? ` (파싱 실패: ${parseFail})` : ''} · 최신순`
      : `> Item count: ${count}${parseFail ? ` (parse failures: ${parseFail})` : ''} · newest first`,
    '',
  ];
}

export function renderTodoMeta(index) {
  const { locale } = index;
  const rows = index.todo.items.map((it) => [
    titleCell(it.title),
    cell(it.date),
    it.weekday,
    CHECKLIST_LABEL[locale][it.checklist.status],
    `${it.checklist.done}/${it.checklist.total}`,
    cell(it.errands),
    checkCell(locale, it.checks),
  ]);
  return [
    ...preamble(OUTPUT_TODO_META.replace('.md', ''), locale, index.todo.count, index.parse_fail, {
      ko: '할일 노트 한 장 = 한 행. 할일 = 완료/전체(취소 제외), 체크리스트 = 없음·진행중·마감(본문에서 계산).',
      en: 'One row per todo note. tasks = done/total (cancelled excluded), checklist = none·open·closed (computed from the body).',
    }),
    ...renderTable(HEADERS[locale].todo, rows),
    '',
  ].join('\n');
}

export function renderDiaryMeta(index) {
  const { locale } = index;
  const rows = index.diary.items.map((it) => [
    titleCell(it.title),
    cell(it.date),
    it.weekday,
    cell(DIARY_STATUS_LABEL[locale][it.status] ?? it.status),
    cell(pickValue(it.frontmatter, '요약', 'summary')),
    cell(pickValue(it.frontmatter, '감정', 'emotions')),
    cell(pickValue(it.frontmatter, '사건', 'events')),
    cell(pickValue(it.frontmatter, '태그', 'tags')),
    checkCell(locale, it.checks),
  ]);
  return [
    ...preamble(OUTPUT_DIARY_META.replace('.md', ''), locale, index.diary.count, index.parse_fail, {
      ko: '일기 노트 한 장 = 한 행. 상태 키가 없으면 일기장 구간으로 계산(비었으면 없음, 내용이 있으면 작성중).',
      en: 'One row per diary note. Without a status key the Diary section decides (empty = none, any content = draft).',
    }),
    ...renderTable(HEADERS[locale].diary, rows),
    '',
  ].join('\n');
}

/** 직렬화 — 노트 하나에 한 줄(diff가 읽히게). 유효한 JSON이다. */
export function serializeIndex(index) {
  const { todo, diary, ...head } = index;
  const list = (items) => (items.length ? `[\n${items.map((i) => JSON.stringify(i)).join(',\n')}\n]` : '[]');
  const headJson = JSON.stringify(head);
  return (
    `${headJson.slice(0, -1)},` +
    `"todo":{"count":${todo.count},"items":${list(todo.items)}},\n` +
    `"diary":{"count":${diary.count},"items":${list(diary.items)}}}\n`
  );
}

function defaultVaultRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vault') out.vault = argv[++i];
    else if (argv[i] === '--out-dir') out.outDir = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultRoot = path.resolve(args.vault ?? defaultVaultRoot());
  const outDir = path.resolve(args.outDir ?? vaultRoot);
  const { index, todoMeta, diaryMeta } = await buildJournalIndex({ vaultRoot });
  await fs.writeFile(path.join(outDir, OUTPUT_TODO_META), todoMeta);
  await fs.writeFile(path.join(outDir, OUTPUT_DIARY_META), diaryMeta);
  await fs.writeFile(path.join(outDir, OUTPUT_INDEX), serializeIndex(index));
  console.log(
    `✅ ${OUTPUT_TODO_META} ${index.todo.count} · ${OUTPUT_DIARY_META} ${index.diary.count} · ${OUTPUT_INDEX} (locale ${index.locale}${index.parse_fail ? `, parse failures ${index.parse_fail}` : ''})`,
  );
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((e) => {
    // 목차 실패가 META·코퍼스·라우팅 사전 커밋을 막지 않게 종료 코드 0.
    console.warn(`⚠️ build-journal-index skipped: ${e && e.message ? e.message : String(e)}`);
  });
}
