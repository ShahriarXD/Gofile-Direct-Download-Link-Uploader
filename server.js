const express = require("express");
const cors = require("cors");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const app = express();
const PORT = process.env.PORT || 7860;
const sessions = new Map();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function createSessionId() {
  return crypto.randomUUID();
}

function sendEvent(sessionId, eventName, payload) {
  const session = sessions.get(sessionId);
  if (!session?.res) {
    return;
  }

  session.res.write(`event: ${eventName}\n`);
  session.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendStage(sessionId, phase, message) {
  sendEvent(sessionId, "stage", { phase, message });
}

function sendProgress(sessionId, phase, percent, transferredBytes, totalBytes) {
  sendEvent(sessionId, "progress", {
    phase,
    percent,
    transferredBytes,
    totalBytes
  });
}

function parseTotalBytes(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function ensureValidRemoteUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Please enter a valid remote file URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  return parsed.toString();
}

function inferFilename(targetUrl, headers) {
  const disposition = headers["content-disposition"];
  if (disposition) {
    const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8?.[1]) {
      return decodeURIComponent(utf8[1]).replace(/[^\w.\-() ]+/g, "-");
    }

    const basic = disposition.match(/filename="?([^"]+)"?/i);
    if (basic?.[1]) {
      return basic[1].replace(/[^\w.\-() ]+/g, "-");
    }
  }

  try {
    const url = new URL(targetUrl);
    const candidate = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    return candidate.replace(/[^\w.\-() ]+/g, "-") || `download-${Date.now()}`;
  } catch {
    return `download-${Date.now()}`;
  }
}

async function removeTempFile(filePath) {
  if (!filePath) {
    return;
  }

  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to remove temp file:", error);
    }
  }
}

function createThrottledProgress(sessionId, phase) {
  let lastPercent = -1;
  let lastEmitAt = 0;

  return (loaded, total) => {
    const now = Date.now();
    const hasTotal = Number.isFinite(total) && total > 0;
    const percent = hasTotal
      ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100)))
      : null;

    if (percent === lastPercent && now - lastEmitAt < 250) {
      return;
    }

    lastPercent = percent;
    lastEmitAt = now;
    sendProgress(sessionId, phase, percent, loaded, total ?? null);
  };
}

async function streamDownloadToDisk(sessionId, targetUrl) {
  sendStage(sessionId, "download", "Connecting to remote source...");

  const response = await axios.get(targetUrl, {
    responseType: "stream",
    maxRedirects: 5,
    timeout: 60000,
    validateStatus: (status) => status >= 200 && status < 400
  });

  const totalBytes = parseTotalBytes(response.headers["content-length"]);
  const filename = inferFilename(targetUrl, response.headers);
  const tempPath = path.join(
    os.tmpdir(),
    `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${filename}`
  );

  let downloadedBytes = 0;
  const emitProgress = createThrottledProgress(sessionId, "download");

  response.data.on("data", (chunk) => {
    downloadedBytes += chunk.length;
    emitProgress(downloadedBytes, totalBytes);

    if (totalBytes) {
      sendStage(
        sessionId,
        "download",
        `Downloading from source... ${Math.round((downloadedBytes / totalBytes) * 100)}%`
      );
    } else {
      sendStage(
        sessionId,
        "download",
        `Downloading from source... ${formatBytes(downloadedBytes)} received`
      );
    }
  });

  await pipeline(response.data, fs.createWriteStream(tempPath));
  emitProgress(downloadedBytes, totalBytes || downloadedBytes);

  return {
    tempPath,
    filename
  };
}

async function getMultipartLength(form) {
  return new Promise((resolve, reject) => {
    form.getLength((error, length) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(length);
    });
  });
}

