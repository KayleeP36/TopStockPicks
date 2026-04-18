const express = require("express");
const fs = require("fs");
const path = require("path");
const { getStocks } = require("./test.js");

const app = express();
const PORT = Number(process.env.PORT || 3003);
const RECOMMENDATIONS_FILE = path.join(__dirname, "recommendations.json");

// Enable CORS for local frontend development
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    return res.sendStatus(200);
  }
  next();
});

function saveRecommendations(data) {
  fs.writeFileSync(
    RECOMMENDATIONS_FILE,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

app.get("/recommendations", (req, res) => {
  try {
    if (!fs.existsSync(RECOMMENDATIONS_FILE)) {
      return res.status(404).json({
        status: "error",
        message: "Recommendations file not found. Call /updateRecommendations first.",
      });
    }

    const data = fs.readFileSync(RECOMMENDATIONS_FILE, "utf8");
    const recommendations = JSON.parse(data);
    res.json(recommendations);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

const updateRecommendationsHandler = async (req, res) => {
  const tickersParam = req.query.tickers;
  const tickers = tickersParam
    ? tickersParam.split(",").map((t) => t.trim()).filter(Boolean)
    : null;

  try {
    const results = await getStocks(
      tickers || [
        "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL",
        "GOOG", "META", "TSLA", "BRK.B"
      ]
    );

    const response = {
      status: "ok",
      timestamp: new Date().toISOString(),
      requestedTickers: results.requestedTickers,
      successCount: results.successCount,
      failedCount: results.failedCount,
      recommendations: results.recommendations,
    };

    saveRecommendations(response);

    res.json(response);
  } catch (error) {
    const errorResponse = {
      status: "error",
      timestamp: new Date().toISOString(),
      message: error.message,
    };
    saveRecommendations(errorResponse);
    res.status(500).json(errorResponse);
  }
};

app.get(
  [
    "/updateRecommendations",
    "/updateRecommendation",
    "/updatedRecommendations",
    "/updatedRecommendation",
  ],
  updateRecommendationsHandler
);
const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try a different port.`);
  } else {
    console.error("Server error:", err);
  }
});
// app.listen(PORT, () => {
//   console.log(`Server running at http://localhost:${PORT}`);
//   console.log(`GET http://localhost:${PORT}/updateRecommendations`);
//   console.log(`GET http://localhost:${PORT}/updateRecommendations?tickers=NVDA,AAPL,TSLA`);
// });
