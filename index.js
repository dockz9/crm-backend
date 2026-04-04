const express = require("express");
const cors = require("cors");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin with environment variables
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});

const db = getFirestore();

app.get("/", (req, res) => {
  res.json({ status: "Win This Moment! CRM backend is running" });
});

// Search contacts
app.get("/contacts/search", async (req, res) => {
  try {
    const { q, limit = 50, offset = 0 } = req.query;
    const snapshot = await db.collection("contacts").limit(1000).get();
    let contacts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    
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
    
    res.json({ contacts: contacts.slice(offset, offset + limit), total: contacts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
