const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");
const path = require("path");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(cors({
  origin: "*", // Allows any origin
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.static(__dirname));

let activeRequests = 0;
const MAX_REQUESTS = 1;
let progress = 0;

async function getEpisodeUrl(page, mangaName, episodeNum) {
  console.log(`Fetching episode URL for ${mangaName}, Episode ${episodeNum}`);
  await page.goto("https://www.webtoons.com/en/", { waitUntil: "domcontentloaded" });
  console.log("Loaded Webtoons homepage");
  await page.click(".btn_search._btnSearch");
  await page.waitForSelector(".input_search._txtKeyword", { visible: true, timeout: 5000 });
  await page.type(".input_search._txtKeyword", mangaName);
  await page.keyboard.press("Enter");
  console.log(`Searched for ${mangaName}`);
  await page.waitForSelector(".card_lst", { timeout: 5000 });
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
  await page.goto(episodeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
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
      progress = ((i + 1) / imageUrls.length) * 50; // 50% للتحميل من الـ backend
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

  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ progress: Math.round(progress) })}\n\n`);
    console.log(`Sent progress update: ${progress}%`);
  }, 500);

  req.on("close", () => {
    clearInterval(interval);
    res.end();
    console.log("Progress connection closed");
  });
});

app.post("/download", async (req, res) => {
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
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    page = await browser.newPage();
    console.log("Browser started");

    const episodeUrl = await getEpisodeUrl(page, mangaName, episodeNum);
    if (!episodeUrl) throw new Error("Couldn't find the episode URL");

    const imageUrls = await getImagesFromEpisode(page, episodeUrl);
    if (imageUrls.length === 0) throw new Error("No images found");

    const imagesBase64 = await downloadImages(imageUrls);
    progress = 50; // 50% بعد التحميل من الـ backend
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

app.listen(3000, () => {
  console.log(`Server running on http://localhost:${process.env.PORT || 3000}`);
});