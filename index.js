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
    const response = await fetch(url
