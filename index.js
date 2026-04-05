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

async function firestoreList(col, pageSize = 300, pageToken = null) {
  let url = `${BASE}/${col}?pageSize=${pageSize}&key=${API_KEY}`;
  if (pageToken) url += `&pageToken=${pageToken}`;
  const res = await fetch(url);
  return res.json();
}

async function fetchAll(col) {
  let all = [];
  let token = null;
  while (true) {
    const data = await firestoreList(col, 300, token);
    if (data.documents) all = all.concat(data.documents.map(parseDoc));
    if (!data.nextPageToken) break;
    token = data.nextPageToken;
    await new Promise(r => setTimeout(r, 50));
  }
  return all;
}

function isPersonContact(c) {
  return !!(c.firstName || c.lastName || (c.name && c.name !== c.company));
}

const CACHE_REFRESH_MS = 30 * 60 * 1000;

let cache = {
  contacts: [],
  companies: [],
  groups: {},
  lastLoaded: null,
  loading: false,
};

async function buildCache() {
  if (cache.loading) return;
  cache.loading = true;
  console.log("Building contact cache...");
  try {
    const allDocs = [];
    const companyMap = {};
    const grpMap = {};
    let token = null;

    while (true) {
      const data = await firestoreList("contacts", 300, token);
      if (!data.documents) break;

      for (const doc of data.documents) {
        const c = parseDoc(doc);

        const co = c.company?.trim();
        if (co) {
          if (!companyMap[co]) companyMap[co] = { name: co, contacts: [] };
          if (isPersonContact(c)) {
            companyMap[co].contacts.push({
              id: c.id,
              name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
              jobTitle: c.jobTitle || "",
              email: c.email || "",
              phone: c.phone || "",
              status: c.status || "",
            });
          }
        }

        const gRaw = c.importGroups?.trim();
        if (gRaw) {
          gRaw.split(",").map(g => g.trim()).filter(Boolean).forEach(g => {
            if (!grpMap[g]) grpMap[g] = [];
            grpMap[g].push({
              id: c.id,
              name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
              company: c.company || "",
              email: c.email || "",
              jobTitle: c.jobTitle || "",
              status: c.status || "",
            });
          });
        }

        if (isPersonContact(c)) allDocs.push(c);
      }

      if (!data.nextPageToken) break;
      token = data.nextPageToken;
      await new Promise(r => setTimeout(r, 30));
    }

    allDocs.sort((a, b) => {
      const aL = (a.lastName || a.name || "").toLowerCase();
      const bL = (b.lastName || b.name || "").toLowerCase();
      if (aL !== bL) return aL.localeCompare(bL);
      return (a.firstName || "").toLowerCase().localeCompare((b.firstName || "").toLowerCase());
    });

    cache.contacts = allDocs;
    cache.companies = Object.values(companyMap).filter(co => co.contacts.length > 0).sort((a, b) => a.name.localeCompare(b.name));
    cache.groups = grpMap;
    cache.lastLoaded = new Date();
    cache.loading = false;

    console.log(`Cache built: ${allDocs.length} contacts, ${cache.companies.length} companies, ${Object.keys(grpMap).length} groups`);
  } catch (e) {
    console.error("Cache build error:", e.message);
    cache.loading = false;
  }
}

buildCache();
setInterval(buildCache, CACHE_REFRESH_MS);

app.get("/", (req, res) => {
  res.json({
    status: "Win This Moment! CRM backend is running",
    version: "3.0",
    cache: {
      contacts: cache.contacts.length,
      companies: cache.companies.length,
      groups: Object.keys(cache.groups).length,
      lastLoaded: cache.lastLoaded,
      loading: cache.loading,
    }
  });
});

const PAGE_SIZE = 50;

app.get("/contacts", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || PAGE_SIZE;
    const start = page * limit;
    const contacts = cache.contacts.slice(start, start + limit);
    res.json({
      contacts,
      total: cache.contacts.length,
      page,
      totalPages: Math.ceil(cache.contacts.length / limit),
      hasNext: start + limit < cache.contacts.length,
      hasPrev: page > 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/contacts/search", (req, res) => {
  try {
    const { q, limit = 100 } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json({ contacts: cache.contacts.slice(0, Number(limit)), total: cache.contacts.length });
    }
    const query = q.toLowerCase();
    const matched = cache.contacts.filter(c =>
      c.firstName?.toLowerCase().includes(query) ||
      c.lastName?.toLowerCase().includes(query) ||
      c.name?.toLowerCase().includes(query) ||
      c.email?.toLowerCase().includes(query) ||
      c.company?.toLowerCase().includes(query) ||
      c.jobTitle?.toLowerCase().includes(query) ||
      c.metroArea?.toLowerCase().includes(query) ||
      c.industry?.toLowerCase().includes(query) ||
      c.importGroups?.toLowerCase().includes(query)
    );
    res.json({ contacts: matched.slice(0, Number(limit)), total: matched.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/contacts/ai-search", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const sample = cache.contacts.slice(0, 5000).map(c => ({
      id: c.id,
      name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      company: c.company || "",
      jobTitle: c.jobTitle || "",
      metroArea: c.metroArea || "",
      industry: c.industry || "",
      importGroups: c.importGroups || "",
      email: c.email || "",
      status: c.status || "",
    }));

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: `You are a CRM assistant. Based on this request: "${prompt}"\n\nFind the best matching contacts. Return ONLY a JSON array of contact IDs, max 50.\nFormat: ["id1", "id2", ...]\n\nContacts:\n${JSON.stringify(sample)}\n\nReturn ONLY the JSON array.` }]
      })
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "[]";
    const ids = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json({ contacts: cache.contacts.filter(c => ids.includes(c.id)), total: ids.length, prompt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/companies", (req, res) => {
  try {
    const { search } = req.query;
    let companies = cache.companies;
    if (search) {
      const q = search.toLowerCase();
      companies = companies.filter(co => co.name.toLowerCase().includes(q));
    }
    res.json({ companies, total: companies.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/groups", (req, res) => {
  try {
    res.json({ groups: cache.groups, total: Object.keys(cache.groups).length });
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
      const contact = cache.contacts.find(c => c.id === sent.contactId);
      followUps.push({
        contactId: sent.contactId,
        contactName: contact ? (contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim()) : "Unknown",
        subject: sent.subject,
        daysSince,
        emailId: sent.id,
      });
    }

    res.json({
      totalContacts: cache.contacts.length,
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

app.post("/cache/refresh", (req, res) => {
  buildCache();
  res.json({ message: "Cache refresh started" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CRM backend v3.0 running on port ${PORT}`));
