// build-routing-index.mjs — 라우팅 사전(ROUTING_INDEX.json) 생성기.
//
// 세브렌이 배송하는 라우팅 사전 스크립트 — 이 파일을 고치면 다음 배송 때 대장에 없는 판으로 보고 자동 교체가 멈춘다.
// 배송처: 고객 vault `.build/scripts/build-routing-index.mjs` (같은 폴더에 common.mjs가 있어야 한다)
// 실행: `.build/package.json`의 `build-search-corpus` 값 뒤에 `&& node scripts/build-routing-index.mjs`
// 의존성: gray-matter 하나(템플릿 package.json에 이미 있다). 새 의존성을 들이지 않는다.
//
// 비유: 서가(프로젝트) 이름과 흔한 오기를 적은 작은 수첩을 push마다 새로 만든다. 워커의 "문 앞 확인"이
// 이 수첩만 읽는다 — 무거운 통계는 여기(인덱서)서 끝낸다.
//
// 인자(측정·시험용, 없으면 인덱서 기본 동작):
//   --vault <dir>  vault 루트(기본: 이 스크립트 두 단계 위)
//   --out <file>   출력 경로(기본: <vault>/ROUTING_INDEX.json)
//
// 이 스크립트가 실패해도 다른 색인(META·코퍼스) 커밋을 막지 않는다 — 예외는 경고로 남기고 종료 코드 0.
// 게이트는 사전이 없으면 무발동이다.
//
// ⚠️ 쌍둥이 구현: 키 변환·조사·본문 정리·낱말 경계·거리는 서버 쪽 라우팅 매처와 한 벌이다.
// 한쪽만 고치면 사전 통계와 런타임 대조가 어긋난다(배송 전 쌍둥이 대조 시험이 잡는다).

import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 사전 형식 버전 — 워커 ROUTING_FORMAT과 같아야 워커가 쓴다. 필드 의미가 바뀔 때만 올린다. */
export const FORMAT = 1;
/** 스크립트 판본 — 배송 채널의 건강 확인(계획 §7)이 이 값을 본다. 로직이 바뀌면 올린다. */
export const GENERATOR_VERSION = '1.0.2';

/**
 * 매개변수(계획 §2-2·§2-4). 초기값 = 계획서 값. §9-1 측정으로 확정한 값과 측정일은 계획서 §2에 기록한다.
 */
export const PARAMS = Object.freeze({
  uniqueness_min: 0.5, // ③ 고유도: 토큰이 나오는 노트 중 소유 폴더 안 비율 ≥ 50%
  outside_max_ratio: 0.02, // ③ 폴더 밖 등장 ≤ 전체 노트의 2%
  sample_min: 3, // ③ 표본 ≥ 3건 (① 정식 이름도 3건 미만이면 근접을 끈다)
  small_vault_notes: 50, // 작은 vault 하한: 모수 50건 미만이면 근접은 ②층만
  confusable_outside_min: 3, // 혼동어: 소유 폴더 밖 3건 이상
  confusable_outside_ratio: 0.5, // 혼동어: 전체 등장의 50% 이상이 밖
});

/**
 * 크기 상한 — 토큰·혼동어·범위 문구가 vault 크기에 비례해 무한히 커지지 않게 한다.
 * 목표: 프로젝트 200개(기획 600개) vault에서 100 KB 이하(test/routing-index-script.test.ts가 잰다).
 * 항목별 상한을 두고, 그래도 budget_bytes를 넘으면 사다리로 줄이며 머리 `trimmed`에 무엇을 줄였는지 적는다.
 */
export const CAPS = Object.freeze({
  scope_items: 5, // 프로젝트의 기획 링크 없는 불릿 수
  scope_chars: 40,
  tokens: 6,
  names: 10, // ② 별칭·폐기명 각각
  name_chars: 40,
  confusables: 200,
  alias_needed: 100,
  budget_bytes: 100 * 1024,
});

// ---------------------------------------------------------------------------
// 공용 규칙 — 워커 routing-match.ts와 한 벌(쌍둥이 대조 대상)
// ---------------------------------------------------------------------------

const PARTICLE_SOURCE = '으로 로 에 에서 의 을 를 은 는 이 가 과 와 도 만 까지 부터 랑 이랑 한테 께 에게 에게서 한테서 께서 처럼 보다 이나 나 이든 든 이라 라 이라는 라는 이라고 라고 으로서 로서 으로써 로써 에선 에는 에서는 으론 론';
export const PARTICLES = PARTICLE_SOURCE.split(' ');
const PARTICLES_BY_LEN = [...PARTICLES].sort((a, b) => b.length - a.length);

