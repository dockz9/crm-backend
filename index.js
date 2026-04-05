const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function parseDoc(doc) {
  const id = doc.name.split("/").pop();
  const fields = doc.fields || {};
  const parsed = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) parsed[k] = v.stringValue;
    else if (v.integerValue !== undefined) parsed[k] = v.integerValue;
    else if (v.doubleValue !== undefined) parsed[k] = v.doubleValue;
    else if (v.booleanValue !== undefined) parsed[k] = v.booleanValue;
    else if (v.arrayValue !== undefined) parsed[k] = (v.arrayValue.values || []).map(x => x.stringValue || "");
    else parsed[k] = null;
  }
  return { id, ...parsed };
}

async function firestoreList(col, pageSize = 50, pageToken = null) {
  let url = `${BASE}/${col}?pageSize=${pageSize}&key=${API_KEY}`;
  if (pageToken) url += `&pageToken=${pageToken}`;
  const res = await fetch(url);
  return res.json();
}

async function fetchAll(col) {
  let all = [];
  let pageToken = null;
  while (true) {
    const data = await firestoreList(col, 300, pageToken);
    if (data.documents) all = all.concat(data.documents.map(parseDoc));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    await new Promise(r => setTimeout(r, 50));
  }
  return all;
}

app.get("/", (req, res) => {
  res.json({ status: "Win This Moment! CRM backend is running", version: "2.0" });
});

