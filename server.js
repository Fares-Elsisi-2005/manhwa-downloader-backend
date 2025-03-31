const express = require("express");
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const sharp = require("sharp");
const cors = require("cors");

const app = express();

app.use(express.static(__dirname));
app.use(express.json());
app.use(cors());

let activeRequests = 0; // عدد الطلبات النشطة
const MAX_REQUESTS = 2; // الحد الأقصى للطلبات في نفس الوقت
let progress = 0;

async function getEpisodeUrl(page, mangaName, episodeNum) { // أضفنا page كمعامل
  return new Promise(async (resolve) => {
    await page.goto("https://www.webtoons.com/en/", { waitUntil: "domcontentloaded" });
    await page.click(".btn_search._btnSearch");
    await page.waitForSelector(".input_search._txtKeyword", { visible: true, timeout: 5000 });
    await page.type(".input_search._txtKeyword", mangaName);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".card_lst", { timeout: 5000 });
    const mangaUrl = await page.evaluate(() => {
      const link = document.querySelector(".card_lst li a");
      return link ? link.href : null;
    });
    if (!mangaUrl) {
      console.log("Couldn't find the manga!");
      resolve(null);
      return;
    }
    const titleNo = mangaUrl.match(/title_no=(\d+)/)?.[1];
    const urlParts = mangaUrl.match(/https:\/\/www\.webtoons\.com\/en\/([^/]+)\/([^/]+)/);
    const genre = urlParts ? urlParts[1] : null;
    const mangaSlug = urlParts ? urlParts[2] : null;
    if (!titleNo || !genre || !mangaSlug) {
      console.log("Problem with the link!");
      resolve(null);
      return;
    }
    const episodeUrl = `https://www.webtoons.com/en/${genre}/${mangaSlug}/episode-${episodeNum}/viewer?title_no=${titleNo}&episode_no=${episodeNum}`;
    console.log("Episode URL:", episodeUrl);
    resolve(episodeUrl);
  });
}

async function getImagesFromEpisode(page, episodeUrl) { // أضفنا page كمعامل
  return new Promise(async (resolve) => {
    await page.goto(episodeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    const imageUrls = await page.evaluate(() => {
      const images = document.querySelectorAll("#_imageList img._images");
      let urls = [];
      for (let img of images) {
        const url = img.getAttribute("data-url");
        if (url && url.includes("webtoon")) {
          urls.push(url);
        }
      }
      return urls;
    });
    console.log("Number of images:", imageUrls.length);
    resolve(imageUrls);
  });
}

function downloadImages(imageUrls) {
  return new Promise(async (resolve) => {
    let imageBuffers = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.webtoons.com/" },
      });
      imageBuffers.push(response.data);
      progress = ((i + 1) / imageUrls.length) * 50;
      console.log("Downloaded image number:", i + 1, "Progress:", progress);
    }
    resolve(imageBuffers);
  });
}

function createPDF(imageBuffers, mangaName, episodeNum) {
  return new Promise(async (resolve) => {
    const pdfPath = path.join(__dirname, `${mangaName.replace(/\s+/g, "_")}_Ep${episodeNum}.pdf`);
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    for (let i = 0; i < imageBuffers.length; i++) {
      const buffer = imageBuffers[i];
      const { width, height } = await sharp(buffer).metadata();
      const maxWidth = 800;
      let finalWidth = width;
      let finalHeight = height;
      if (width > maxWidth) {
        const scale = maxWidth / width;
        finalWidth = maxWidth;
        finalHeight = Math.round(height * scale);
      }
      doc.addPage({ size: [finalWidth, finalHeight] });
      doc.image(buffer, 0, 0, { width: finalWidth, height: finalHeight });
      progress = 50 + (((i + 1) / imageBuffers.length) * 50);
      console.log("Added image number:", i + 1, "Progress:", progress);
    }
    doc.end();
    stream.on("finish", () => {
      console.log("Finished the PDF and saved it at:", pdfPath);
      resolve(pdfPath);
    });
  });
}

app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ progress: Math.round(progress) })}\n\n`);
    if (progress >= 100) {
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on("close", () => {
    clearInterval(interval);
    res.end();
  });
});

app.post("/download", async (req, res) => {
  const { mangaName, episodeNum } = req.body;

  if (!mangaName || !episodeNum) {
    return res.status(400).json({ error: "Please provide manga name and episode number" });
  }

  if (activeRequests >= MAX_REQUESTS) {
    return res.status(503).json({ error: "Server is busy with other downloads. Please try again later." });
  }

  let browser, page;
  try {
    activeRequests++;
    progress = 0;

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    page = await browser.newPage();
    console.log("Opened the browser!");

    const episodeUrl = await getEpisodeUrl(page, mangaName, episodeNum); // مررنا page هنا
    if (!episodeUrl) {
      throw new Error("Couldn't find the episode URL");
    }

    const imageUrls = await getImagesFromEpisode(page, episodeUrl); // مررنا page هنا
    if (imageUrls.length == 0) {
      throw new Error("No images found in the episode");
    }

    const imageBuffers = await downloadImages(imageUrls);
    const pdfPath = await createPDF(imageBuffers, mangaName, episodeNum);

    res.download(pdfPath, `${mangaName.replace(/\s+/g, "_")}_Ep${episodeNum}.pdf`, (err) => {
      if (err) {
        console.error("Error sending the file:", err);
        res.status(500).json({ error: "Error sending the file" });
      }
      fs.unlink(pdfPath, (err) => {
        if (err) console.error("Error deleting the file:", err);
        console.log("Deleted the PDF file from the server:", pdfPath);
      });
    });
  } catch (error) {
    res.status(500).json({ error: "Something went wrong: " + error.message });
  } finally {
    if (browser) await browser.close();
    activeRequests--;
    console.log("Closed the browser! Active requests:", activeRequests);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on http://localhost:${process.env.PORT || 3000}`);
});