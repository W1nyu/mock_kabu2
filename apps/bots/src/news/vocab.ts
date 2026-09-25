import type { SectorTag, VocabKey } from "./types";

/**
 * Brokerage and counterparty names are invented. A mock exchange should never
 * put a real firm's name next to a fabricated 목표주가 or 횡령 headline.
 */
export const GLOBAL_VOCAB: Readonly<Record<VocabKey, readonly string[]>> = {
  broker: [
    "한빛증권",
    "대명증권",
    "태산증권",
    "금강투자증권",
    "서화증권",
    "백두증권",
    "청람증권",
    "무궁화증권",
    "온누리투자증권",
    "해동증권",
  ],
  inst: ["국민연금", "국내 대형 자산운용사", "외국계 헤지펀드", "사모펀드 운용사", "연기금"],
  // Enforcement bodies — fines, investigations, disclosure penalties.
  agency: ["금융당국", "공정당국", "국세청", "거래소", "환경당국", "산업안전당국"],
  // Bodies that certify a product. Kept apart from `agency` so a tax office
  // never ends up approving a semiconductor.
  certifier: ["국가기술표준원", "국제인증기관", "환경당국", "산업안전당국", "해외 규제당국"],
  rating: ["대한신용평가", "서울신용평가", "한백신용평가"],
  country: [
    "미국",
    "유럽",
    "일본",
    "중동",
    "동남아",
    "인도",
    "브라질",
    "폴란드",
    "캐나다",
    "호주",
    "베트남",
    "사우디아라비아",
    "대만",
    "멕시코",
  ],
  // Region-neutral on purpose: these are rendered after a {country} slot, so a
  // built-in region would produce "폴란드 북미 데이터센터 사업자".
  counterparty: [
    "완성차 A사",
    "데이터센터 사업자",
    "국영에너지사",
    "대형 선사",
    "종합상사",
    "빅테크 기업",
    "대기업 계열사",
    "전력 공기업",
    "반도체 장비사",
  ],
  product: ["신규 주력 제품", "차세대 플랫폼", "핵심 부품"],
  title: ["대표이사", "최고재무책임자", "사내이사", "최대주주", "창업주"],
  index: ["대표지수", "글로벌 신흥국지수", "배당성장지수", "반도체 테마지수"],
  grade: ["A+", "A", "A−", "BBB+", "BBB", "BBB−", "BB+"],
  plant: ["본사", "제1공장"],
  commodity: ["구리", "니켈", "철광석", "알루미늄", "리튬", "아연", "천연가스", "석탄"],
  centralBank: ["미국 연준", "유럽중앙은행", "일본은행", "영란은행"],
  region: ["중국", "유럽", "미국", "일본", "신흥국", "동남아"],
};

/**
 * Sector-scoped overrides. `product` is the single biggest driver of variety —
 * a heavy-industry order and an electronics order must not read alike.
 */
export const SECTOR_VOCAB: Readonly<
  Partial<Record<SectorTag, Partial<Record<VocabKey, readonly string[]>>>>
> = {
  ELECTRONICS: {
    product: [
      "고대역폭 메모리",
      "차세대 낸드",
      "전력반도체",
      "차량용 이미지센서",
      "AI 가속기 모듈",
      "마이크로 디스플레이",
      "첨단 패키징 공정",
    ],
  },
  HEAVY: {
    product: [
      "LNG 운반선",
      "초대형 컨테이너선",
      "해상풍력 하부구조물",
      "소형모듈원자로",
      "가스터빈",
      "암모니아 추진선",
      "부유식 생산설비",
    ],
  },
  MATERIALS: {
    product: [
      "이차전지 분리막",
      "고순도 실리콘",
      "친환경 포장소재",
      "특수화학 원료",
      "전해질 첨가제",
      "바이오 소재",
    ],
  },
  TRADING: {
    product: [
      "리튬 정광",
      "곡물 터미널",
      "친환경 연료 중개",
      "니켈 광산 지분",
      "해외 물류 허브",
      "구리 정련 사업",
    ],
  },
  BROKER: {
    product: [
      "디지털자산 수탁 서비스",
      "발행어음 사업",
      "초대형 IB 인가",
      "해외주식 플랫폼",
      "퇴직연금 플랫폼",
    ],
  },
  BIO: {
    product: ["차세대 항암 신약", "자가면역 치료제", "항체-약물 접합체", "경구용 대사질환 치료제"],
  },
  FOOD: {
    product: ["저당 음료 라인업", "간편식 브랜드", "프리미엄 빙과", "식물성 단백질 식품", "해외 전용 스낵", "건강기능식품"],
  },
  AIRLINE: {
    product: ["장거리 신규 노선", "화물 전용기", "차세대 협동체 항공기", "지속가능 항공유", "항공 정비 사업", "저비용 자회사"],
  },
  TELECOM: {
    product: ["5G 단독모드망", "기업용 클라우드", "위성 인터넷 서비스", "AI 데이터센터", "알뜰폰 요금제", "해저 케이블"],
  },
  GAME: {
    product: ["신작 MMORPG", "모바일 수집형 RPG", "콘솔 액션 게임", "글로벌 퍼블리싱 계약", "e스포츠 리그", "클라우드 게임 서비스"],
  },
  SEMICONDUCTOR: {
    product: ["3나노 파운드리 공정", "HBM 패키징", "AI 추론 칩", "차량용 반도체", "전력 반도체", "EUV 공정 라인"],
  },
  CONSTRUCTION: {
    product: ["모듈러 주택", "도심 재개발 사업", "GTX 역세권 단지", "해상풍력 기초 구조물", "스마트 건설 로봇", "제로에너지 아파트"],
  },
  AUTO: {
    product: ["전기 SUV", "하이브리드 세단", "자율주행 레벨3 시스템", "수소 트럭", "소형 전기차 플랫폼", "차량용 OS"],
  },
  ENTERTAINMENT: {
    product: ["신인 보이그룹", "월드투어", "팬 플랫폼 앱", "버추얼 아이돌", "글로벌 음원 유통 계약", "드라마 OST 제작"],
  },
  BATTERY: {
    product: ["46파이 원통형 배터리", "전고체 배터리", "LFP 배터리 셀", "ESS 배터리 팩", "배터리 재활용 공정", "고니켈 파우치 셀"],
  },
};

export function vocabList(key: VocabKey, sector: SectorTag | null): readonly string[] {
  const scoped = sector ? SECTOR_VOCAB[sector]?.[key] : undefined;
  return scoped ?? GLOBAL_VOCAB[key];
}