const JAMO_KEYS = {
  ㄱ: 'r', ㄲ: 'R', ㄳ: 'rt', ㄴ: 's', ㄵ: 'sw', ㄶ: 'sg', ㄷ: 'e', ㄸ: 'E', ㄹ: 'f', ㄺ: 'fr', ㄻ: 'fa',
  ㄼ: 'fq', ㄽ: 'ft', ㄾ: 'fx', ㄿ: 'fv', ㅀ: 'fg', ㅁ: 'a', ㅂ: 'q', ㅃ: 'Q', ㅄ: 'qt', ㅅ: 't', ㅆ: 'T',
  ㅇ: 'd', ㅈ: 'w', ㅉ: 'W', ㅊ: 'c', ㅋ: 'z', ㅌ: 'x', ㅍ: 'v', ㅎ: 'g',
  ㅏ: 'k', ㅐ: 'o', ㅑ: 'i', ㅒ: 'O', ㅓ: 'j', ㅔ: 'p', ㅕ: 'u', ㅖ: 'P', ㅗ: 'h', ㅘ: 'hk', ㅙ: 'ho',
  ㅚ: 'hl', ㅛ: 'y', ㅜ: 'n', ㅝ: 'nj', ㅞ: 'np', ㅟ: 'nl', ㅠ: 'b', ㅡ: 'm', ㅢ: 'ml', ㅣ: 'l',
};
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/** 문자열 → 두벌식 키 나열(겹받침·복합모음 분해, 쌍자음·ㅒ·ㅖ는 대문자, 영문 소문자, 숫자 그대로). */
export function toKeys(s) {
  let out = '';
  for (const ch of String(s).normalize('NFC')) {
    const c = ch.codePointAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) {
      const code = c - 0xac00;
      out += JAMO_KEYS[CHO[Math.floor(code / 588)]] + JAMO_KEYS[JUNG[Math.floor((code % 588) / 28)]];
      const jong = JONG[code % 28];
      if (jong) out += JAMO_KEYS[jong];
    } else if (JAMO_KEYS[ch] !== undefined) {
      out += JAMO_KEYS[ch];
    } else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7)) {
      out += ch.toLowerCase();
    } else if (c >= 0x30 && c <= 0x39) {
      out += ch;
    }
  }
  return out;
}

/** 키 개수별 허용 거리: 5개 이하 0, 6~11개 1, 12개 이상 2. */
export function maxDistanceForKeyLen(keyLen) {
  if (keyLen <= 5) return 0;
  if (keyLen <= 11) return 1;
  return 2;
}

/** Damerau-Levenshtein(OSA). max를 넘으면 max+1. */
export function osaDistance(a, b, max) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev2 = new Array(lb + 1).fill(0);
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb] > max ? max + 1 : prev[lb];
}

/** 이름 키 앞뒤에 키가 덧붙기만 한 표기(합성어) — 근접 일치에서 버린다. */
export function isAffixExtension(stemKeys, nameKeys) {
  return stemKeys.length > nameKeys.length && (stemKeys.startsWith(nameKeys) || stemKeys.endsWith(nameKeys));
}

const HANGUL_RE = /[\u3131-\u318e\uac00-\ud7a3]/;
export function hasHangul(s) {
  return HANGUL_RE.test(s);
}

const URL_RE =
  /\b(?:https?|ftp):\/\/[^\s<>()[\]]+|\bwww\.[^\s<>()[\]]+|\b(?:[a-z0-9-]{1,63}\.){1,10}(?:com|net|org|kr|io|co|ai|dev|app|me|so|site|xyz|info|biz|us|uk|jp|tv|ly|gg|link|page|blog|news|shop|store)\b(?:\/[^\s<>()[\]]*)?/gi;
