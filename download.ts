import { createHash } from "crypto";
import { appendFileSync, existsSync, readFileSync } from "fs";

const DSERVER = "https://dserver.bundestag.de";
const API_BASE = "https://search.dip.bundestag.de/api/v1";
const API_KEY = "OSOegLs.PR2lwJ1dwCeje9vTj7FPOt3hvpYKtwKkhw";
const JSONL = "./data/kommentare.jsonl";
const MAX_CONCURRENT = 5;

// --- Load already-downloaded sessions to skip ---

function loadExisting(): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(JSONL)) return seen;
  for (const line of readFileSync(JSONL, "utf-8").trim().split("\n")) {
    if (!line) continue;
    const d = JSON.parse(line);
    seen.add(`${d.wp}/${d.session}`);
  }
  return seen;
}

// --- Enodia PoW solver ---

function solvePoW(challenge: string): number {
  let sol = 0;
  while (true) {
    const hash = createHash("sha256").update(challenge + sol).digest("hex");
    if (hash.substring(0, 4) === "0000") return sol;
    sol++;
  }
}

async function getEnodiaSession(host: string): Promise<string> {
  // Step 1: hit any URL to get the challenge
  const res = await fetch(`${host}/btp/20/20001.xml`, { redirect: "follow" });
  const html = await res.text();

  // Extract the challenge envelope from window.chl
  const m = html.match(/window\.chl\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("No challenge found");

  const envelope = m[1];
  const payload = JSON.parse(atob(envelope.split(".")[0]));

  if (payload.content.provider !== "pow") {
    throw new Error(`Unsupported challenge: ${payload.content.provider}`);
  }

  const challenge = payload.content.challenge;
  console.log(`Solving PoW challenge: ${challenge}`);
  const solution = solvePoW(challenge);
  console.log(`Solution: ${solution}`);

  // Step 2: Submit solution
  const verifyRes = await fetch(`${host}/.enodia/verify`, {
    method: "POST",
    body: `${solution}-${envelope}`,
  });

  if (!verifyRes.ok) {
    throw new Error(`Verify failed: ${verifyRes.status}`);
  }

  const cookie = await verifyRes.text();
  console.log(`Got enodia cookie: ${cookie.substring(0, 20)}...`);
  return cookie;
}

// --- HTTP with enodia cookie ---

let enodiaCookie: string | null = null;

async function fetchWithAuth(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!enodiaCookie) {
      const host = new URL(url).origin;
      enodiaCookie = await getEnodiaSession(host);
    }

    const res = await fetch(url, {
      headers: { Cookie: `enodia=${enodiaCookie}` },
      redirect: "manual",
    });

    if (res.status === 303) {
      const location = res.headers.get("location") || "";
      if (location.includes(".enodia/challenge")) {
        console.log("Cookie expired, re-solving...");
        enodiaCookie = null;
        continue;
      }
    }

    return res;
  }
  throw new Error(`Failed after retries: ${url}`);
}

// --- Extract ---

function extractFromXml(xml: string): string[] {
  return [...xml.matchAll(/<kommentar>([\s\S]*?)<\/kommentar>/g)].map((m) => m[1].trim());
}

function extractFromText(text: string): string[] {
  const results: string[] = [];
  for (const m of text.matchAll(/\(([^)]{5,500})\)/g)) {
    const inner = m[1];
    if (
      /^(Beifall|Heiterkeit|Gelächter|Lachen|Zuruf|Zurufe|Widerspruch|Unruhe|Lebhafter|Anhaltender|Vereinzelt|Starker|Großer|Langanhaltender|Stürmischer|Abg\.|Dr\.)/.test(inner) ||
      /^\S+\s+\[[A-ZÄÖÜ]/.test(inner)
    ) {
      results.push(`(${inner})`);
    }
  }
  return results;
}

function extractDate(content: string): string | null {
  const m = content.match(/sitzung-datum="(\d{2})\.(\d{2})\.(\d{4})"/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// --- Concurrency ---

function pooled<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results: T[] = new Array(tasks.length);
    let next = 0;
    let active = 0;
    let done = 0;
    if (tasks.length === 0) return resolve([]);

    function run() {
      while (active < concurrency && next < tasks.length) {
        const idx = next++;
        active++;
        tasks[idx]()
          .then((r) => {
            results[idx] = r;
            active--;
            done++;
            if (done === tasks.length) resolve(results);
            else run();
          })
          .catch(reject);
      }
    }
    run();
  });
}

