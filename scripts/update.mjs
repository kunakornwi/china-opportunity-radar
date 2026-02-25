import fs from "fs";
import Parser from "rss-parser";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const parser = new Parser({ timeout: 20000 });

// ✅ ใส่เฉพาะแหล่งที่คุณเชื่อถือ (แก้/เพิ่มได้)
const TRUSTED_RSS = [
  { name: "Reuters", url: "https://feeds.reuters.com/reuters/worldNews" },
  { name: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "Nikkei Asia", url: "https://asia.nikkei.com/rss/feed/nar" },
  { name: "SCMP", url: "https://www.scmp.com/rss/2/feed" }
];

const OUT = "radar.json";

function load() {
  if (!fs.existsSync(OUT)) return { title: "China Opportunity Radar", updatedAt: new Date().toISOString(), items: [] };
  return JSON.parse(fs.readFileSync(OUT, "utf-8"));
}
function safeId(url) { return url.replace(/[^a-z0-9]/gi, "_").slice(0, 120); }
function seenSet(db) { return new Set(db.items.map(x => x.id)); }

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
      text: { format: { type: "json_object" } }
    })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const txt = data.output?.[0]?.content?.[0]?.text || "{}";
  return JSON.parse(txt);
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

async function main() {
  const db = load();
  const seen = seenSet(db);
  let added = [];

  for (const src of TRUSTED_RSS) {
    let feed;
    try { feed = await parser.parseURL(src.url); }
    catch (e) { console.error("RSS fail", src.name, e.message); continue; }

    for (const it of (feed.items || []).slice(0, 10)) {
      const link = it.link || it.guid;
      if (!link) continue;
      const id = safeId(link);
      if (seen.has(id)) continue;

      const raw = (it.contentSnippet || it.content || it.summary || it.title || "").toString();

      let opp;
      try {
        opp = await toOpportunity({
          title: it.title || "",
          url: link,
          content: raw,
          sourceName: src.name
        });
      } catch (e) {
        console.error("AI fail", src.name, e.message);
        continue;
      }

      // ✅ Quality Gate (กันมั่ว)
      const ok =
        opp?.summary && opp.summary.length >= 30 &&
        Array.isArray(opp.how_to_start) && opp.how_to_start.length >= 3 &&
        typeof opp.confidence === "number" && opp.confidence >= 0.45;
      if (!ok) continue;

      const item = {
        id,
        title: opp.title || (it.title || "").slice(0, 120),
        category: opp.category || "Product Trend",
        summary: opp.summary,
        opportunity_score: Math.max(0, Math.min(10, Number(opp.opportunity_score || 0))),
        risk_score: Math.max(0, Math.min(10, Number(opp.risk_score || 0))),
        who_is_it_for: opp.who_is_it_for || [],
        how_to_start: opp.how_to_start || [],
        watch_out: opp.watch_out || [],
        keywords: opp.keywords || [],
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
    // เรียงใหม่ก่อน + จำกัดจำนวน
    db.items = [...added, ...db.items].slice(0, 250);
    db.updatedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(db, null, 2));
  }

  console.log("Added:", added.length);
}

main().catch(e => { console.error(e); process.exit(1); });
