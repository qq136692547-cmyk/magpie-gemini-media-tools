import path from "node:path";
import fs from "node:fs/promises";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const VOICE_MAP = Object.freeze({
  alloy: "Kore", ash: "Fenrir", ballad: "Charon", coral: "Aoede", echo: "Puck",
  fable: "Orus", nova: "Leda", onyx: "Fenrir", sage: "Zephyr", shimmer: "Aoede", verse: "Puck",
});

const GENERATE_IMAGE_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Text prompt for image generation/editing" },
    aspect_ratio: { type: "string", description: "Aspect ratio (e.g. 1:1, 16:9, 9:16)" },
    image_size: { type: "string", enum: ["0.5K", "1K", "2K", "4K"], description: "Image resolution" },
    output_path: { type: "string", description: "Local file path to save the generated image" },
  },
  required: ["prompt", "reference_images"],
};

const EDIT_IMAGE_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Text prompt for image editing" },
    reference_images: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4, description: "Local file paths for 1-4 reference images" },
    aspect_ratio: { type: "string", description: "Aspect ratio (e.g. 1:1, 16:9, 9:16)" },
    image_size: { type: "string", enum: ["0.5K", "1K", "2K", "4K"], description: "Image resolution" },
    output_path: { type: "string", description: "Local file path to save the edited image" },
  },
  required: ["prompt"],
};

const ANALYZE_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Local media file path" },
    youtube_url: { type: "string", description: "YouTube URL" },
    prompt: { type: "string", description: "Analysis prompt" },
    start_seconds: { type: "number", description: "Video start offset in seconds" },
    end_seconds: { type: "number", description: "Video end offset in seconds" },
    fps: { type: "number", description: "Frames per second for video sampling" },
  },
};

const SPEAK_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "Text to convert to speech" },
    voice: { type: "string", description: "Voice name (OpenAI-compatible or Gemini)" },
    response_format: { type: "string", enum: ["wav", "pcm"], description: "Audio output format" },
  },
  required: ["text"],
};

function parseKeys(raw) {
  if (!raw) return [];
  const text = Array.isArray(raw) ? raw.join(" ") : String(raw);
  return text.split(/[,;\s]+/).map((k) => k.trim()).filter((k) => k.length > 0);
}

function isPathAllowed(filePath, restrictToWorkspace) {
  if (!restrictToWorkspace) return true;
  const cwd = process.cwd().toLowerCase().replace(/\\/g, "/");
  const normalized = filePath.toLowerCase().replace(/\\/g, "/");
  return normalized.startsWith(cwd) || normalized.startsWith("file://" + cwd);
}

async function fetchWithKeys(keys, path, init = {}, signal, baseUrl = BASE_URL) {
  let lastError = null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[attempt % keys.length];
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, "x-goog-api-key": key },
        signal,
      });
      if (res.status === 429 || res.status === 503) {
        lastError = new Error(`HTTP ${res.status}`);
        lastError.status = res.status;
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("All API keys exhausted");
}

async function encodeFileToBase64(filePath) {
  const fs = await import("node:fs/promises");
  return fs.readFile(filePath).then((buf) => ({
    data: buf.toString("base64"),
    size: buf.length,
    type: guessMimeType(filePath),
  }));
}

function guessMimeType(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "ogg": return "audio/ogg";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "avi": return "video/avi";
    case "mov": return "video/quicktime";
    default: return "application/octet-stream";
  }
}

function buildRIFFHeader(pcmData, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const dataSize = pcmData.length;
  const bufferSize = 44 + dataSize;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);
  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  writeString(0, "RIFF");
  view.setUint32(4, bufferSize - 8, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * channels * bitsPerSample) / 8, true);
  view.setUint16(32, (channels * bitsPerSample) / 8, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

function wrapPCMAsWAV(pcmData, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = buildRIFFHeader(pcmData, sampleRate, channels, bitsPerSample);
  const result = new Uint8Array(header.length + pcmData.length);
  result.set(header, 0);
  result.set(pcmData, header.length);
  return result;
}

function extractImageParts(data) {
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  return parts.filter((p) => p.inlineData?.mimeType?.startsWith("image/")).map((p) => ({ b64_json: p.inlineData.data }));
}

async function saveToWorkspace(outputPath, buffer, defaultFilename) {
  const workspace = process.cwd();
  let resolvedPath;
  if (outputPath) {
    resolvedPath = path.isAbsolute(outputPath) ? outputPath : path.join(workspace, outputPath);
  } else {
    resolvedPath = path.join(workspace, ".magpie-media", defaultFilename);
  }
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, buffer);
  return resolvedPath;
}

