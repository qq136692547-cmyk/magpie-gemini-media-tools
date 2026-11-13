import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GeminiMediaToolsPlugin, _internal } from "./index.mjs";

let server;
let port;
let routes;
let tmpDir;
let eventLog;

function startMockServer(r) {
  routes = r;
  eventLog = [];
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      eventLog.push(`${req.method} ${req.url}`);
      let chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        const key = req.url.replace(/^\/v1beta/, "");
        const handler = routes[key] || routes[req.url] || routes["*"];
        if (handler) handler(req, res, body);
        else { res.writeHead(404); res.end("nf"); }
      });
    });
    server.listen(0, "127.0.0.1", () => { port = server.address().port; resolve(port); });
  });
}

function closeServer() {
  return new Promise((resolve) => {
    if (server) { server.closeAllConnections?.(); server.close(() => resolve()); }
    else resolve();
  });
}

beforeEach(async () => {
  await startMockServer({});
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-media-test-"));
});

afterEach(async () => {
  await closeServer();
  try { await fs.rm(tmpDir, { recursive: true }); } catch { }
});

function makeMockPlugin(extra = {}) {
  return GeminiMediaToolsPlugin({}, { apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}`, ...extra });
}

describe("magpie-gemini-media-tools", () => {
  it("exports exactly 1 function from index.mjs", async () => {
    const mod = await import("./index.mjs");
    const functions = Object.keys(mod).filter((k) => typeof mod[k] === "function");
    assert.equal(functions.length, 1);
    assert.equal(functions[0], "GeminiMediaToolsPlugin");
  });

  it("returns 4 tool hooks with correct names", async () => {
    const plugin = await makeMockPlugin();
    const tools = Object.keys(plugin.tool).sort();
    assert.deepEqual(tools, ["analyze_media", "edit_image", "generate_image", "speak_text"]);
  });

  it("generate_image uses generationConfig.imageConfig and writes to disk", async () => {
    let capturedBody = "";
    routes["*"] = (req, res, body) => {
      capturedBody = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("fake-png-data").toString("base64") } }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100, totalTokenCount: 110 },
      }));
    };
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.generate_image;
    const result = await tool.execute({ prompt: "a cat", aspect_ratio: "16:9", image_size: "1K", output_path: path.join(tmpDir, "test-output.png") }, {});
    const parsed = JSON.parse(capturedBody);
    assert.ok(parsed.generationConfig?.imageConfig);
    assert.equal(parsed.generationConfig.imageConfig.aspectRatio, "16:9");
    assert.equal(parsed.generationConfig.imageConfig.imageSize, "1K");
    assert.ok(!capturedBody.includes("Size:"));
    assert.ok(result.saved_paths);
    assert.equal(result.saved_paths.length, 1);
    const fileContent = await fs.readFile(result.saved_paths[0]);
    assert.equal(fileContent.toString("utf-8"), "fake-png-data");
    assert.ok(!result.b64_json);
  });

  it("edit_image reads 1-4 reference images and uses imageConfig", async () => {
    const refPath1 = path.join(tmpDir, "ref1.png");
    const refPath2 = path.join(tmpDir, "ref2.png");
    await fs.writeFile(refPath1, "ref-image-1");
    await fs.writeFile(refPath2, "ref-image-2");
    let capturedBody = "";
    routes["*"] = (req, res, body) => {
      capturedBody = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("edited-result").toString("base64") } }] } }],
      }));
    };
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.edit_image;
    const result = await tool.execute({ prompt: "combine these", reference_images: [refPath1, refPath2], aspect_ratio: "1:1", image_size: "2K", output_path: path.join(tmpDir, "edit-output.png") }, {});
    const parsed = JSON.parse(capturedBody);
    assert.ok(parsed.generationConfig?.imageConfig);
    assert.equal(parsed.generationConfig.imageConfig.aspectRatio, "1:1");
    assert.equal(parsed.generationConfig.imageConfig.imageSize, "2K");
    const inlineParts = parsed.contents[0].parts.filter((p) => p.inlineData);
    assert.equal(inlineParts.length, 2);
    const fileContent = await fs.readFile(result.saved_paths[0]);
    assert.equal(fileContent.toString("utf-8"), "edited-result");
  });

  it("edit_image rejects 0 or >4 reference images", async () => {
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.edit_image;
    await assert.rejects(() => tool.execute({ prompt: "test", reference_images: [] }, {}), (err) => err.status === 400);
    await assert.rejects(() => tool.execute({ prompt: "test", reference_images: ["a","b","c","d","e"] }, {}), (err) => err.status === 400);
  });

  it("Files API: x-goog-upload-url header → upload → poll state/file.state → generateContent → DELETE", async () => {
    const largeData = new Uint8Array(16 * 1024 * 1024);
    const mediaPath = path.join(tmpDir, "large-audio.wav");
    await fs.writeFile(mediaPath, largeData);
    routes["*"] = (req, res) => {
      if (req.url.includes("upload/v1beta/files") && req.method === "POST" && req.headers["x-goog-upload-command"] === "start") {
        eventLog.push("UPLOAD_START");
        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-goog-upload-url": `http://127.0.0.1:${port}/upload-session`,
        });
        res.end("{}");
      } else if (req.url === "/upload-session" && req.headers["x-goog-upload-command"]?.includes("finalize")) {
        eventLog.push("UPLOAD_FINALIZE");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ file: { name: "files/test-upload", uri: `http://127.0.0.1:${port}/v1beta/files/test-upload`, state: "PROCESSING" } }));
      } else if (req.url.includes("/files/test-upload") && req.method === "GET") {
        eventLog.push("POLL_STATUS");
        const pollNum = eventLog.filter((e) => e === "POLL_STATUS").length;
        res.writeHead(200, { "Content-Type": "application/json" });
        if (pollNum < 3) res.end(JSON.stringify({ file: { state: "PROCESSING" } }));
        else res.end(JSON.stringify({ state: "ACTIVE" }));
      } else if (req.url.includes("generateContent")) {
        eventLog.push("GENERATE_CONTENT");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "analysis result" }] } }] }));
      } else if (req.url.includes("files/test-upload") && req.method === "DELETE") {
        eventLog.push("DELETE_FILE");
        res.writeHead(200);
        res.end("{}");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    };
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.analyze_media;
    const result = await tool.execute({ file_path: mediaPath, prompt: "describe audio" }, {});
    assert.equal(result.text, "analysis result");
    const uploadIdx = eventLog.indexOf("UPLOAD_START");
    const finalizeIdx = eventLog.indexOf("UPLOAD_FINALIZE");
    const genIdx = eventLog.indexOf("GENERATE_CONTENT");
    const deleteIdx = eventLog.indexOf("DELETE_FILE");
    assert.ok(uploadIdx < finalizeIdx, "start before finalize");
    assert.ok(finalizeIdx < genIdx, "finalize before generateContent");
    assert.ok(genIdx < deleteIdx, "generateContent before DELETE");
    assert.ok(eventLog.includes("DELETE_FILE"), "file deleted");
    assert.ok(eventLog.filter((e) => e === "POLL_STATUS").length >= 3);
  });

  it("Files API: DELETE in catch on finalize failure using finalizedName", async () => {
    const largeData = new Uint8Array(16 * 1024 * 1024);
    const mediaPath = path.join(tmpDir, "large-audio-fail.wav");
    await fs.writeFile(mediaPath, largeData);
    routes["*"] = (req, res) => {
      if (req.url.includes("upload/v1beta/files") && req.headers["x-goog-upload-command"] === "start") {
        res.writeHead(200, { "x-goog-upload-url": `http://127.0.0.1:${port}/upload-session` });
        res.end("{}");
      } else if (req.url === "/upload-session") {
        res.writeHead(500);
        res.end("{}");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    };
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.analyze_media;
    await assert.rejects(() => tool.execute({ file_path: mediaPath, prompt: "test" }, {}));
  });

  it("analyze_media detects promptFeedback.blockReason inside try-finally cleanup", async () => {
    routes["*"] = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }));
    };
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.analyze_media;
    await assert.rejects(() => tool.execute({ youtube_url: "https://youtube.com/watch?v=test", prompt: "test" }, {}), (err) => err.status === 400);
  });

  it("speak_text WAV wraps with rate from mimeType and saves to disk", async () => {
    routes["*"] = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from(new Uint8Array(200)).toString("base64") } }] } }],
      }));
    };
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.speak_text;
    const result = await tool.execute({ text: "hello world", voice: "alloy", output_path: path.join(tmpDir, "tts-output.wav") }, {});
    assert.ok(result.saved_path);
    assert.equal(result.content_type, "audio/wav");
    assert.equal(result.bytes, 444);
    assert.equal(result.voice, "Kore");
    assert.equal(result.model, "gemini-3.8-flash-tts");
    const fileContent = await fs.readFile(result.saved_path);
    assert.equal(fileContent.length, 444);
    const dv = new DataView(fileContent.buffer);
    assert.equal(dv.getUint32(40, true), 200);
  });

  it("speak_text PCM saves to disk and returns metadata", async () => {
    routes["*"] = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from(new Uint8Array(100)).toString("base64") } }] } }],
      }));
    };
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.speak_text;
    const result = await tool.execute({ text: "hello", response_format: "pcm" }, {});
    assert.ok(result.saved_path);
    assert.equal(result.content_type, "audio/pcm");
    assert.equal(result.bytes, 100);
    assert.ok(!result.body);
    const fileContent = await fs.readFile(result.saved_path);
    assert.equal(fileContent.length, 100);
  });

  it("multi-key failover on 429", async () => {
    let callCount = 0;
    routes["*"] = (req, res) => {
      callCount++;
      const key = req.headers["x-goog-api-key"];
      if (key === "k1") { res.writeHead(429); res.end(); }
      else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("ok").toString("base64") } }] } }] }));
      }
    };
    const plugin = await makeMockPlugin({ apiKey: "k1,k2" });
    const tool = plugin.tool.generate_image;
    const result = await tool.execute({ prompt: "test", output_path: path.join(tmpDir, "failover.png") }, {});
    assert.ok(result.saved_paths.length >= 1);
    assert.ok(callCount >= 2);
  });

  it("restrictToWorkspace blocks outside paths", async () => {
    const plugin = await makeMockPlugin({ restrictToWorkspace: true });
    const tool = plugin.tool.edit_image;
    await assert.rejects(() => tool.execute({ prompt: "test", reference_images: ["/etc/passwd"] }, {}), (err) => err.status === 403);
  });

  it("generate_image validates runtime params", async () => {
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.generate_image;
    await assert.rejects(() => tool.execute({ prompt: 123 }, {}), (err) => err.status === 400);
    await assert.rejects(() => tool.execute({ prompt: "ok", output_path: 123 }, {}), (err) => err.status === 400);
    await assert.rejects(() => tool.execute({ prompt: "ok", image_size: "999K" }, {}), (err) => err.status === 400);
  });

  it("speak_text validates runtime params", async () => {
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.speak_text;
    await assert.rejects(() => tool.execute({ text: 123 }, {}), (err) => err.status === 400);
    await assert.rejects(() => tool.execute({ text: "ok", response_format: "mp3" }, {}), (err) => err.status === 400);
    await assert.rejects(() => tool.execute({ text: "ok", voice: 123 }, {}), (err) => err.status === 400);
  });

  it("analyze_media validates runtime params", async () => {
    const plugin = await makeMockPlugin();
    const tool = plugin.tool.analyze_media;
    await assert.rejects(() => tool.execute({ file_path: null, youtube_url: null }, {}), (err) => err.status === 400);
    await assert.rejects(() => tool.execute({ youtube_url: "https://youtube.com/test", start_seconds: -1 }, {}), (err) => err.status === 400);
    await assert.rejects(() => tool.execute({ youtube_url: "https://youtube.com/test", fps: 0 }, {}), (err) => err.status === 400);
  });
});
