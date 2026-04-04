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

app.get("/contacts/search", async (req, res) => {
  try {
    const { q, limit = 50 } = req.query;
    const url = `${FIREBASE_URL}/contacts?pageSize=${limit}&key=${API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.documents) return res.json({ contacts: [], total: 0 });

    let contacts = data.documents.map(doc => {
      const id = doc.name.split("/").pop();
      const fields = doc.fields || {};
      const parsed = {};
      for (const [k, v] of Object.entries(fields)) {
        parsed[k] = v.stringValue ?? v.integerValue ?? v.booleanValue ?? null;
      }
      return { id, ...parsed };
    });

    if (q) {
      const query = q.toLowerCase();
      contacts = contacts.filter(c =>
        c.firstName?.toLowerCase().includes(query) ||
        c.lastName?.toLowerCase().includes(query) ||
        c.name?.toLowerCase().includes(query) ||
        c.email?.toLowerCase().includes(query) ||
        c.company?.toLowerCase().includes(query) ||
        c.jobTitle?.toLowerCase().includes(query)
      );
    }

    res.json({ contacts, total: contacts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