async function generateImage(args, merged, signal) {
  const model = merged.imageModel || "gemini-nano-banana-2.1";
  const parts = [{ text: args.prompt }];
  const generationConfig = { responseModalities: ["IMAGE"] };
  if (args.aspect_ratio || args.image_size) {
    const imageConfig = {};
    if (args.aspect_ratio) imageConfig.aspectRatio = args.aspect_ratio;
    if (args.image_size) imageConfig.imageSize = args.image_size;
    generationConfig.imageConfig = imageConfig;
  }
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig,
  });
  const res = await fetchWithKeys(merged.keys, `/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }, signal, merged.baseUrl);
  const data = await res.json();
  const images = extractImageParts(data);
  const savedPaths = [];
  for (const img of images) {
    const buffer = Buffer.from(img.b64_json, "base64");
    const savedPath = await saveToWorkspace(args.output_path, buffer, `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
    savedPaths.push(savedPath);
  }
  return {
    saved_paths: savedPaths,
    mime_type: "image/png",
    bytes: images.map((img) => Buffer.from(img.b64_json, "base64").length),
    model,
    usage: data.usageMetadata,
  };
}

async function editImage(args, merged, signal) {
  const model = merged.imageModel || "gemini-nano-banana-2.1";
  const parts = [{ text: args.prompt }];
  const refs = args.reference_images || [];
  if (refs.length < 1 || refs.length > 4) {
    throw Object.assign(new Error("1-4 reference images required"), { status: 400 });
  }
  for (const ref of refs) {
    if (!isPathAllowed(ref, merged.restrictToWorkspace)) {
      throw Object.assign(new Error(`File access restricted: ${ref}`), { status: 403 });
    }
    const fileData = await encodeFileToBase64(ref);
    parts.push({ inlineData: { mimeType: fileData.type, data: fileData.data } });
  }
  const generationConfig = { responseModalities: ["IMAGE"] };
  if (args.aspect_ratio || args.image_size) {
    const imageConfig = {};
    if (args.aspect_ratio) imageConfig.aspectRatio = args.aspect_ratio;
    if (args.image_size) imageConfig.imageSize = args.image_size;
    generationConfig.imageConfig = imageConfig;
  }
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig,
  });
  const res = await fetchWithKeys(merged.keys, `/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }, signal, merged.baseUrl);
  const data = await res.json();
  const images = extractImageParts(data);
  const savedPaths = [];
  for (const img of images) {
    const buffer = Buffer.from(img.b64_json, "base64");
    const savedPath = await saveToWorkspace(args.output_path, buffer, `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
    savedPaths.push(savedPath);
  }
  return {
    saved_paths: savedPaths,
    mime_type: "image/png",
    bytes: images.map((img) => Buffer.from(img.b64_json, "base64").length),
    model,
    usage: data.usageMetadata,
  };
}

