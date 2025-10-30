const express = require("express");
const { getReportCdnUrl } = require("../lib/reportService");

const router = express.Router();

// GET /api/reports/:userId/daily?date=YYYY-MM-DD
router.get("/:userId/daily", async (req, res) => {
  try {
    const userId = req.params.userId;
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    const url = await getReportCdnUrl(userId, date);
    res.type("application/json").json({ url });
  } catch (e) {
    console.error("report error:", e);
    res.status(500).json({ error: "failed_to_get_report", details: String(e && e.message || e) });
  }
});

module.exports = router;