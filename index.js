const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

app.get("/", (req, res) => {
  res.json({ status: "Win This Moment! CRM backend is running" });
});

function parseDoc(doc) {
  const id = doc.name.split("/").pop();
  const fields = doc.fields || {};
  const parsed = {};
  for (const [k, v] of Object.entries(fields)) {
    parsed[k] = v.stringValue ?? v.integerValue ?? v.booleanValue ?? v.arrayValue ?? null;
  }
  return { id, ...parsed };
}

async function fetchAllContacts() {
  let allDocs = [];
  let pageToken = null;

  while (true) {
    const url = `${FIREBASE_URL}/contacts?pageSize=300&key=${API_KEY}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.documents) {
      allDocs = allDocs.concat(data.documents.map(parseDoc));
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return allDocs;
}

app.get("/contacts/search", async (req, res) => {
  try {
    const { q, limit = 50 } = req.query;

    if (!q || q.trim().length < 2) {
      // No search — just return first page
      const url = `${FIREBASE_URL}/contacts?pageSize=${limit}&key=${API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();
      const contacts = (data.documents || []).map(parseDoc);
      return res.json({ contacts, total: contacts.length });
    }

    // Search — fetch all and filter
    const all = await fetchAllContacts();
    const query = q.toLowerCase();
    const filtered = all.filter(c =>
      c.firstName?.toLowerCase().includes(query) ||
      c.lastName?.toLowerCase().includes(query) ||
      c.name?.toLowerCase().includes(query) ||
      c.email?.toLowerCase().includes(query) ||
      c.company?.toLowerCase().includes(query) ||
      c.jobTitle?.toLowerCase().includes(query)
    );

    res.json({ contacts: filtered.slice(0, Number(limit)), total: filtered.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.env(`Server running on port ${PORT}`));