const INLINE_CODE_RE = /``[^\n]+?``|`[^`\n]+`/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const blank = (s) => s.replace(/[^\n]/g, ' ');

/** 코드 블록·인라인 코드·URL을 같은 길이 공백으로(오프셋 보존). 위키링크는 남긴다. */
export function cleanForMatch(text) {
  const lines = text.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i]);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && lines[i].trim() === m[1]) fence = null;
      lines[i] = blank(lines[i]);
      continue;
    }
    if (m) {
      fence = m[1];
      lines[i] = blank(lines[i]);
      continue;
    }
    lines[i] = lines[i].replace(INLINE_CODE_RE, blank).replace(URL_RE, blank);
  }
  return lines.join('\n');
}

const WORD_RE = /[0-9A-Za-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u3131-\u318e\uac00-\ud7a3]+/g;
const GAP_RE = /^[ \t_\-\u00a0]+$/;

export function tokenizeWords(cleaned) {
  const out = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(cleaned))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

export function isNameGap(cleaned, a, b) {
  return b.start > a.end && GAP_RE.test(cleaned.slice(a.end, b.start));
}

/** 낱말 → 줄기(자신 + 조사 한 겹 + 두 겹). */
export function stemsOf(word) {
  const out = [word];
  const strip = (w) => {
    const r = [];
    for (const p of PARTICLES_BY_LEN) if (w.length > p.length && w.endsWith(p)) r.push(w.slice(0, -p.length));
    return r;
  };
  for (const s1 of strip(word)) {
    if (!out.includes(s1)) out.push(s1);
    for (const s2 of strip(s1)) if (!out.includes(s2)) out.push(s2);
  }
  return out;
}

export function normalizeNameSurface(s) {
  return String(s)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s_\-\u00a0]+/g, ' ')
    .trim();
}

export function nameWords(s) {
  return tokenizeWords(normalizeNameSurface(s)).map((w) => w.text);
}

// ---------------------------------------------------------------------------
// 생략 규칙 — 워커 routing-dict.ts parseRoutingDict와 한 벌
// ---------------------------------------------------------------------------

/** id(제목, 또는 제목이 겹칠 때의 경로) → 접두를 뗀 이름. */
export function deriveName(id) {
  const base = String(id).split('/').pop().replace(/\.md$/, '');
  return base.replace(/^P\d+_(?:S\d+_)?/, '') || base;
}

/** 기획 id + 프로젝트 경로 → 관례상 기획 노트 경로(`프로젝트 폴더/기획 id/기획 id.md`). id가 경로면 null. */
export function derivePlanPath(id, projectPath) {
  if (!projectPath || String(id).includes('/')) return null;
  const dir = projectPath.includes('/') ? projectPath.slice(0, projectPath.lastIndexOf('/')) : '';
  return `${dir ? dir + '/' : ''}${id}/${id}.md`;
}

// ---------------------------------------------------------------------------
// vault 읽기
// ---------------------------------------------------------------------------

const KIND_MAP = { 프로젝트: 'project', project: 'project', 기획: 'plan', plan: 'plan' };
/** 비활성 상태(KO·EN) — 커버리지·목록의 "활성" 판정. schema.json catalog.status_pairs.WORKS의 완료·보류·보관. */
const INACTIVE_STATUS = new Set(['완료', '보류', '보관', 'done', 'hold', 'archived']);
const PREFIX_RE = /^P\d+_(?:S\d+_)?/;
const PLAN_SECTION_RE = /^(#{1,6})\s*(?:기획\s*목록|기획|plan\s*list|planning|plans?)\s*:?\s*$/i;
const HEADING_RE = /^(#{1,6})\s/;
const WORKSPACE_RE = /^W\d{2}_/;
const INBOX_RE = /^[Ii]nbox$/;

function pick(fm, ko, en) {
  if (fm && Object.prototype.hasOwnProperty.call(fm, ko)) return { v: fm[ko], key: 'ko' };
  if (fm && Object.prototype.hasOwnProperty.call(fm, en)) return { v: fm[en], key: 'en' };
  return { v: undefined, key: null };
}

function isTruthyValue(v) {
  if (v == null || v === false) return false;
  if (Array.isArray(v)) return v.some((x) => isTruthyValue(x));
  return String(v).trim() !== '';
}

function toList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const x of arr) {
    if (x == null || typeof x === 'object') continue;
    const s = String(x).normalize('NFC').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function unlink(v) {
  if (v == null) return undefined;
  const s = String(Array.isArray(v) ? v[0] ?? '' : v).trim();
  const m = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(s);
  const out = (m ? m[1] : s).trim().normalize('NFC');
  return out || undefined;
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

async function walk(root, dir, common, out) {
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
    if (e.isDirectory()) await walk(root, full, common, out);
    else if (e.name.endsWith('.md') && !common.isSkippedFile(e.name)) out.push(full);
  }
}

/** 기획 목록 절의 불릿 원문(계획 §2-1 기획 범위 문구). 절이 없으면 null. 위키링크는 그대로 둔다. */
export function extractPlanScope(content) {
  const lines = String(content).split('\n');
  let level = 0;
  let inSec = false;
  const items = [];
  let found = false;
  for (const line of lines) {
    const h = HEADING_RE.exec(line);
    if (inSec && h && h[1].length <= level) break;
    if (!inSec) {
      const m = PLAN_SECTION_RE.exec(line.trim());
      if (m) {
        inSec = true;
        found = true;
        level = m[1].length;
      }
      continue;
    }
    const b = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (b && b[1].trim()) items.push(b[1].trim());
  }
  return found ? items : null;
}

/** 불릿 한 줄 → { link: 첫 위키링크 대상 | null, desc: 링크를 뺀 설명 } */
export function splitScopeBullet(bullet) {
  const m = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/.exec(bullet);
  const plain = (s) =>
    s
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/\*\*|`/g, '')
      .replace(/^[\s\u2014\u2013\-:·|]+/, '')
      .trim();
  if (!m) return { link: null, desc: plain(bullet) };
  const rest = bullet.slice(0, m.index) + bullet.slice(m.index + m[0].length);
  return { link: m[1].trim().normalize('NFC'), desc: plain(rest) };
}

