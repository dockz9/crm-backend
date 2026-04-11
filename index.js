const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

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

async function callClaude(messages, maxTokens = 2000, tools = null) {
  const body = { model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages };
  if (tools) body.tools = tools;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  return res.json();
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
    version: "3.2",
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

    const data = await callClaude([{
      role: "user",
      content: `You are a CRM assistant. Based on this request: "${prompt}"\n\nFind the best matching contacts. Return ONLY a JSON array of contact IDs, max 50.\nFormat: ["id1", "id2", ...]\n\nContacts:\n${JSON.stringify(sample)}\n\nReturn ONLY the JSON array.`
    }]);

    const text = data.content?.[0]?.text || "[]";
    let ids = [];
    try { ids = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch {}
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
        contactName: contact ? (contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim()) : (sent.contactName || "Unknown"),
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

app.post("/gmail/sync", async (req, res) => {
  try {
    const { token, accountEmail } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const contactEmailMap = {};
    cache.contacts.forEach(c => {
      if (c.email) contactEmailMap[c.email.toLowerCase()] = c.id;
    });

    const results = [];
    const syncedIds = new Set();

    for (const folder of ["in:inbox", "in:sent"]) {
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(folder)}&maxResults=200`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (listRes.status === 401) return res.status(401).json({ error: "Gmail token expired" });
      const listData = await listRes.json();

      for (const msg of (listData.messages || [])) {
        if (syncedIds.has(msg.id)) continue;
        syncedIds.add(msg.id);

        const detailRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const detail = await detailRes.json();
        const headers = detail.payload?.headers || [];
        const from = headers.find(h => h.name === "From")?.value || "";
        const to = headers.find(h => h.name === "To")?.value || "";
        const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
        const date = headers.find(h => h.name === "Date")?.value || "";

        const fromEmail = from.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase();
        const toEmails = to.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)?.map(e => e.toLowerCase()) || [];

        let contactId = contactEmailMap[fromEmail];
        let direction = "received";

        if (!contactId) {
          for (const toEmail of toEmails) {
            if (contactEmailMap[toEmail]) {
              contactId = contactEmailMap[toEmail];
              direction = "sent";
              break;
            }
          }
        }

        if (!contactId) continue;

        const contact = cache.contacts.find(c => c.id === contactId);
        const contactName = contact ? (contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim()) : "";
        const dateStr = date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

        results.push({ gmailId: msg.id, contactId, contactName, subject, body: "", date: dateStr, direction, status: "read", autoSynced: "true", gmailAccount: accountEmail || "" });
      }
    }

    for (const email of results) {
      await fetch(`${BASE}/emails?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: Object.fromEntries(Object.entries(email).map(([k, v]) => [k, { stringValue: String(v) }])) })
      });
    }

    console.log(`Gmail sync: ${results.length} emails matched from ${syncedIds.size} checked`);
    res.json({ synced: results.length, checked: syncedIds.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ai/pitchdeck-match", async (req, res) => {
  try {
    const { deckText, deckName, base64, fileType } = req.body;
    if (!deckText && !base64) return res.status(400).json({ error: "deckText or base64 required" });

    console.log(`Pitchdeck match: ${deckName}, fileType: ${fileType}, hasBase64: ${!!base64}`);

    let extractMessages;
    if (base64 && fileType === "pdf") {
      extractMessages = [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: "Extract the key investment details from this pitch deck. Return ONLY a JSON object with no extra text:\n{\"companyName\":\"\",\"assetClass\":\"\",\"strategy\":\"\",\"geography\":\"\",\"dealSize\":\"\",\"returnTarget\":\"\",\"sector\":\"\",\"summary\":\"\"}" }
        ]
      }];
    } else {
      extractMessages = [{
        role: "user",
        content: `Extract the key investment details from this pitch deck named "${deckName}". Return ONLY a JSON object with no extra text:\n{"companyName":"","assetClass":"","strategy":"","geography":"","dealSize":"","returnTarget":"","sector":"","summary":""}\n\nContent: ${(deckText || "").slice(0, 6000)}`
      }];
    }

    const extractData = await callClaude(extractMessages, 800);
    let dealDetails = {};
    try {
      const extractText = extractData.content?.[0]?.text || "{}";
      const jsonMatch = extractText.match(/\{[\s\S]*\}/);
      if (jsonMatch) dealDetails = JSON.parse(jsonMatch[0]);
    } catch (e) {
      dealDetails = { companyName: deckName, summary: "Could not parse deck details" };
    }

    const contactSample = cache.contacts.slice(0, 2000).map(c => ({
      id: c.id,
      name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
      company: c.company || "",
      jobTitle: c.jobTitle || "",
      industry: c.industry || "",
      importGroups: c.importGroups || "",
      metroArea: c.metroArea || "",
    }));

    const matchData = await callClaude([{
      role: "user",
      content: `You are a capital markets expert. Find the best investor matches for this deal.\n\nDeal: ${JSON.stringify(dealDetails)}\n\nReturn the top 30 best matching contacts as a JSON array. No extra text:\n[{"id":"contact_id","name":"name","company":"company","reason":"one sentence why","score":95,"group":"PE Investor"}]\n\nValid groups: PE Investor, Family Office, Pension Fund, Endowment, Sovereign Wealth, Fund of Funds, Real Estate, Infrastructure, Credit, Other\n\nCRM contacts (${contactSample.length} total):\n${JSON.stringify(contactSample)}`
    }], 3000);

    let matches = [];
    try {
      const matchText = matchData.content?.[0]?.text || "[]";
      const jsonMatch = matchText.match(/\[[\s\S]*\]/);
      if (jsonMatch) matches = JSON.parse(jsonMatch[0]);
    } catch (e) {}

    let webMatches = [];
    try {
      const webData = await callClaude([{
        role: "user",
        content: `Search for institutional investors who invest in ${dealDetails.assetClass || ""} ${dealDetails.strategy || ""} ${dealDetails.sector || ""} deals of around ${dealDetails.dealSize || "various sizes"} in ${dealDetails.geography || "global"} markets. Return a JSON array of 5 specific investors not in a private CRM:\n[{"name":"person","company":"firm","reason":"why they match","score":75,"group":"type","inCRM":false}]\nReturn ONLY the JSON array.`
      }], 1000, [{ type: "web_search_20250305", name: "web_search" }]);

      const webText = (webData.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const jsonMatch = webText.match(/\[[\s\S]*\]/);
      if (jsonMatch) webMatches = JSON.parse(jsonMatch[0]);
      webMatches = webMatches.map(m => ({ ...m, inCRM: false }));
    } catch (e) {}

    const allMatches = [...matches.map(m => ({ ...m, inCRM: true })), ...webMatches].sort((a, b) => (b.score || 0) - (a.score || 0));
    const grouped = {};
    allMatches.forEach(m => {
      const g = m.group || "Other";
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(m);
    });

    console.log(`Pitchdeck match complete: ${matches.length} CRM, ${webMatches.length} web`);
    res.json({ dealDetails, matches: allMatches, grouped, totalCRM: matches.length, totalWeb: webMatches.length, deckName: deckName || "Uploaded Deck" });
  } catch (e) {
    console.error("Pitchdeck error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/cache/refresh", (req, res) => {
  buildCache();
  res.json({ message: "Cache refresh started" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CRM backend v3.2 running on port ${PORT}`));