app.get("/contacts", async (req, res) => {
  try {
    const { pageToken, limit = 50 } = req.query;
    const data = await firestoreList("contacts", Number(limit), pageToken || null);
    const contacts = (data.documents || []).map(parseDoc)
      .filter(c => c.firstName || c.lastName || (c.name && c.name !== c.company));
    res.json({ contacts, nextPageToken: data.nextPageToken || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/contacts/search", async (req, res) => {
  try {
    const { q, limit = 100 } = req.query;

    if (!q || q.trim().length < 2) {
      const data = await firestoreList("contacts", Number(limit));
      const contacts = (data.documents || []).map(parseDoc)
        .filter(c => c.firstName || c.lastName || (c.name && c.name !== c.company));
      return res.json({ contacts, total: contacts.length });
    }

    const query = q.toLowerCase();
    const matched = [];
    let pageToken = null;

    while (true) {
      const data = await firestoreList("contacts", 300, pageToken);
      if (!data.documents) break;
      for (const doc of data.documents) {
        const c = parseDoc(doc);
        if (!c.firstName && !c.lastName && (!c.name || c.name === c.company)) continue;
        if (
          c.firstName?.toLowerCase().includes(query) ||
          c.lastName?.toLowerCase().includes(query) ||
          c.name?.toLowerCase().includes(query) ||
          c.email?.toLowerCase().includes(query) ||
          c.company?.toLowerCase().includes(query) ||
          c.jobTitle?.toLowerCase().includes(query) ||
          c.metroArea?.toLowerCase().includes(query) ||
          c.industry?.toLowerCase().includes(query) ||
          c.importGroups?.toLowerCase().includes(query)
        ) {
          matched.push(c);
        }
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
      await new Promise(r => setTimeout(r, 30));
    }

    matched.sort((a, b) => (a.lastName || a.name || "").toLowerCase().localeCompare((b.lastName || b.name || "").toLowerCase()));
    res.json({ contacts: matched.slice(0, Number(limit)), total: matched.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/contacts/ai-search", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const sample = [];
    let pageToken = null;
    let loaded = 0;

    while (loaded < 5000) {
      const data = await firestoreList("contacts", 300, pageToken);
      if (!data.documents) break;
      for (const doc of data.documents) {
        const c = parseDoc(doc);
        if (!c.firstName && !c.lastName && (!c.name || c.name === c.company)) continue;
        sample.push({
          id: c.id,
          name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
          company: c.company || "",
          jobTitle: c.jobTitle || "",
          metroArea: c.metroArea || "",
          industry: c.industry || "",
          importGroups: c.importGroups || "",
          email: c.email || "",
          status: c.status || "",
        });
        loaded++;
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
      await new Promise(r => setTimeout(r, 30));
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `You are a CRM assistant. Based on this request: "${prompt}"
          
Find the best matching contacts. Return ONLY a JSON array of contact IDs, max 50.
Format: ["id1", "id2", ...]

Contacts:
${JSON.stringify(sample)}

Return ONLY the JSON array.`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "[]";
    const ids = JSON.parse(text.replace(/```json|```/g, "").trim());
    const results = sample.filter(c => ids.includes(c.id));
    res.json({ contacts: results, total: results.length, prompt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/dashboard/stats", async (req, res) => {
  try {
    const [emails, tasks, meetings] = await Promise.all([
      fetchAll("emails"),
      fetchAll("tasks"),
      fetchAll("meetings"),
    ]);

    const now = Date.now();
    const DAY = 86400000;
    const sentEmails = emails.filter(e => e.direction === "sent");
    const followUps = [];
    const seen = new Set();

    for (const sent of sentEmails) {
      const daysSince = Math.floor((now - new Date(sent.date).getTime()) / DAY);
      if (daysSince < 22) continue;
      const replied = emails.some(e =>
        e.contactId === sent.contactId &&
        e.direction === "received" &&
        new Date(e.date) > new Date(sent.date)
      );
      if (replied || seen.has(sent.contactId)) continue;
      seen.add(sent.contactId);
      followUps.push({ contactId: sent.contactId, subject: sent.subject, daysSince, emailId: sent.id });
    }

    res.json({
      totalEmails: emails.length,
      totalTasks: tasks.length,
      pendingTasks: tasks.filter(t => t.status === "pending").length,
      totalMeetings: meetings.length,
      upcomingMeetings: meetings.filter(m => m.status === "upcoming").length,
      followUps: followUps.slice(0, 20),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let companiesCache = null;
let companiesCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000;

app.get("/companies", async (req, res) => {
  try {
    const now = Date.now();
    if (companiesCache && (now - companiesCacheTime) < CACHE_TTL) {
      return res.json({ companies: companiesCache, total: companiesCache.length, cached: true });
    }

    const companyMap = {};
    let pageToken = null;

    while (true) {
      const data = await firestoreList("contacts", 300, pageToken);
      if (!data.documents) break;
      for (const doc of data.documents) {
        const c = parseDoc(doc);
        const co = c.company?.trim();
        if (!co) continue;
        if (!companyMap[co]) companyMap[co] = { name: co, contacts: [] };
        const hasName = c.firstName || c.lastName || (c.name && c.name !== co);
        if (hasName) companyMap[co].contacts.push({
          id: c.id,
          name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
          jobTitle: c.jobTitle || "",
          email: c.email || "",
          phone: c.phone || "",
        });
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
      await new Promise(r => setTimeout(r, 30));
    }

    const companies = Object.values(companyMap)
      .filter(co => co.contacts.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    companiesCache = companies;
    companiesCacheTime = now;

    res.json({ companies, total: companies.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let groupsCache = null;
let groupsCacheTime = 0;

app.get("/groups", async (req, res) => {
  try {
    const grpMap = {};
    let pageToken = null;
    while (true) {
      const data = await firestoreList("contacts", 300, pageToken);
      if (!data.documents) break;
      for (const doc of data.documents) {
        const c = parseDoc(doc);
        const gRaw = c.importGroups?.trim();
        if (!gRaw) continue;
        gRaw.split(",").map(g => g.trim()).filter(Boolean).forEach(g => {
          if (!grpMap[g]) grpMap[g] = [];
          grpMap[g].push({ id: c.id, name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim() });
        });
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
      await new Promise(r => setTimeout(r, 30));
    }
    res.json({ groups: grpMap });
  } catch (e) {
    res.status(500).json({ error: e.message });

    if (groupsCache && (Date.now() - groupsCacheTime) < CACHE_TTL) {
  return res.json({ groups: groupsCache, cached: true });
}
    groupsCache = grpMap;
groupsCacheTime = Date.now();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CRM backend running on port ${PORT}`));
