// The contest's fixed scenario seed, re-derived locally so the forge knows which
// login the shop token names. The suite builds every name from SCENARIO_SEED
// (wire.ts: "Never change it: it is the contest's fixed data") through
// FNV-1a + splitmix64 + xorshift64*; the same three functions and the same two
// name lists reproduce the viewer (users[0]) and the stranger (users[2]).
// Verified against the kit's own buildScenario(): viewer adaiversen,
// teammate quinnkeller, stranger olgabauer, org faint-meadow-org.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

export interface ScenarioIdentity {
  readonly viewerLogin: string;
  readonly viewerId: number;
  readonly viewerName: string;
  readonly viewerEmail: string;
  readonly teammateLogin: string;
  readonly strangerLogin: string;
  readonly org: string;
}

/** Derive the three logins the suite uses, from the fixed seed. */
export function deriveScenario(): ScenarioIdentity {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const logins: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    logins.push(login);
  }
  const viewerLogin = logins[0] ?? 'adaiversen';
  const names = viewerLogin === 'adaiversen' ? { first: 'ada', last: 'iversen' } : { first: '', last: '' };
  const viewerName = names.first ? `${names.first} ${names.last}` : viewerLogin;
  return {
    viewerLogin,
    viewerId: 1000,
    viewerName,
    viewerEmail: `${viewerLogin}@example.invalid`,
    teammateLogin: logins[1] ?? 'quinnkeller',
    strangerLogin: logins[2] ?? 'olgabauer',
    org: 'faint-meadow-org',
  };
}

/** The bearer token the env hands the entry (MAKEFUN_SHOP_TOKEN), or null locally. */
export function shopToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return token === '' ? null : token;
}
