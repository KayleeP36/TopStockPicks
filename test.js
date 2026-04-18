const fs = require("fs");
const path = require("path");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const API_KEY = process.env.API_KEY;

const DEFAULT_TICKERS = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "GOOG",
  "META",
  "TSLA",
  "BRK.B",
  "AVGO",
];

const https = require("https");
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 15000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        let rawBody = "";

        response.on("data", (chunk) => {
          rawBody += chunk;
        });

        response.on("end", () => {
          try {
            const data = JSON.parse(rawBody);
            resolve({ statusCode: response.statusCode, data });
          } catch {
            reject(new Error("Invalid JSON response from Polygon."));
          }
        });
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getFinancialMetrics(stockData) {
  if (!stockData || typeof stockData !== "object") {
    throw new Error("Stock data must be an object.");
  }

  const open = toNumber(stockData.open);
  const close = toNumber(stockData.close);
  const high = toNumber(stockData.high);
  const low = toNumber(stockData.low);

  const computedReturnPct = open > 0 ? ((close - open) / open) * 100 : 0;
  const computedVolatilityPct = open > 0 ? ((high - low) / open) * 100 : 0;
  const score =
    stockData.buyScore ?? stockData.compositeScore ?? computedReturnPct * 0.6 - computedVolatilityPct * 0.1;

  return {
    score: round(toNumber(score)),
    return: round(stockData.dailyReturnPct ?? computedReturnPct),
    volatility: round(stockData.rangePct ?? computedVolatilityPct),
  };
}

function getPercentile(values, percentile) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * percentile)));
  return sorted[index];
}

function buildRankings(successItems) {
  const scored = successItems
    .map((item) => {
      const bar = item.data?.results?.[0];
      if (!bar) {
        return null;
      }

      const open = toNumber(bar.o);
      const close = toNumber(bar.c);
      const high = toNumber(bar.h);
      const low = toNumber(bar.l);
      const volume = toNumber(bar.v);
      const vwap = toNumber(bar.vw);

      if (open <= 0) {
        return null;
      }

      const dailyReturnPct = ((close - open) / open) * 100;
      const rangePct = ((high - low) / open) * 100;
      const dollarVolume = volume * (vwap || close || open);
      const momentumPerRange = dailyReturnPct / Math.max(rangePct, 0.01);
      const liquidityScore = Math.log10(Math.max(dollarVolume, 1));
      const compositeScore =
        dailyReturnPct * 0.6 + momentumPerRange * 0.3 + liquidityScore * 0.1 - rangePct * 0.1;

      return {
        ticker: item.ticker,
        open: round(open),
        close: round(close),
        high: round(high),
        low: round(low),
        volume: Math.round(volume),
        vwap: round(vwap),
        dailyReturnPct: round(dailyReturnPct),
        rangePct: round(rangePct),
        dollarVolume: Math.round(dollarVolume),
        momentumPerRange: round(momentumPerRange),
        liquidityScore: round(liquidityScore),
        compositeScore: round(compositeScore),
      };
    })
    .filter(Boolean);

  const byComposite = [...scored].sort((a, b) => b.compositeScore - a.compositeScore);
  const byMomentum = [...scored].sort((a, b) => b.dailyReturnPct - a.dailyReturnPct);
  const byLiquidity = [...scored].sort((a, b) => b.dollarVolume - a.dollarVolume);
  const byLowVolatility = [...scored].sort((a, b) => a.rangePct - b.rangePct);

  const minDailyReturnPct = 0;
  const minDollarVolume = getPercentile(
    scored.map((item) => item.dollarVolume),
    0.5
  );
  const maxRangePct = getPercentile(
    scored.map((item) => item.rangePct),
    0.6
  );

  const withBuyEvaluation = scored.map((item) => {
    const checks = {
      positiveReturn: item.dailyReturnPct > minDailyReturnPct,
      strongLiquidity: item.dollarVolume >= minDollarVolume,
      controlledVolatility: item.rangePct <= maxRangePct,
    };

    const buyScore =
      item.dailyReturnPct * 0.5 + item.momentumPerRange * 0.3 + item.liquidityScore * 0.15 - item.rangePct * 0.2;

    return {
      ...item,
      buyScore: round(buyScore),
      buyChecks: checks,
      passedChecks: Object.values(checks).filter(Boolean).length,
    };
  });

  const topBuys = withBuyEvaluation
    .filter((item) => item.passedChecks === 3)
    .sort((a, b) => b.buyScore - a.buyScore)
    .slice(0, 3);

  const fallbackTopBuys = withBuyEvaluation
    .filter((item) => item.buyChecks.positiveReturn)
    .sort((a, b) => b.buyScore - a.buyScore)
    .slice(0, 3);

  const byBuyScore = [...withBuyEvaluation].sort((a, b) => b.buyScore - a.buyScore);
  const recommendedTop3 = [...topBuys, ...fallbackTopBuys, ...byBuyScore]
    .filter((item, index, items) => items.findIndex((candidate) => candidate.ticker === item.ticker) === index)
    .slice(0, 3);

  return {
    methodNotes: {
      summary:
        "Composite score rewards positive return, stronger return relative to intraday range, and higher liquidity while lightly penalizing wider ranges.",
      formula:
        "composite = (dailyReturnPct * 0.6) + (momentumPerRange * 0.3) + (liquidityScore * 0.1) - (rangePct * 0.1)",
      warning:
        "This is a simple heuristic from one day of price/volume data, not financial advice.",
    },
    buyCriteria: {
      summary:
        "Top buys require positive return, above-median dollar volume, and below-60th-percentile intraday range (all from the API response).",
      thresholds: {
        minDailyReturnPct: round(minDailyReturnPct),
        minDollarVolume: Math.round(minDollarVolume),
        maxRangePct: round(maxRangePct),
      },
      fieldsUsed: ["o", "c", "h", "l", "v", "vw"],
      buyScoreFormula:
        "buyScore = (dailyReturnPct * 0.5) + (momentumPerRange * 0.3) + (liquidityScore * 0.15) - (rangePct * 0.2)",
    },
    totalScored: scored.length,
    topComposite: byComposite.slice(0, 10),
    topMomentum: byMomentum.slice(0, 10),
    topLiquidity: byLiquidity.slice(0, 10),
    lowestVolatility: byLowVolatility.slice(0, 10),
    topBuys,
    fallbackTopBuys,
    recommendedTop3,
  };
}