async function analyzeMedia(args, merged, signal) {
  const model = merged.mediaModel || "gemini-3.8-flash";
  const parts = [];
  let uploadedFile = null;

  if (Boolean(args.file_path) === Boolean(args.youtube_url)) {
    throw Object.assign(new Error("Provide exactly one of file_path or youtube_url, not both or neither"), { status: 400 });
  }

  try {
    if (args.youtube_url) {
      parts.push({ text: args.prompt || "Analyze this YouTube video." });
      parts.push({ fileData: { fileUri: args.youtube_url, mimeType: "video/mp4" } });
    } else if (args.file_path) {
      if (!isPathAllowed(args.file_path, merged.restrictToWorkspace)) {
        throw Object.assign(new Error(`File access restricted: ${args.file_path}`), { status: 403 });
      }
      const fileData = await encodeFileToBase64(args.file_path);
      parts.push({ text: args.prompt || "Analyze this media file." });
      if (fileData.size <= 15 * 1024 * 1024) {
        parts.push({ inlineData: { mimeType: fileData.type, data: fileData.data } });
      } else {
        const uploadResult = await uploadFileViaFilesAPI(args.file_path, fileData, merged.keys[0], signal, merged.baseUrl);
        uploadedFile = uploadResult;
        parts.push({ fileData: { fileUri: uploadResult.uri, mimeType: fileData.type } });
      }
    } else {
      throw Object.assign(new Error("Either file_path or youtube_url is required"), { status: 400 });
    }

    if (args.start_seconds !== undefined || args.end_seconds !== undefined || args.fps !== undefined) {
      const videoMetadata = {};
      if (args.start_seconds !== undefined) videoMetadata.startOffset = `${args.start_seconds}s`;
      if (args.end_seconds !== undefined) videoMetadata.endOffset = `${args.end_seconds}s`;
      if (args.fps !== undefined) videoMetadata.fps = args.fps;
      parts[parts.length - 1].videoMetadata = videoMetadata;
    }

    const body = JSON.stringify({ contents: [{ role: "user", parts }] });
    const res = await fetchWithKeys(merged.keys, `/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }, signal, merged.baseUrl);
    const data = await res.json();

    if (data.promptFeedback?.blockReason) {
      throw Object.assign(new Error(`Blocked: ${data.promptFeedback.blockReason}`), { status: 400 });
    }

    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").filter(Boolean).join("\n");
    return { text };
  } finally {
    if (uploadedFile?.name) {
      try {
        await fetch(`${merged.baseUrl || BASE_URL}/${uploadedFile.name}`, {
          method: "DELETE",
          headers: { "x-goog-api-key": merged.keys[0] },
          signal: AbortSignal.timeout(5000),
        });
      } catch { }
    }
  }
}

async function uploadFileViaFilesAPI(filePath, fileData, apiKey, signal, baseUrl = BASE_URL) {
  const uploadUrl = `${baseUrl.replace("/v1beta", "")}/upload/v1beta/files`;
  const initRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(fileData.size),
      "X-Goog-Upload-Header-Content-Type": fileData.type,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: filePath.split(/[\\/]/).pop() } }),
    signal,
  });

  const uploadUri = initRes.headers.get("x-goog-upload-url");
  if (!uploadUri) throw new Error("Failed to get upload URL from x-goog-upload-url header");

  let fileUploaded = false;
  let finalizedName = null;
  try {
    const fileBuffer = await fs.readFile(filePath);
    const uploadRes = await fetch(uploadUri, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Command": "upload, finalize",
        "X-Goog-Upload-Offset": "0",
        "Content-Length": String(fileData.size),
      },
      body: fileBuffer,
      signal,
    });
    const uploadResult = await uploadRes.json();
    const fileUri = uploadResult.file?.uri;
    finalizedName = uploadResult.file?.name || null;
    fileUploaded = true;
    if (!fileUri) throw new Error("Upload failed");

    let pollCount = 0;
    const MAX_POLLS = 30;
    while (pollCount < MAX_POLLS) {
      pollCount++;
      const statusRes = await fetch(`${baseUrl}/${finalizedName || uploadResult.file?.name || ""}`, {
        headers: { "x-goog-api-key": apiKey },
        signal,
      });
      const statusData = await statusRes.json();
      const state = statusData.state || statusData.file?.state;
      if (state === "ACTIVE") break;
      if (state === "FAILED") throw new Error("File processing failed");
      if (pollCount >= MAX_POLLS) throw new Error("Polling timeout");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("Aborted")); }, { once: true });
      });
    }

    return { uri: fileUri, name: finalizedName };
  } catch (err) {
    if (fileUploaded && finalizedName) {
      try {
        await fetch(`${baseUrl}/${finalizedName}`, {
          method: "DELETE",
          headers: { "x-goog-api-key": apiKey },
          signal: AbortSignal.timeout(5000),
        });
      } catch { }
    }
    throw err;
  }
}
async function speakText(args, merged, signal) {
  const model = merged.ttsModel || "gemini-3.8-flash-tts";
  const voice = args.voice ? VOICE_MAP[args.voice.toLowerCase()] || args.voice : "Kore";

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: args.text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });

  const res = await fetchWithKeys(merged.keys, `/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }, signal, merged.baseUrl);

  const data = await res.json();
  const audioPart = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.mimeType?.startsWith("audio/"));
  if (!audioPart) throw new Error("No audio data in response");

  const raw = Uint8Array.from(atob(audioPart.inlineData.data), (c) => c.charCodeAt(0));
  const mimeType = audioPart.inlineData.mimeType;
  const actualFormat = args.response_format || "wav";

  if (actualFormat === "pcm") {
    const savedPath = await saveToWorkspace(args.output_path, raw, `tts_${Date.now()}.pcm`);
    return { saved_path: savedPath, content_type: "audio/pcm", bytes: raw.length, voice, model };
  }
  if (mimeType.includes("wav")) {
    const savedPath = await saveToWorkspace(args.output_path, raw, `tts_${Date.now()}.wav`);
    return { saved_path: savedPath, content_type: "audio/wav", bytes: raw.length, voice, model };
  }
  const rateMatch = mimeType.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  const wav = wrapPCMAsWAV(raw, sampleRate);
  const savedPath = await saveToWorkspace(args.output_path, wav, `tts_${Date.now()}.wav`);
  return { saved_path: savedPath, content_type: "audio/wav", bytes: wav.length, voice, model };
}

