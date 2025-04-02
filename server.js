const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const app = express();

app.use(express.json());

// Middleware للتعامل مع الـ CORS وطلبات الـ OPTIONS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(__dirname));

let activeRequests = 0;
const MAX_REQUESTS = 1;
let progress = 0;

async function getEpisodeUrl(page, mangaName, episodeNum) {
  console.log(`Fetching episode URL for ${mangaName}, Episode ${episodeNum}`);
  await page.setExtraHTTPHeaders({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Referer": "https://www.webtoons.com/",
  });
  await page.goto("https://www.webtoons.com/en/", { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("Loaded Webtoons homepage");
  await page.click(".btn_search._btnSearch");
  await page.waitForSelector(".input_search._txtKeyword", { visible: true, timeout: 5000 });
  await page.type(".input_search._txtKeyword", mangaName);
  await page.keyboard.press("Enter");
  console.log(`Searched for ${mangaName}`);
  await page.waitForSelector(".card_lst", { timeout: 7000 });
  const mangaUrl = await page.evaluate(() => {
    const link = document.querySelector(".card_lst li a");
    return link ? link.href : null;
  });
  if (!mangaUrl) {
    console.log("Manga not found!");
    return null;
  }
  console.log(`Found manga URL: ${mangaUrl}`);
  const titleNo = mangaUrl.match(/title_no=(\d+)/)?.[1];
  const urlParts = mangaUrl.match(/https:\/\/www\.webtoons\.com\/en\/([^/]+)\/([^/]+)/);
  const genre = urlParts ? urlParts[1] : null;
  const mangaSlug = urlParts ? urlParts[2] : null;
  if (!titleNo || !genre || !mangaSlug) {
    console.log("Invalid manga URL format!");
    return null;
  }
  const episodeUrl = `https://www.webtoons.com/en/${genre}/${mangaSlug}/episode-${episodeNum}/viewer?title_no=${titleNo}&episode_no=${episodeNum}`;
  console.log(`Generated episode URL: ${episodeUrl}`);
  return episodeUrl;
}

async function getImagesFromEpisode(page, episodeUrl) {
  console.log(`Loading episode page: ${episodeUrl}`);
  await page.setExtraHTTPHeaders({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Referer": "https://www.webtoons.com/",
  });
  await page.goto(episodeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  const imageUrls = await page.evaluate(() => {
    const images = document.querySelectorAll("#_imageList img._images");
    return Array.from(images)
      .map(img => img.getAttribute("data-url"))
      .filter(url => url && url.includes("webtoon"));
  });
  console.log(`Found ${imageUrls.length} images`);
  return imageUrls;
}

async function downloadImages(imageUrls) {
  console.log("Starting to download images...");
  const imagesBase64 = [];
  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const response = await axios.get(imageUrls[i], {
        responseType: "arraybuffer",
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.webtoons.com/" },
      });
      const base64 = `data:image/jpeg;base64,${Buffer.from(response.data).toString("base64")}`;
      imagesBase64.push(base64);
      progress = ((i + 1) / imageUrls.length) * 50;
      console.log(`Downloaded image ${i + 1}/${imageUrls.length}, Progress: ${progress}%`);
    } catch (error) {
      console.log(`Failed to download image ${i + 1}: ${imageUrls[i]}, Error: ${error.message}`);
      throw error;
    }
  }
  console.log("All images downloaded as base64");
  return imagesBase64;
}

app.get("/progress", (req, res) => {
  console.log("Progress endpoint requested");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.write(`data: ${JSON.stringify({ progress: 0 })}\n\n`);

  const interval = setInterval(() => {
    if (activeRequests === 0) {
      clearInterval(interval);
      res.write(`data: ${JSON.stringify({ progress: 0, done: true })}\n\n`);
      res.end();
      console.log("Progress stream stopped because no active requests");
    } else {
      res.write(`data: ${JSON.stringify({ progress: Math.round(progress) })}\n\n`);
      console.log(`Sent progress update: ${progress}%`);
    }
  }, 1000);

  req.on("close", () => {
    clearInterval(interval);
    res.end();
    console.log("Progress connection closed by client");
  });
});

app.post("/download", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { mangaName, episodeNum } = req.body;
  console.log(`Received download request for ${mangaName}, Episode ${episodeNum}`);

  if (!mangaName || !episodeNum) {
    console.log("Missing manga name or episode number");
    return res.status(400).json({ error: "Please provide manga name and episode number" });
  }

  if (activeRequests >= MAX_REQUESTS) {
    console.log("Server busy, rejecting request");
    return res.status(503).json({ error: "Server is busy with other downloads." });
  }

  let browser, page;
  try {
    activeRequests++;
    progress = 0;
    console.log("Starting browser...");
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    page = await browser.newPage();
    console.log("Browser started");

    const episodeUrl = await getEpisodeUrl(page, mangaName, episodeNum);
    if (!episodeUrl) throw new Error("Couldn't find the episode URL");

    const imageUrls = await getImagesFromEpisode(page, episodeUrl);
    if (imageUrls.length === 0) throw new Error("No images found");

    const imagesBase64 = await downloadImages(imageUrls);
    progress = 50;
    console.log("Sending base64 images to client");
    res.json({ images: imagesBase64 });
  } catch (error) {
    console.log(`Error occurred: ${error.message}`);
    res.status(500).json({ error: "Something went wrong: " + error.message });
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed");
    }
    activeRequests--;
    progress = 0;
    console.log(`Active requests: ${activeRequests}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});