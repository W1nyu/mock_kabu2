/**
 * Korean particle agreement.
 *
 * Which particle follows a word depends on whether its last syllable ends in a
 * consonant (받침). Slot values are sampled at runtime, so a template cannot
 * hard-code "를" — "모의전자를" is right but "카부증권를" is not. Templates
 * write the particle as its own placeholder ({name}{를}) and it is resolved
 * against whatever text was just emitted.
 */

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JONGSEONG_COUNT = 28;
/** Jongseong index of ㄹ, which 로/으로 treats as if there were no 받침. */
const RIEUL_JONGSEONG = 8;

/** Final consonant of the last Korean syllable, or null when there is none. */
function finalJongseong(text: string): number | null {
  for (let i = text.length - 1; i >= 0; i--) {
    const code = text.codePointAt(i);
    if (code === undefined) continue;

    if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
      return (code - HANGUL_BASE) % JONGSEONG_COUNT;
    }
    if (code >= 0x30 && code <= 0x39) {
      // Read the digit aloud: 일·삼·육·칠·팔·공 end in a consonant.
      return [1, 1, 0, 1, 0, 0, 1, 1, 1, 0][code - 0x30] === 1 ? 1 : 0;
    }
    // Skip punctuation and spacing, but stop at anything else (Latin, symbols)
    // and treat it as open — these appear only inside quoted product names.
    if (/[\s.,'"·…()%]/u.test(text[i])) continue;
    return 0;
  }
  return null;
}

export type ParticleKey = "를" | "과" | "가" | "는" | "로";

/** With 받침 → first form, without → second. */
const PARTICLE_FORMS: Record<ParticleKey, readonly [string, string]> = {
  를: ["을", "를"],
  과: ["과", "와"],
  가: ["이", "가"],
  는: ["은", "는"],
  로: ["으로", "로"],
};

export function isParticleKey(key: string): key is ParticleKey {
  return key in PARTICLE_FORMS;
}

export function resolveParticle(key: ParticleKey, precedingText: string): string {
  const [closed, open] = PARTICLE_FORMS[key];
  const jongseong = finalJongseong(precedingText);
  if (jongseong === null || jongseong === 0) return open;
  // 로 is the only particle that treats a ㄹ ending as open ("서울로", not "서울으로").
  if (key === "로" && jongseong === RIEUL_JONGSEONG) return open;
  return closed;
}
