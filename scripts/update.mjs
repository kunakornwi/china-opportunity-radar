import fs from "fs";
import Parser from "rss-parser";

// --- Config (อ่านจาก GitHub Actions Secrets/Env) ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY. Add it in GitHub: Settings → Secrets → Actions.");
  process.exit(1);
}

// Node 20+ มี fetch ในตัว; ถ้าใช้ Node ต่ำกว่านี้จะพัง
if (typeof fetch !== "function") {
  console.error("Global fetch is not available. Use Node 20+ in GitHub Actions.");
  process.exit(1);
}

const parser = new Parser({ timeout: 20000 });

// ✅ ใช้ชื่อเดียวกันทั้งไฟล์
const TRUSTED_RSS = [
  { name: "Reuters", url: "https://feeds.reuters.com/reuters/worldNews" },
  { name: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "Nikkei Asia", url: "https://asia.nikkei.com/rss/feed/nar" },
  { name: "SCMP", url: "https://www.scmp.com/rss/2/feed" }
];

const OUT = "radar.json";

// --- Helpers ---
function load() {
  if (!fs.existsSync(OUT)) {
    return { title: "China Opportunity Radar", updatedAt: new Date().toISOString(), items: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(OUT, "utf-8"));
  } catch {
    // ถ้าไฟล์เสียหาย ให้เริ่มใหม่
    return { title: "China Opportunity Radar", updatedAt: new Date().toISOString(), items: [] };
  }
}

function safeId(url) {
  return (url || "").replace(/[^a-z0-9]/gi, "_").slice(0, 120);
}

function seenSet(db) {
  return new Set((db.items || []).map(x => x.id));
}

async function callOpenAI(input) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      // บังคับให้ตอบเป็น JSON object
      text: { format: { type: "json_object" } }
    })
  });

  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);

  const data = await r.json();
  const txt = data.output?.[0]?.content?.[0]?.text || "{}";

  try {
    return JSON.parse(txt);
  } catch {
    // กันกรณีโมเดลตอบไม่เป็น JSON
    return {};
  }
}

async function toOpportunity({ title, url, content, sourceName }) {
  const prompt = `
คุณคือ "China Opportunity Radar" สำหรับคนไทยที่อยากหารายได้เสริม
งาน: จากข่าว/บทความด้านล่าง แปลงเป็น “โอกาสทำเงิน” ที่ทำได้จริงในไทย/ออนไลน์
ตอบเป็น JSON เท่านั้น ตามสคีมานี้:

{
  "title": "หัวข้อไทยแบบโอกาส",
  "category": "Product Trend | Business Model | AI Tool | Cross-border | Risk/Regulation",
  "summary": "สรุป 3-5 ประโยค แบบไม่เดา",
  "opportunity_score": 0,
  "risk_score": 0,
  "who_is_it_for": ["เหมาะกับใคร 2-4 ข้อ"],
  "how_to_start": ["ขั้นตอนเริ่ม 4-6 ข้อ แบบทำได้จริง"],
  "watch_out": ["ข้อควรระวัง 2-4 ข้อ"],
  "keywords": ["คีย์เวิร์ด 5-10 คำ"],
  "confidence": 0.0
}

กติกา:
- ถ้าไม่มี “ทางทำเงิน/ทางลงมือ” ให้ confidence ต่ำ และจัดเป็น Risk/Regulation หรือสรุปทั่วไป
- opportunity_score 0-10 และ risk_score 0-10
- ห้ามอ้างตัวเลข/ข้อเท็จจริงที่ไม่มีในเนื้อหา

SOURCE: ${sourceName}
TITLE: ${title}
URL: ${url}
CONTENT:
${(content || "").slice(0, 6500)}
`.trim();

  return callOpenAI(prompt);
}

function clamp0to10(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(10, x));
}

// --- Main ---
async function main() {
  const db = load();
  const seen = seenSet(db);
  const added = [];

  for (const src of TRUSTED_RSS) {
    let feed;
    try {
      feed = await parser.parseURL(src.url);
    } catch (e) {
      console.error("RSS fail:", src.name, e.message);
      continue;
    }

    for (const it of (feed.items || []).slice(0, 10)) {
      const link = it.link || it.guid;
      if (!link) continue;

      const id = safeId(link);
      if (!id || seen.has(id)) continue;

      const raw = (it.contentSnippet || it.content || it.summary || it.title || "").toString();

      let opp = {};
      try {
        opp = await toOpportunity({
          title: it.title || "",
          url: link,
          content: raw,
          sourceName: src.name
        });
      } catch (e) {
        console.error("AI fail:", src.name, e.message);
        continue;
      }

      // ✅ Quality gate
      const ok =
        typeof opp.summary === "string" && opp.summary.length >= 30 &&
        Array.isArray(opp.how_to_start) && opp.how_to_start.length >= 3 &&
        typeof opp.confidence === "number" && opp.confidence >= 0.2;

      if (!ok) continue;

      const item = {
        id,
        title: opp.title || (it.title || "").slice(0, 120),
        category: opp.category || "Product Trend",
        summary: opp.summary,
        opportunity_score: clamp0to10(opp.opportunity_score),
        risk_score: clamp0to10(opp.risk_score),
        who_is_it_for: Array.isArray(opp.who_is_it_for) ? opp.who_is_it_for : [],
        how_to_start: Array.isArray(opp.how_to_start) ? opp.how_to_start : [],
        watch_out: Array.isArray(opp.watch_out) ? opp.watch_out : [],
        keywords: Array.isArray(opp.keywords) ? opp.keywords : [],
        confidence: opp.confidence,
        date: it.isoDate || it.pubDate || new Date().toISOString(),
        sourceUrl: link,
        sources: [src.name]
      };

      added.push(item);
      seen.add(id);
    }
  }

  if (added.length) {
    db.items = [...added, ...(db.items || [])].slice(0, 250);
    db.updatedAt = new Date().toISOString();
  } else {
    // ต่อให้ไม่มีข่าวใหม่ ก็อัปเดตเวลาไว้เพื่อรู้ว่ารันแล้ว
    db.updatedAt = new Date().toISOString();
  }

  fs.writeFileSync(OUT, JSON.stringify(db, null, 2));
  console.log("Added:", added.length);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