async function getStockData(ticker) {
  if (!API_KEY || API_KEY.length < 10) {
    throw new Error("Missing or invalid API key.");
  }

  const safeTicker = String(ticker || "AAPL").trim().toUpperCase();
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(safeTicker)}/prev?apiKey=${API_KEY}`;
  const { statusCode, data } = await getJson(url);

  if (statusCode < 200 || statusCode >= 300 || data.status === "ERROR") {
    const error = new Error(
      `Polygon request failed (${statusCode}): ${data.error || data.message || "Unknown error"}`
    );
    error.statusCode = statusCode;
    throw error;
  }

  return { ticker: safeTicker, data };
}

async function getStocks(tickers) {
  const uniqueTickers = [...new Set(tickers.map((ticker) => String(ticker).trim().toUpperCase()))].filter(Boolean);
  const success = [];
  const failed = [];

  console.log(
    `Starting fetch for ${uniqueTickers.length} ticker(s). Delay: ${REQUEST_DELAY_MS}ms, Retries: ${MAX_RETRIES}`
  );

  for (let index = 0; index < uniqueTickers.length; index += 1) {
    const ticker = uniqueTickers[index];
    let attempts = 0;

    console.log(`[${index + 1}/${uniqueTickers.length}] Fetching ${ticker}...`);

    while (attempts <= MAX_RETRIES) {
      try {
        const result = await getStockData(ticker);
        success.push(result);
        console.log(`[${index + 1}/${uniqueTickers.length}] ${ticker} OK`);
        break;
      } catch (error) {
        const isRateLimit = error.statusCode === 429;

        if (!isRateLimit || attempts === MAX_RETRIES) {
          failed.push({ ticker, error: error.message });
          console.log(`[${index + 1}/${uniqueTickers.length}] ${ticker} FAILED: ${error.message}`);
          break;
        }

        attempts += 1;
        console.log(
          `[${index + 1}/${uniqueTickers.length}] ${ticker} rate-limited, retry ${attempts}/${MAX_RETRIES} after ${REQUEST_DELAY_MS}ms`
        );
        await wait(REQUEST_DELAY_MS);
      }
    }

    if (index < uniqueTickers.length - 1) {
      console.log(`Waiting ${REQUEST_DELAY_MS}ms before next ticker...`);
      await wait(REQUEST_DELAY_MS);
    }
  }

  const rankings = buildRankings(success);
  const selectedRecommendations = rankings.recommendedTop3;

  return {
    requestedTickers: uniqueTickers,
    successCount: success.length,
    failedCount: failed.length,
    recommendations: selectedRecommendations.map((item) => ({
      ticker: item.ticker,
      ...getFinancialMetrics(item),
    })),
    buyCriteria: rankings.buyCriteria,
  };
}

module.exports = {
  getFinancialMetrics,
  buildRankings,
  getStocks,
};

if (require.main === module) {
  const inputTickers = process.argv.slice(2);
  const tickersToFetch = inputTickers.length ? inputTickers : DEFAULT_TICKERS;

  getStocks(tickersToFetch)
    .then((results) => {
      console.log(JSON.stringify(results, null, 2));
    })
    .catch((error) => {
      console.error("Request failed:", error.message);
    });
}