async function GeminiMediaToolsPlugin(input = {}, options = {}) {
  const merged = {
    ...options,
    ...(input?.options || {}),
    ...(input?.magpie?.options || {}),
  };
  merged.keys = parseKeys(merged.apiKey || merged.api_key || process.env.GOOGLE_AI_STUDIO_API_KEY || "");

  return {
    tool: {
      generate_image: {
        name: "Generate Image",
        description: "Generate images from text prompts using Gemini Nano Banana",
        args: GENERATE_IMAGE_SCHEMA,
        async execute(args, ctx = {}) {
          if (!args?.prompt || typeof args.prompt !== "string") throw Object.assign(new Error("prompt must be a non-empty string"), { status: 400 });
          if (args.output_path && typeof args.output_path !== "string") throw Object.assign(new Error("output_path must be a string"), { status: 400 });
          if (args.aspect_ratio && typeof args.aspect_ratio !== "string") throw Object.assign(new Error("aspect_ratio must be a string"), { status: 400 });
          if (args.image_size && !["0.5K","1K","2K","4K"].includes(args.image_size)) throw Object.assign(new Error("image_size must be one of 0.5K/1K/2K/4K"), { status: 400 });
          const signal = ctx.abort || undefined;
          return generateImage(args, merged, signal);
        },
      },
      edit_image: {
        name: "Edit Image",
        description: "Edit images using Gemini Nano Banana with 1-4 local reference images",
        args: EDIT_IMAGE_SCHEMA,
        async execute(args, ctx = {}) {
          if (!args?.prompt || typeof args.prompt !== "string") throw Object.assign(new Error("prompt must be a non-empty string"), { status: 400 });
          if (args.output_path && typeof args.output_path !== "string") throw Object.assign(new Error("output_path must be a string"), { status: 400 });
          if (!args?.reference_images || !Array.isArray(args.reference_images) || args.reference_images.length < 1 || args.reference_images.length > 4) throw Object.assign(new Error("1-4 reference_images required"), { status: 400 });
          if (args.aspect_ratio && typeof args.aspect_ratio !== "string") throw Object.assign(new Error("aspect_ratio must be a string"), { status: 400 });
          if (args.image_size && !["0.5K","1K","2K","4K"].includes(args.image_size)) throw Object.assign(new Error("image_size must be one of 0.5K/1K/2K/4K"), { status: 400 });
          const signal = ctx.abort || undefined;
          return editImage(args, merged, signal);
        },
      },
      analyze_media: {
        name: "Analyze Media",
        description: "Analyze local media files or YouTube videos using Gemini",
        args: ANALYZE_SCHEMA,
        async execute(args, ctx = {}) {
          if (!args?.file_path && !args?.youtube_url) throw Object.assign(new Error("Either file_path or youtube_url is required"), { status: 400 });
          if (args.start_seconds !== undefined && (typeof args.start_seconds !== "number" || args.start_seconds < 0)) throw Object.assign(new Error("start_seconds must be a non-negative number"), { status: 400 });
          if (args.end_seconds !== undefined && (typeof args.end_seconds !== "number" || args.end_seconds < 0)) throw Object.assign(new Error("end_seconds must be a non-negative number"), { status: 400 });
          if (args.fps !== undefined && (typeof args.fps !== "number" || args.fps <= 0)) throw Object.assign(new Error("fps must be a positive number"), { status: 400 });
          const signal = ctx.abort || undefined;
          return analyzeMedia(args, merged, signal);
        },
      },
      speak_text: {
        name: "Speak Text",
        description: "Convert text to speech using Gemini TTS",
        args: SPEAK_SCHEMA,
        async execute(args, ctx = {}) {
          if (!args?.text || typeof args.text !== "string") throw Object.assign(new Error("text must be a non-empty string"), { status: 400 });
          if (args.output_path && typeof args.output_path !== "string") throw Object.assign(new Error("output_path must be a string"), { status: 400 });
          if (args.voice && typeof args.voice !== "string") throw Object.assign(new Error("voice must be a string"), { status: 400 });
          if (args.response_format && !["wav", "pcm"].includes(args.response_format)) throw Object.assign(new Error("response_format must be 'wav' or 'pcm'"), { status: 400 });
          const signal = ctx.abort || undefined;
          return speakText(args, merged, signal);
        },
      },
    },
  };
}

export const _internal = Object.freeze({
  parseKeys,
  isPathAllowed,
  fetchWithKeys,
  guessMimeType,
  buildRIFFHeader,
  wrapPCMAsWAV,
  extractImageParts,
  VOICE_MAP,
});

export { GeminiMediaToolsPlugin };