async function uploadToGofile(sessionId, tempPath, filename) {
  sendStage(sessionId, "upload", "Selecting Gofile upload endpoint...");

  // The current Gofile API supports direct upload through upload.gofile.io.
  // We keep compatibility with the older requested flow by trying /servers first,
  // then safely falling back to the current documented upload endpoint.
  let uploadUrl = "https://upload.gofile.io/uploadfile";

  try {
    const serverResponse = await axios.get("https://api.gofile.io/servers", {
      timeout: 15000
    });

    const serverName =
      serverResponse.data?.data?.servers?.[0]?.name ||
      serverResponse.data?.data?.server ||
      serverResponse.data?.servers?.[0]?.name;

    if (serverName) {
      uploadUrl = `https://${serverName}.gofile.io/contents/uploadfile`;
    }
  } catch (error) {
    sendStage(sessionId, "upload", "Using default Gofile upload endpoint...");
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(tempPath), filename);

  const contentLength = await getMultipartLength(form);
  const emitProgress = createThrottledProgress(sessionId, "upload");

  const response = await axios.post(uploadUrl, form, {
    headers: {
      ...form.getHeaders(),
      "Content-Length": contentLength
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 0,
    onUploadProgress: (progressEvent) => {
      const loaded = progressEvent.loaded || 0;
      const total = progressEvent.total || contentLength;

      emitProgress(loaded, total);
      sendStage(
        sessionId,
        "upload",
        total
          ? `Uploading to Gofile... ${Math.round((loaded / total) * 100)}%`
          : `Uploading to Gofile... ${formatBytes(loaded)} sent`
      );
    }
  });

  const payload = response.data || {};
  const data = payload.data || {};
  const downloadPage = data.downloadPage || data.downloadpage || null;

  if (payload.status !== "ok" || !downloadPage) {
    throw new Error("Gofile returned an unexpected response while uploading the file.");
  }

  emitProgress(contentLength, contentLength);
  return downloadPage;
}

async function runTransfer(sessionId, targetUrl) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  session.activeTransfer = true;
  let tempPath = null;

  try {
    const downloadResult = await streamDownloadToDisk(sessionId, targetUrl);
    tempPath = downloadResult.tempPath;
    sendStage(sessionId, "upload", "Download complete. Preparing upload to Gofile...");

    const downloadPage = await uploadToGofile(
      sessionId,
      downloadResult.tempPath,
      downloadResult.filename
    );

    sendEvent(sessionId, "success", { downloadPage });
    sendStage(sessionId, "complete", "Transfer complete. Your Gofile link is ready.");
  } catch (error) {
    console.error("Transfer failed:", error);
    sendEvent(sessionId, "error", {
      message:
        error.response?.data?.statusText ||
        error.response?.data?.message ||
        error.message ||
        "The transfer failed unexpectedly."
    });
  } finally {
    await removeTempFile(tempPath);
    const activeSession = sessions.get(sessionId);
    if (activeSession) {
      activeSession.activeTransfer = false;
    }
  }
}

function handleProgressStream(req, res) {
  const sessionId = createSessionId();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  sessions.set(sessionId, {
    res,
    heartbeat,
    activeTransfer: false
  });

  sendEvent(sessionId, "connected", { sessionId });

  req.on("close", () => {
    const session = sessions.get(sessionId);
    if (session?.heartbeat) {
      clearInterval(session.heartbeat);
    }
    sessions.delete(sessionId);
  });
}

app.get("/api/progress", handleProgressStream);

app.post("/api/transfer", async (req, res) => {
  const { fileUrl, sessionId } = req.body || {};
  const session = sessions.get(sessionId);

  if (!session) {
    res.status(400).json({
      ok: false,
      error: "Your live progress session expired. Refresh and try again."
    });
    return;
  }

  let validatedUrl;
  try {
    validatedUrl = ensureValidRemoteUrl(fileUrl);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
    return;
  }

  if (session.activeTransfer) {
    res.status(409).json({
      ok: false,
      error: "A transfer is already running for this browser session."
    });
    return;
  }

  sendStage(sessionId, "queued", "Transfer accepted. Starting secure pipeline...");
  runTransfer(sessionId, validatedUrl);
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Remote URL Downloader to Gofile is running on port ${PORT}`);
});