// --- Get protocol list from DIP API ---

interface Proto { wp: number; session: number; date: string; nr: string; }

async function listProtocols(wp: number): Promise<Proto[]> {
  const protocols: Proto[] = [];
  let cursor: string | undefined;
  while (true) {
    let url = `${API_BASE}/plenarprotokoll?apikey=${API_KEY}&f.wahlperiode=${wp}&f.herausgeber=BT&rows=100&format=json`;
    if (cursor) url += `&cursor=${cursor}`;
    const res = await fetchWithAuth(url);
    const data = await res.json();
    for (const doc of data.documents) {
      const nr: string = doc.dokumentnummer;
      if (!nr.includes("/")) continue;
      const [, sessStr] = nr.split("/");
      protocols.push({ wp, session: parseInt(sessStr), date: doc.datum, nr });
    }
    cursor = data.cursor;
    if (!cursor || data.documents.length === 0) break;
  }
  return protocols;
}

// --- Main ---

const existing = loadExisting();
console.log(`Already have ${existing.size} sessions in ${JSONL}`);

const WAHLPERIODEN = [14, 15, 16, 17, 18, 19, 20, 21];
// Parse CLI args to optionally filter WPs
const argWps = process.argv.slice(2).map(Number).filter(Boolean);
const wps = argWps.length ? argWps : WAHLPERIODEN;

let totalNew = 0;

for (const wp of wps) {
  console.log(`\n=== WP${wp} ===`);

  let protocols: Proto[];

  if (wp >= 18) {
    // For WP18+, we know the session range. Generate URLs directly.
    const maxSess = wp === 21 ? 100 : 300;
    protocols = [];
    for (let s = 1; s <= maxSess; s++) {
      if (existing.has(`${wp}/${s}`)) continue;
      protocols.push({ wp, session: s, date: "", nr: `${wp}/${s}` });
    }
  } else {
    // For older WPs, use the API to get the list
    console.log("Listing from API...");
    protocols = await listProtocols(wp);
    protocols = protocols.filter((p) => !existing.has(`${p.wp}/${p.session}`));
  }

  console.log(`${protocols.length} new sessions to download`);
  if (protocols.length === 0) continue;

  const tasks = protocols.map((proto) => async () => {
    try {
      let content: string;
      let kommentars: string[];
      let date = proto.date;

      if (wp >= 18) {
        const padded = String(wp).padStart(2, "0");
        const sessStr = String(proto.session).padStart(3, "0");
        const url = `${DSERVER}/btp/${wp}/${padded}${sessStr}.xml`;
        const res = await fetchWithAuth(url);
        if (!res.ok) return 0; // 404 = session doesn't exist
        content = await res.text();
        if (!content.includes("<kommentar>")) return 0;
        kommentars = extractFromXml(content);
        date = extractDate(content) || date;
      } else {
        const url = `${API_BASE}/plenarprotokoll-text?apikey=${API_KEY}&f.dokumentnummer=${encodeURIComponent(proto.nr)}&format=json`;
        const res = await fetchWithAuth(url);
        if (!res.ok) return 0;
        const data = await res.json();
        content = data.documents?.[0]?.text || "";
        if (!content) return 0;
        kommentars = extractFromText(content);
      }

      for (const k of kommentars) {
        appendFileSync(JSONL, JSON.stringify({ wp, session: proto.session, date, kommentar: k }) + "\n");
      }

      if (kommentars.length > 0) {
        process.stdout.write(`  ${proto.nr}(${date}):${kommentars.length} `);
      }
      return kommentars.length;
    } catch (e: any) {
      console.error(`\n  FAIL ${proto.nr}: ${e.message?.substring(0, 80)}`);
      return 0;
    }
  });

  const counts = await pooled(tasks, MAX_CONCURRENT);
  const wpNew = counts.reduce((a, b) => a + b, 0);
  totalNew += wpNew;
  console.log(`\nWP${wp} done: ${wpNew} new kommentars`);
}

console.log(`\n=== TOTAL: ${totalNew} new kommentars added ===`);