async function readGitHead(root) {
  try {
    const head = (await fs.readFile(path.join(root, '.git', 'HEAD'), 'utf8')).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const m = /^ref:\s*(.+)$/.exec(head);
    if (!m) return null;
    try {
      const sha = (await fs.readFile(path.join(root, '.git', m[1]), 'utf8')).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    } catch {
      /* packed-refs로 */
    }
    const packed = await fs.readFile(path.join(root, '.git', 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const [sha, ref] = line.trim().split(' ');
      if (ref === m[1] && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
  } catch {
    /* git 아님 */
  }
  return null;
}

// ---------------------------------------------------------------------------
// 사전 생성
// ---------------------------------------------------------------------------

/**
 * vault를 직접 훑어 사전을 만든다. 반환: { dict, report } — dict는 파일에 쓰는 것, report는 측정용 진단
 * (토큰별 통계·탈락 사유·혼동어 근거). 인덱서 실행은 dict만 쓴다.
 *
 * opts.matter / opts.common: 주입용(시험). 없으면 형제 common.mjs와 gray-matter를 불러온다.
 */
export async function buildRoutingIndex(opts = {}) {
  const vaultRoot = path.resolve(opts.vaultRoot ?? defaultVaultRoot());
  const common = opts.common ?? (await import('./common.mjs'));
  const matter = opts.matter ?? (await import('gray-matter')).default;
  const params = { ...PARAMS, ...(opts.params ?? {}) };
  const caps = { ...CAPS, ...(opts.caps ?? {}) };

  const files = [];
  await walk(vaultRoot, vaultRoot, common, files);
  files.sort();

  const notes = []; // 통계 모수(Inbox 제외)
  const found = []; // W 아래 프로젝트·기획 후보
  let parseFail = 0;
  let koKeys = 0;
  let enKeys = 0;
  for (const abs of files) {
    const rel = toPosix(path.relative(vaultRoot, abs)).normalize('NFC');
    const top = rel.split('/')[0];
    let parsed;
    try {
      // 두 번째 인자 {}: gray-matter는 옵션 없이 부르면 파싱 **전에** 입력을 캐시해, 파싱에 실패한 파일이
      // 같은 프로세스의 다음 호출에서 빈 frontmatter로 통과한다(측정 중 실측). 옵션 객체를 주면 캐시를 건너뛴다 —
      // 파싱 규칙(기본 옵션)은 build-index.mjs의 matter(raw)와 같고, 전 노트 본문을 메모리에 쌓지도 않는다.
      parsed = matter((await fs.readFile(abs, 'utf8')).normalize('NFC'), {});
    } catch {
      parseFail++;
      continue;
    }
    const baseFm = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
    // 측정 전용 훅: vault 파일을 고치지 않고 frontmatter 값(예: ②층 별칭)을 가정해 본다. 인덱서 실행에는 없다.
    const fm = opts.fmOverrides && opts.fmOverrides[rel] ? { ...baseFm, ...opts.fmOverrides[rel] } : baseFm;
    const title = path.basename(rel, '.md');
    if (!INBOX_RE.test(top)) notes.push({ rel, text: `${title}\n${parsed.content ?? ''}` });
    if (!WORKSPACE_RE.test(top)) continue;
    const kindPick = pick(fm, '종류', 'kind');
    if (kindPick.key === 'ko') koKeys++;
    else if (kindPick.key === 'en') enKeys++;
    const kind = KIND_MAP[String(kindPick.v ?? '').trim()];
    if (!kind) continue;
    if (isTruthyValue(pick(fm, '대체됨', 'superseded').v)) continue;
    found.push({ rel, title, kind, fm, content: parsed.content ?? '' });
  }

  // --- 대상 조립 ---
  const titleCount = new Map();
  for (const f of found) titleCount.set(f.title, (titleCount.get(f.title) ?? 0) + 1);
  const idOf = (f) => (titleCount.get(f.title) > 1 ? f.rel : f.title);

  const projects = [];
  const plans = [];
  for (const f of found) {
    const status = pick(f.fm, '상태', 'status').v;
    const t = {
      id: idOf(f),
      path: f.rel,
      name: (f.title.replace(PREFIX_RE, '') || f.title).normalize('NFC'),
      kind: f.kind,
      parent: unlink(pick(f.fm, '상위', 'parent').v),
      status: status == null ? undefined : String(status),
      active: status == null ? true : !INACTIVE_STATUS.has(String(status).trim()),
      aliases: toList(pick(f.fm, '별칭', 'aliases').v).slice(0, caps.names).map((s) => clip(s, caps.name_chars)),
      deprecated_names: toList(pick(f.fm, '폐기명', 'deprecated_names').v)
        .slice(0, caps.names)
        .map((s) => clip(s, caps.name_chars)),
      tokens: [],
      // 내부용(파일에 안 씀)
      _folder: null,
      _title: f.title,
      _content: f.content,
    };
    const dir = path.posix.dirname(f.rel);
    // 대상 노트가 제 폴더(W##/P##_x/P##_x.md) 안에 있을 때만 그 폴더를 "안쪽"으로 본다.
    // 워크스페이스 바로 아래 놓인 노트는 폴더가 워크스페이스 전체라 고유도 근거로 못 쓴다 → 노트 자신만.
    t._folder = dir.includes('/') ? dir + '/' : null;
    (f.kind === 'project' ? projects : plans).push(t);
  }
  const projectById = new Map(projects.map((p) => [p.id, p]));
  for (const pl of plans) {
    if (pl.parent && projectById.has(pl.parent)) continue;
    // 상위가 없거나 모르는 값이면 폴더로 찾는다(기획 폴더의 상위 폴더 = 프로젝트 폴더).
    const owner = projects.find((p) => p._folder && pl.path.startsWith(p._folder));
    if (owner) pl.parent = owner.id;
  }
  // 범위 문구 — 기획 목록 절의 불릿 중 기획을 가리키는 줄은 그 기획 대상의 scope로, 나머지는 프로젝트 scope로.
  // 후보 블록은 `· {기획 id} — {기획 scope[0]}`로 조립한다(기획 id를 두 번 싣지 않아 크기가 준다).
  // 절이 없으면(계획 §2-1: 실측 30개 중 14개) 기획 대상 목록(parent = 프로젝트) 자체가 제목 목록 폴백이다.
  for (const p of projects) {
    const sec = extractPlanScope(p._content);
    if (!sec) continue;
    const mine = plans.filter((pl) => pl.parent === p.id);
    const free = [];
    for (const bullet of sec) {
      const { link, desc } = splitScopeBullet(bullet);
      const pl = link ? mine.find((x) => x._title === link) : undefined;
      if (pl) {
        if (desc && !pl.scope) pl.scope = [clip(desc, caps.scope_chars)];
      } else if (desc || link) {
        free.push(clip(link && !desc ? link : (link ? `${link} — ${desc}` : desc), caps.scope_chars));
      }
    }
    if (free.length) p.scope = free.slice(0, caps.scope_items);
  }

  // --- 통계 모수: 낱말 줄기 사전 + 게시 목록 (+ ① 여러 낱말 이름 표본을 같은 순회에서) ---
  const N = notes.length;
  const smallVault = N < params.small_vault_notes;
  const vocab = new Map(); // 줄기(소문자) → id
  const vocabList = [];
  const postings = []; // id → 노트 번호 배열
  const nameSample = new Map(); // project id → 표본 수
  const multi = []; // 여러 낱말 이름
  for (const p of projects) {
    const ws = nameWords(p.name);
    if (ws.length > 1) multi.push({ p, keys: ws.map(toKeys) });
    nameSample.set(p.id, 0);
  }
  const byFirst = new Map();
  for (const m of multi) {
    const arr = byFirst.get(m.keys[0]) ?? [];
    arr.push(m);
    byFirst.set(m.keys[0], arr);
  }
  for (let ni = 0; ni < N; ni++) {
    const cleaned = cleanForMatch(notes[ni].text);
    notes[ni].text = null; // 본문은 여기서 놓는다(이후엔 경로만 쓴다)
    const words = tokenizeWords(cleaned);
    const seen = new Set();
    for (const w of words) {
      for (const stem of stemsOf(w.text)) {
        const s = stem.toLowerCase();
        let id = vocab.get(s);
        if (id === undefined) {
          id = vocabList.length;
          vocab.set(s, id);
          vocabList.push(s);
          postings.push([]);
        }
        if (!seen.has(id)) {
          seen.add(id);
          postings[id].push(ni);
        }
      }
    }
    if (!byFirst.size) continue;
    const hitIds = new Set();
    for (let i = 0; i < words.length; i++) {
      const cand = byFirst.get(toKeys(words[i].text.toLowerCase()));
      if (!cand) continue;
      for (const m of cand) {
        if (hitIds.has(m.p.id)) continue;
        const n = m.keys.length;
        if (i + n > words.length) continue;
        let ok = true;
        for (let k = 1; k < n && ok; k++) {
          if (!isNameGap(cleaned, words[i + k - 1], words[i + k])) ok = false;
          else if (k < n - 1 && toKeys(words[i + k].text.toLowerCase()) !== m.keys[k]) ok = false;
          else if (k === n - 1 && !stemsOf(words[i + k].text).some((st) => toKeys(st.toLowerCase()) === m.keys[k])) ok = false;
        }
        if (ok) hitIds.add(m.p.id);
      }
    }
    for (const id of hitIds) nameSample.set(id, (nameSample.get(id) ?? 0) + 1);
  }
  const insideCount = (id, folders, selfPaths) => {
    let n = 0;
    for (const ni of postings[id]) {
      const rel = notes[ni].rel;
      if (folders.some((f) => rel.startsWith(f)) || selfPaths.includes(rel)) n++;
    }
    return n;
  };
  const ownerScope = (ts) => ({
    folders: ts.map((t) => t._folder).filter(Boolean),
    selfPaths: ts.filter((t) => !t._folder).map((t) => t.path),
  });

  // --- ① 정식 이름 표본(한 낱말 이름은 줄기 게시 목록에서) ---
  for (const p of projects) {
    const ws = nameWords(p.name);
    if (ws.length === 1) {
      const id = vocab.get(ws[0]);
      nameSample.set(p.id, id === undefined ? 0 : postings[id].length);
    }
  }
  for (const p of projects) {
    if ((nameSample.get(p.id) ?? 0) < params.sample_min) p.name_exact_only = true;
  }

  // --- ③④ 토큰: 세 조건 ---
  const tokenOwners = new Map();
  for (const p of projects) {
    for (const w of nameWords(p.name)) {
      if (w.length < 2 || /^\d+$/.test(w)) continue;
      const arr = tokenOwners.get(w) ?? [];
      if (!arr.includes(p)) arr.push(p);
      tokenOwners.set(w, arr);
    }
  }
  const tokenReport = [];
  const outsideMax = params.outside_max_ratio * N;
  for (const [tok, owners] of [...tokenOwners.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'))) {
    const id = vocab.get(tok);
    const total = id === undefined ? 0 : postings[id].length;
    const { folders, selfPaths } = ownerScope(owners);
    const inside = id === undefined ? 0 : insideCount(id, folders, selfPaths);
    const outside = total - inside;
    const uniq = total ? inside / total : 0;
    const reasons = [];
    if (total < params.sample_min) reasons.push('sample');
    if (uniq < params.uniqueness_min) reasons.push('uniqueness');
    if (outside > outsideMax) reasons.push('outside');
    const pass = reasons.length === 0;
    tokenReport.push({ token: tok, owners: owners.map((o) => o.id), total, inside, outside, uniqueness: Number(uniq.toFixed(3)), pass, reasons });
    if (pass) for (const o of owners) if (o.tokens.length < caps.tokens) o.tokens.push(tok);
  }

  // --- 혼동어 안전망 ---
  // 근접을 허용하는 한 낱말 이름마다, 모수 어휘 중 키 나열이 허용 거리 안인 다른 표기를 찾아
  // "소유 폴더 밖 3건 이상 & 밖 비율 50% 이상"이면 다른 낱말로 적는다. ②층에 등록된 표기 그대로는 제외.
  const terms = [];
  const registered = new Map(); // target id → Set(②층 표기)
  for (const t of [...projects, ...plans]) {
    const reg = new Set([...t.aliases, ...t.deprecated_names].map(normalizeNameSurface));
    registered.set(t.id, reg);
    for (const raw of [...t.aliases, ...t.deprecated_names]) {
      const ws = nameWords(raw);
      if (ws.length !== 1) continue;
      terms.push({ surface: ws[0], owners: [t], via: 'registered', fuzzy: true });
    }
    if (t.kind !== 'project') continue;
    const nws = nameWords(t.name);
    if (nws.length === 1) terms.push({ surface: nws[0], owners: [t], via: 'name', fuzzy: !smallVault && !t.name_exact_only && hasHangul(nws[0]) });
  }
  const passedTokens = new Map();
  for (const r of tokenReport) if (r.pass) passedTokens.set(r.token, r.owners.map((id) => projectById.get(id)));
  for (const [tok, owners] of passedTokens) terms.push({ surface: tok, owners, via: 'token', fuzzy: !smallVault && hasHangul(tok) });

  const vocabKeysByLen = new Map();
  for (let id = 0; id < vocabList.length; id++) {
    const k = toKeys(vocabList[id]);
    if (!k) continue;
    const arr = vocabKeysByLen.get(k.length) ?? [];
    arr.push([id, k]);
    vocabKeysByLen.set(k.length, arr);
  }
  const confusableMap = new Map(); // 표기 → { ids:Set, outside, total, near }
  const confReport = [];
  for (const term of terms) {
    if (!term.fuzzy) continue;
    const tk = toKeys(term.surface);
    const md = maxDistanceForKeyLen(tk.length);
    if (md === 0) continue;
    const { folders, selfPaths } = ownerScope(term.owners);
    for (let len = tk.length - md; len <= tk.length + md; len++) {
      for (const [id, k] of vocabKeysByLen.get(len) ?? []) {
        const surface = vocabList[id];
        if (surface === term.surface) continue;
        if (isAffixExtension(k, tk)) continue; // 합성어는 애초에 근접 일치하지 않는다
        if (osaDistance(k, tk, md) > md) continue;
        // 이름 + 조사 그대로인 낱말(`세컨드브레인이`)은 줄기가 이미 정확 일치하므로 혼동어가 아니다.
        if (stemsOf(surface).includes(term.surface)) continue;
        if (term.owners.some((o) => registered.get(o.id)?.has(surface))) continue;
        const total = postings[id].length;
        const inside = insideCount(id, folders, selfPaths);
        const outside = total - inside;
        if (outside >= params.confusable_outside_min && outside / total >= params.confusable_outside_ratio) {
          const ent = confusableMap.get(surface) ?? { ids: new Set(), outside, total, near: term.surface };
          for (const o of term.owners) ent.ids.add(o.id);
          confusableMap.set(surface, ent);
          confReport.push({ surface, near: term.surface, owners: term.owners.map((o) => o.id), total, outside });
        }
      }
    }
  }
  const confusablesAll = [...confusableMap.entries()].sort((a, b) => b[1].outside - a[1].outside || a[0].localeCompare(b[0], 'ko'));

  // --- 색인 대조(F02) ---
  let indexFound = false;
  const indexPaths = new Set();
  try {
    const idx = JSON.parse(await fs.readFile(path.join(vaultRoot, 'WORKS_INDEX.json'), 'utf8'));
    for (const it of Array.isArray(idx.items) ? idx.items : []) if (it && it.path) indexPaths.add(String(it.path).normalize('NFC'));
    indexFound = true;
  } catch {
    /* 색인 없음 */
  }
  const allTargets = [...projects, ...plans];
  const indexMissing = indexFound ? allTargets.filter((t) => !indexPaths.has(t.path)).length : allTargets.length;

  // --- 커버리지 ---
  const active = projects.filter((p) => p.active);
  const aliasNeeded = active
    .filter((p) => !p.aliases.length && !p.deprecated_names.length && !p.tokens.length && nameWords(p.name).length >= 2)
    .map((p) => p.id);

  const sourceKeys = koKeys && enKeys ? 'mixed' : koKeys ? 'ko' : enKeys ? 'en' : 'en';
  const builtFrom = process.env.GITHUB_SHA || (await readGitHead(vaultRoot)) || 'unknown';

  const sortTargets = (a, b) => a.id.localeCompare(b.id, 'ko');
  projects.sort(sortTargets);
  plans.sort(sortTargets);

  const projectPathOf = (id) => projectById.get(id)?.path;
  const trimmed = [];
  // 파일 형식: 기획은 소속 프로젝트 행의 `plans` 안에 둔다(기획마다 kind·parent를 되풀이하지 않아 기획당 ~50바이트 절약).
  // 워커 로더(routing-dict.ts parseRoutingDict)가 평평한 RoutingTarget[]로 펼친다. 소속을 못 찾은 기획만 최상위 행.
  const build = (scopeChars, confCap, withPlans) => {
    const common = (t, o) => {
      if (t.status !== undefined) o.status = t.status;
      if (!t.active) o.active = false;
      if (t.scope && t.scope.length && scopeChars > 0) o.scope = t.scope.map((x) => clip(x, scopeChars));
      // 빈 배열은 싣지 않는다(크기) — 워커 로더가 []로 채운다.
      if (t.aliases.length) o.aliases = t.aliases;
      if (t.deprecated_names.length) o.deprecated_names = t.deprecated_names;
      if (t.tokens.length) o.tokens = t.tokens;
      if (t.name_exact_only) o.name_exact_only = true;
      return o;
    };
    // 생략 규칙(로더가 같은 규칙으로 채운다): name — id에서 접두를 뗀 값과 같으면 생략(deriveName)
    //   · 기획 path — `프로젝트 폴더/기획 id/기획 id.md`면 생략(derivePlanPath)
    //   · active — true면 생략
    const planOut = (t, projPath) => {
      const o = { id: t.id };
      if (derivePlanPath(t.id, projPath) !== t.path) o.path = t.path;
      if (t.name !== deriveName(t.id)) o.name = t.name;
      return common(t, o);
    };
    const targets = [];
    for (const p of projects) {
      const o = { id: p.id, path: p.path };
      if (p.name !== deriveName(p.id)) o.name = p.name;
      o.kind = 'project';
      if (p.parent) o.parent = p.parent;
      common(p, o);
      if (withPlans) {
        const kids = plans.filter((pl) => pl.parent === p.id).map((pl) => planOut(pl, p.path));
        if (kids.length) o.plans = kids;
      }
      targets.push(o);
    }
    if (withPlans) {
      for (const pl of plans) {
        if (pl.parent && projectById.has(pl.parent)) continue;
        const o = { id: pl.id, path: pl.path };
        if (pl.name !== deriveName(pl.id)) o.name = pl.name;
        o.kind = 'plan';
        if (pl.parent) o.parent = pl.parent;
        targets.push(common(pl, o));
      }
    }
    const confusables = {};
    for (const [s, ent] of confusablesAll.slice(0, confCap)) confusables[s] = [...ent.ids].sort();
    return {
      format: FORMAT,
      generator_version: GENERATOR_VERSION,
      built_from: builtFrom,
      source_keys: sourceKeys,
      targets_count: projects.length + (withPlans ? plans.length : 0),
      index_missing: indexMissing,
      index_found: indexFound,
      notes_total: N,
      small_vault: smallVault,
      coverage: {
        active_projects: active.length,
        named_projects: active.filter((p) => nameWords(p.name).length > 0).length,
        alias_needed: aliasNeeded.slice(0, caps.alias_needed),
        ...(aliasNeeded.length > caps.alias_needed ? { alias_needed_total: aliasNeeded.length } : {}),
      },
      ...(trimmed.length ? { trimmed: [...trimmed] } : {}),
      confusables,
      targets,
    };
  };
  let dict = build(caps.scope_chars, caps.confusables, true);
  // 예산 사다리: 설명 문구 → 혼동어 → 설명 제거 → 기획 제거 순으로 줄인다. 매칭에 쓰는 이름(①②③④)은 줄이지 않는다.
  const ladder = [
    ['scope_24', () => build(24, caps.confusables, true)],
    ['confusables_50', () => build(24, 50, true)],
    ['scope_0', () => build(0, 50, true)],
    ['plans_dropped', () => build(0, 50, false)],
  ];
  for (const [label, next] of ladder) {
    if (Buffer.byteLength(serializeDict(dict)) <= caps.budget_bytes) break;
    trimmed.push(label);
    dict = next();
  }

  const report = {
    notes_total: N,
    parse_fail: parseFail,
    projects: projects.length,
    plans: plans.length,
    name_sample: Object.fromEntries(nameSample),
    tokens: tokenReport,
    confusables: confReport,
    confusables_total: confusablesAll.length,
  };
  return { dict, report };
}

/**
 * 직렬화 — 대상 하나에 한 줄(diff가 읽히게) + 나머지는 압축. 유효한 JSON이다.
 */
export function serializeDict(dict) {
  const { targets, ...head } = dict;
  const headJson = JSON.stringify(head);
  const body = targets.map((t) => JSON.stringify(t)).join(',\n');
  return `${headJson.slice(0, -1)},"targets":[\n${body}\n]}\n`;
}

function defaultVaultRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vault') out.vault = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultRoot = path.resolve(args.vault ?? defaultVaultRoot());
  const outPath = path.resolve(args.out ?? path.join(vaultRoot, 'ROUTING_INDEX.json'));
  const { dict, report } = await buildRoutingIndex({ vaultRoot });
  const text = serializeDict(dict);
  await fs.writeFile(outPath, text);
  console.log(
    `✅ ROUTING_INDEX.json: ${dict.targets_count} targets (projects ${report.projects}, plans ${report.plans}) · notes ${report.notes_total} · index_missing ${dict.index_missing} · ${Buffer.byteLength(text)} bytes${dict.trimmed ? ` · trimmed ${dict.trimmed.join(',')}` : ''}`,
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
    // 사전 실패가 META·코퍼스 커밋을 막지 않게 종료 코드 0. 게이트는 사전이 없으면 무발동이다.
    console.warn(`⚠️ build-routing-index skipped: ${e && e.message ? e.message : String(e)}`);
  });
}
