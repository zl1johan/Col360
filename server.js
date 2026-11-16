"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { chromium } = require("playwright");

const ENV_FILE = path.join(__dirname, ".env");
if (fs.existsSync(ENV_FILE)) {
  const contents = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2").replace(/\s+#.*$/, "");
    process.env[match[1]] = value;
  }
}

const PORT = Number(process.env.PORT || 3000);
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_RATE_LIMIT_REPLY = "Dame 5 segundos que estoy procesando varias consultas seguidas y vuelve a escribirme.";
const DB_FILE = path.join(__dirname, "db.json");
const OTP_LIFETIME_MS = 10 * 60 * 1000;
const db = loadDatabase();
const pendingOtps = new Map();
const queue = [];
const sessionTasks = new Map();
const mailTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp-relay.brevo.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
let cachedGroqApiKey = "";
let cachedGroqModel = "";
const SUPPORTED_PORTALS = [
  {
    entidad: "SIMIT - Federación Colombiana de Municipios",
    tramite: "Estado de Cuenta Comparendos",
    url_portal: "https://www.fcm.org.co/simit/#/home-public",
    tipo: "simit",
  },
  {
    entidad: "ADRES - Ministerio de Salud",
    tramite: "Consulta de Afiliados BDUA",
    url_portal: "https://aplicaciones.adres.gov.co/bdua_internet/Pages/ConsultarAfiliadoWeb.aspx",
    tipo: "adres",
  },
  {
    entidad: "Procuraduría General de la Nación",
    tramite: "Certificado de Antecedentes Disciplinarios",
    url_portal: "https://apps.procuraduria.gov.co/webcert/inicio.aspx",
    tipo: "procuraduria",
  },
];
const REQUIRED_FIELDS = ["entidad", "tramite", "documento", "url_portal"];
const SUPPORTED_SERVICES_REPLY = "Solo puedo ayudarte con Consulta SIMIT, Afiliación ADRES y Antecedentes disciplinarios de Procuraduría.";

const SYSTEM_PROMPT = `Eres el Agente Oficial de Col360 en Colombia. Atiendes EXCLUSIVAMENTE estas tres consultas oficiales reales, sin inventar URLs ni mezclar entidades o trámites:
1. SIMIT (Multas / Comparendos) -> entidad: "SIMIT - Federación Colombiana de Municipios", tramite: "Estado de Cuenta Comparendos", url_portal: "https://www.fcm.org.co/simit/#/home-public"
2. ADRES (Salud / EPS) -> entidad: "ADRES - Ministerio de Salud", tramite: "Consulta de Afiliados BDUA", url_portal: "https://aplicaciones.adres.gov.co/bdua_internet/Pages/ConsultarAfiliadoWeb.aspx"
3. Procuraduría (Antecedentes Disciplinarios) -> entidad: "Procuraduría General de la Nación", tramite: "Certificado de Antecedentes Disciplinarios", url_portal: "https://apps.procuraduria.gov.co/webcert/inicio.aspx"
El ciudadano ya inició sesión y su perfil está registrado localmente. Nunca pidas nombre, cédula, teléfono ni correo. Si pide algo fuera de estos tres trámites, responde enumerando las opciones y NO llames a la herramienta. Para SIMIT usa la placa si aparece en la conversación; no pidas datos personales ya registrados. Llama a 'ejecutar_tramite_web' únicamente con la entidad, trámite y URL exactos. No resuelvas CAPTCHA automáticamente; deja la verificación para la persona usuaria y solo envía después de su confirmación explícita.`;

const tool = {
  type: "function",
  function: {
    name: "ejecutar_tramite_web",
    description: "Abre únicamente uno de los tres portales oficiales permitidos, completa el dato registrado y espera la confirmación humana.",
    parameters: {
      type: "object",
      properties: {
        entidad: {
          type: "string",
          enum: SUPPORTED_PORTALS.map((portal) => portal.entidad),
          description: "Entidad oficial exacta correspondiente al trámite.",
        },
        tramite: {
          type: "string",
          enum: SUPPORTED_PORTALS.map((portal) => portal.tramite),
          description: "Uno de los cuatro trámites oficiales permitidos.",
        },
        documento: { type: "string", description: "Número de documento o placa para la consulta." },
        url_portal: {
          type: "string",
          enum: SUPPORTED_PORTALS.map((portal) => portal.url_portal),
          description: "URL exacta correspondiente al trámite seleccionado.",
        },
      },
      required: REQUIRED_FIELDS,
      additionalProperties: false,
    },
  },
};

let activeSession = null;
let lastPreviewData = null;
let chatInProgress = null;
let confirmationInProgress = false;
let activeSessionId = null;
const app = express();
const corsOptions = {
  origin: [
    "https://col360.site",
    "https://www.col360.site",
  ],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning", "x-session-id"],
  methods: ["GET", "POST", "OPTIONS"],
};
app.use(cors(corsOptions));
// Express 5 rejects "*" as a route pattern; this regex matches every OPTIONS path.
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: "256kb" }));
const healthHandler = (req, res) => res.json({ status: "online", agent: "Col360" });
app.get("/", healthHandler);
app.get("/health", healthHandler);

function loadDatabase() {
  try {
    const stored = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return stored && stored.users && typeof stored.users === "object" ? stored : { users: {} };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("No se pudo leer db.json; se iniciará una base vacía:", error.message);
    } else {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2), { mode: 0o600 });
    }
    return { users: {} };
  }
}

function saveDatabase() {
  const temporaryFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, DB_FILE);
}

function normalizeProfile(body) {
  const profile = body && typeof body === "object" ? body : {};
  const nombre = typeof profile.nombre === "string" ? profile.nombre.trim().slice(0, 160) : "";
  const cedula = typeof profile.cedula === "string" || typeof profile.cedula === "number"
    ? String(profile.cedula).replace(/\D/g, "").slice(0, 20)
    : "";
  const telefono = typeof profile.telefono === "string" || typeof profile.telefono === "number"
    ? String(profile.telefono).trim().slice(0, 30)
    : "";
  const correo = typeof profile.correo === "string" ? profile.correo.trim().slice(0, 254).toLowerCase() : "";
  if (!nombre || !/^\d{5,20}$/.test(cedula) || !telefono || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return null;
  }
  return { nombre, cedula, telefono, correo };
}

function getSessionId(req) {
  return String(req.get("x-session-id") || "").trim().slice(0, 128);
}

function queuePosition(sessionId) {
  return queue.findIndex((entry) => entry === sessionId) + 1;
}

async function closeActiveSession(sessionId) {
  if (activeSession && (!sessionId || activeSessionId === sessionId)) {
    const session = activeSession;
    activeSession = null;
    activeSessionId = null;
    lastPreviewData = null;
    await session.browser.close().catch((error) => {
      console.error("No se pudo cerrar Chromium al salir de la cola:", error.message);
    });
  }
}

function requireQueueFirst(req, res, next) {
  const sessionId = getSessionId(req);
  if (!sessionId) return res.status(400).json({ ok: false, error: "Falta el identificador de sesión." });
  const position = queuePosition(sessionId);
  if (position !== 1) {
    return res.status(429).json({
      ok: false,
      inQueue: true,
      position,
      reply: "Estás en espera en la fila. Podrás hablar con el agente en cuanto seas el puesto #1.",
    });
  }
  req.sessionId = sessionId;
  next();
}

app.post("/api/request-otp", async (req, res) => {
  const profile = normalizeProfile(req.body);
  if (!profile) return res.status(400).json({ ok: false, error: "Completa nombre, cédula, teléfono y un correo válido." });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  pendingOtps.set(profile.cedula, {
    code,
    expiresAt: Date.now() + OTP_LIFETIME_MS,
    profile,
  });
  try {
    await mailTransport.sendMail({
      from: `"Col360" <${process.env.SMTP_USER}>`,
      to: profile.correo,
      subject: "Tu código de acceso Col360",
      text: `Tu código de acceso Col360 es ${code}. Vence en 10 minutos.`,
    });
  } catch (error) {
    pendingOtps.delete(profile.cedula);
    console.error("No se pudo enviar el código OTP:", error.message);
    return res.status(503).json({ ok: false, error: "No fue posible enviar el correo. Verifica la configuración SMTP e inténtalo de nuevo." });
  }
  fetch("https://ntfy.sh/col360-johan-2026", {
    method: "POST",
    headers: { "Content-Type": "text/plain; charset=utf-8", Title: "Solicitud de acceso Col360" },
    body: "Se solicitó un código de acceso a Col360.",
    signal: AbortSignal.timeout(5000),
  }).catch((error) => console.warn("No se pudo enviar la notificación de acceso:", error.message));
  return res.json({ ok: true, message: "Código enviado al correo registrado. Vence en 10 minutos." });
});

app.post("/api/verify-otp", (req, res) => {
  const profile = normalizeProfile(req.body);
  const code = req.body && String(req.body.code || "").trim();
  const pending = profile && pendingOtps.get(profile.cedula);
  if (!pending || pending.expiresAt < Date.now() || pending.code !== code
    || pending.profile.correo !== profile.correo) {
    return res.status(400).json({ ok: false, error: "El código es inválido o venció. Solicita uno nuevo." });
  }
  const previous = db.users[profile.cedula];
  const user = {
    ...profile,
    history: Array.isArray(previous && previous.history) ? previous.history : [],
  };
  db.users[profile.cedula] = user;
  pendingOtps.delete(profile.cedula);
  try {
    saveDatabase();
  } catch (error) {
    console.error("No se pudo guardar el perfil:", error.message);
    return res.status(500).json({ ok: false, error: "No se pudo guardar el perfil del usuario." });
  }
  return res.json({ ok: true, user });
});

app.get("/api/user/:cedula", requireAgentToken, (req, res) => {
  const cedula = String(req.params.cedula || "").replace(/\D/g, "").slice(0, 20);
  return res.json({ ok: true, user: db.users[cedula] || null });
});

app.post("/api/queue/join", (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) return res.status(400).json({ ok: false, error: "Falta el identificador de sesión." });
  if (!queue.includes(sessionId)) queue.push(sessionId);
  const position = queuePosition(sessionId);
  return res.json({ position, total: queue.length, isFirst: position === 1 });
});

app.get("/api/queue/status", (req, res) => {
  const sessionId = getSessionId(req);
  const position = queuePosition(sessionId);
  return res.json({ position, total: queue.length, isFirst: position === 1 });
});

app.post("/api/queue/leave", async (req, res) => {
  const sessionId = getSessionId(req);
  const position = queuePosition(sessionId);
  if (position > 0) queue.splice(position - 1, 1);
  if (sessionTasks.has(sessionId)) sessionTasks.get(sessionId).cancelled = true;
  if (position === 1) await closeActiveSession(sessionId);
  return res.json({ ok: true });
});

function requireAgentToken(req, res, next) {
  const authorization = req.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const suppliedBuffer = Buffer.from(supplied);
  const validTokens = [
    process.env.API_SECRET_TOKEN,
    process.env.COL360_AGENT_TOKEN,
    "col360-demo-2026",
  ].filter(Boolean);
  const isValid = validTokens.some((token) => {
    const expectedBuffer = Buffer.from(token);
    return suppliedBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  });
  if (!isValid) {
    return res.status(401).json({ error: "Token del servidor ausente o inválido." });
  }
  next();
}

function normalizeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    email: typeof value.email === "string" ? value.email.slice(0, 254) : "",
    city: typeof value.city === "string" ? value.city.slice(0, 120) : "",
    name: typeof value.name === "string" ? value.name.slice(0, 160) : "",
    cedula: typeof value.cedula === "string" ? value.cedula.slice(0, 20) : "",
    telefono: typeof value.telefono === "string" ? value.telefono.slice(0, 30) : "",
  };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-8).map((entry) => ({
    role: entry && entry.role === "assistant" ? "assistant" : "user",
    content: String((entry && entry.content) || "").slice(0, 1500),
  }));
}

function parseToolArguments(raw) {
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    throw new Error("Groq devolvió argumentos de trámite que no se pudieron interpretar.");
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Groq devolvió argumentos de trámite inválidos.");
  }
  const normalized = {};
  for (const field of REQUIRED_FIELDS) {
    normalized[field] = typeof args[field] === "string" ? args[field].trim().slice(0, 1000) : "";
  }
  const missing = ["tramite", "documento"].filter((field) => !normalized[field]);
  return { missing, args: normalized };
}

function validatePortalUrl(value) {
  const portal = SUPPORTED_PORTALS.find((candidate) => candidate.url_portal === value);
  if (!portal) {
    throw new Error("El portal no coincide exactamente con una de las cuatro URLs oficiales permitidas.");
  }
  return portal.url_portal;
}

async function fillFirstVisibleText(page, value, portalName) {
  try {
    const field = page.locator('input[type="text"]:visible').first();
    await field.fill(String(value), { timeout: 1500 });
    return true;
  } catch (error) {
    console.warn(`No se pudo completar el documento en ${portalName}:`, error.message);
    return false;
  }
}

async function fillAdresCaptcha(page, code) {
  const captchaValue = String(code).trim();
  const selector =
    '#Capcha_txtCapcha:visible, input[id*="Capcha" i]:visible, input[id*="Captcha" i]:visible';
  const contexts = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  let lastError;

  for (const context of contexts) {
    try {
      let field = context.locator(selector).first();
      if (await field.count() === 0) {
        field = context.locator('input[type="text"]:visible').nth(1);
      }
      await field.waitFor({ state: "visible", timeout: 1200 });
      await field.click({ timeout: 1200 });
      await field.fill(captchaValue, { timeout: 1200 });
      await field.evaluate((element) => {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No se encontró el campo CAPTCHA de ADRES.");
}

async function selectCedulaType(page, portalName) {
  try {
    const select = page.locator("select:visible").first();
    await select.waitFor({ state: "visible", timeout: 1500 });
    const option = await select.evaluate((element) => {
      const match = Array.from(element.options).find((candidate) =>
        /c[eé]dula/i.test(candidate.textContent || ""));
      return match ? { value: match.value, label: match.textContent.trim() } : null;
    });
    if (!option) throw new Error("No hay una opción de cédula visible.");
    await select.selectOption(
      option.value ? option.value : { label: option.label },
      { timeout: 1500 }
    );
    return true;
  } catch (error) {
    console.warn(`No se pudo seleccionar el tipo de cédula en ${portalName}:`, error.message);
    return false;
  }
}

async function highlightSubmitButton(page, selector, portalName) {
  try {
    const button = page.locator(selector).first();
    await button.waitFor({ state: "visible", timeout: 1500 });
    await button.scrollIntoViewIfNeeded({ timeout: 1500 });
    await button.evaluate((element) => {
      element.style.outline = "4px solid #dc2626";
      element.style.outlineOffset = "3px";
    });
    return button;
  } catch (error) {
    console.warn(`No se encontró el botón principal en ${portalName}:`, error.message);
    return null;
  }
}

async function captureAdresCaptcha(page) {
  const candidates = page.locator(
    'img[id*="captcha" i], img[id*="capcha" i], img[src*="captcha" i], img[src*="capcha" i], img[alt*="captcha" i], img[alt*="capcha" i]'
  );
  const image = candidates.first();
  await image.waitFor({ state: "visible", timeout: 3000 });
  await image.scrollIntoViewIfNeeded();
  const box = await image.boundingBox();
  if (!box || box.width < 1 || box.height < 1) throw new Error("No se pudo localizar la imagen CAPTCHA de ADRES.");
  return (await page.screenshot({
    type: "jpeg",
    quality: 90,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  })).toString("base64");
}

function saveConsultation(cedula, data, radicado, screenshot) {
  const user = db.users[cedula];
  if (!user) throw new Error("No se encontró el perfil para guardar la consulta.");
  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    fecha: new Date().toISOString(),
    portal: data.entidad,
    radicado,
    screenshot,
  });
  saveDatabase();
}

async function getActiveGroqModel(apiKey) {
  const override = process.env.GROQ_MODEL && process.env.GROQ_MODEL.trim();
  if (override) return override;
  if (cachedGroqApiKey === apiKey && cachedGroqModel) return cachedGroqModel;

  const response = await fetch(GROQ_MODELS_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && payload.error && payload.error.message;
    const error = new Error(detail || `Groq modelos respondió con estado ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  const excluded = ["whisper", "tts", "guard", "playai"];
  const models = payload && Array.isArray(payload.data)
    ? payload.data.filter((model) => model && typeof model.id === "string"
      && model.active !== false
      && !excluded.some((term) => model.id.toLowerCase().includes(term)))
    : [];
  if (!models.length) throw new Error("Groq no devolvió modelos de chat disponibles para esta cuenta.");

  const preferred = models.find((model) =>
    ["llama-4", "llama-3", "qwen", "gpt-oss"].some((term) => model.id.toLowerCase().includes(term)));
  cachedGroqApiKey = apiKey;
  cachedGroqModel = (preferred || models[0]).id;
  return cachedGroqModel;
}

app.post("/api/chat", requireAgentToken, requireQueueFirst, async (req, res) => {
  const { message, userContext, history } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "El mensaje es obligatorio." });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: "Configura GROQ_API_KEY en el archivo .env del servidor." });
  }
  const previousTask = sessionTasks.get(req.sessionId);
  if (previousTask) previousTask.cancelled = true;
  await closeActiveSession(req.sessionId);
  if (chatInProgress && !chatInProgress.cancelled && chatInProgress.sessionId !== req.sessionId) {
    return res.status(409).json({ error: "Ya hay una solicitud o previsualización activa. Confírmala o cancélala primero." });
  }
  const requestTask = { sessionId: req.sessionId, cancelled: false };
  chatInProgress = requestTask;
  sessionTasks.set(req.sessionId, requestTask);

  const clientContext = normalizeContext(userContext);
  const profile = db.users[clientContext.cedula];
  if (!profile) {
    chatInProgress = null;
    sessionTasks.delete(req.sessionId);
    return res.status(401).json({ error: "Inicia sesión antes de usar el agente." });
  }
  const context = {
    profileRegistered: true,
  };
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: `Contexto de sesión del usuario (puede estar incompleto): ${JSON.stringify(context)}`,
    },
    ...normalizeHistory(history),
    { role: "user", content: message.trim().slice(0, 12000) },
  ];

  try {
    const model = await getActiveGroqModel(process.env.GROQ_API_KEY);
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        tools: [tool],
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(60000),
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 429) {
      return res.status(200).json({ reply: GROQ_RATE_LIMIT_REPLY });
    }
    if (!response.ok) {
      const detail = payload && payload.error && payload.error.message;
      return res.status(500).json({ error: detail || `Groq respondió con estado ${response.status}.` });
    }

    const choice = payload && payload.choices && payload.choices[0];
    const assistantMessage = choice && choice.message;
    const calls = assistantMessage && assistantMessage.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) {
      const reply = assistantMessage && typeof assistantMessage.content === "string"
        ? assistantMessage.content.trim()
        : "";
      if (!reply) return res.status(500).json({ error: "Groq no devolvió texto ni una acción válida." });
      return res.json({ type: "text", reply });
    }

    if (calls.length !== 1 || calls[0].function.name !== "ejecutar_tramite_web") {
      return res.status(500).json({ error: "Groq devolvió una acción no reconocida." });
    }
    const parsed = parseToolArguments(calls[0].function.arguments);
    const requestedPortal = SUPPORTED_PORTALS.find((portal) => portal.tramite === parsed.args.tramite);
    if (parsed.missing.includes("documento") && requestedPortal) {
      parsed.args.documento = profile.cedula;
      parsed.missing.splice(parsed.missing.indexOf("documento"), 1);
    }
    if (parsed.missing.length) {
      return res.json({
        type: "text",
        reply: "Indícame cuál consulta deseas realizar: Consulta SIMIT, Afiliación ADRES o Antecedentes disciplinarios.",
      });
    }

    const selectedPortal = SUPPORTED_PORTALS.find((portal) => portal.tramite === parsed.args.tramite);
    if (!selectedPortal) {
      return res.json({ type: "text", reply: SUPPORTED_SERVICES_REPLY });
    }
    if (requestTask.cancelled) return res.status(409).json({ error: "La solicitud se canceló al salir de la cola." });
    const conversationText = [message, ...normalizeHistory(history).map((entry) => entry.content)].join("\n");
    const plateMatch = conversationText.match(/\b(?:[A-Z]{3}\s?\d{3}|\d{3}\s?[A-Z]{3})\b/i);
    const args = {
      entidad: selectedPortal.entidad,
      tramite: selectedPortal.tramite,
      documento: selectedPortal.tipo === "simit"
        ? (plateMatch ? plateMatch[0].replace(/\s/g, "").toUpperCase() : profile.cedula)
        : profile.cedula,
      url_portal: validatePortalUrl(selectedPortal.url_portal),
    };
    const browser = await chromium.launch({ headless: false, slowMo: 200 });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(1000);
      try {
        await page.goto(args.url_portal, { waitUntil: "domcontentloaded", timeout: 15000 });
      } catch (error) {
        await browser.close();
        return res.json({
          type: "text",
          reply: `No pude abrir el portal oficial de ${args.entidad}. Puede estar temporalmente fuera de servicio; inténtalo más tarde.`,
        });
      }
      await page.waitForTimeout(selectedPortal.tipo === "simit" ? 2500 : 1500);
      let documentFilled = false;
      let submitButton = null;
      if (selectedPortal.tipo === "simit") {
        try {
          const closeControls = page.locator(
            'button:has-text("×"), .modal button.close, [role="dialog"] button, button[aria-label="Close"], .close'
          );
          for (const control of await closeControls.all()) {
            if (await control.isVisible()) {
              await control.click({ timeout: 1200 });
              break;
            }
          }
        } catch (error) {
          console.warn("No se pudo hacer clic en el cierre del anuncio de SIMIT:", error.message);
        }
        try {
          await page.keyboard.press("Escape");
        } catch (error) {
          console.warn("No se pudo cerrar el anuncio de SIMIT con Escape:", error.message);
        }
        try {
          await page.mouse.click(15, 15);
        } catch (error) {
          console.warn("No se pudo hacer clic en el fondo del anuncio de SIMIT:", error.message);
        }
        try {
          await page.evaluate(() => {
            document.querySelectorAll(".modal, .modal-backdrop, [role='dialog'], .cdk-overlay-container")
              .forEach((element) => element.remove());
            document.body.classList.remove("modal-open");
            document.body.style.overflow = "auto";
          });
        } catch (error) {
          console.warn("No se pudo eliminar el modal del DOM de SIMIT:", error.message);
        }
        await page.waitForTimeout(400);
        try {
          const field = page.locator(
            'input[placeholder*="identificación" i]:visible, input[placeholder*="placa" i]:visible, input[type="text"]:visible'
          ).first();
          await field.click({ timeout: 1500 });
          await field.fill(String(args.documento), { timeout: 1500 });
          documentFilled = true;
        } catch (error) {
          console.warn("No se pudo completar el documento o placa en SIMIT:", error.message);
        }
        submitButton = await highlightSubmitButton(
          page,
          'button[type="submit"], button:has(svg), button.btn-primary',
          "SIMIT"
        );
      } else if (selectedPortal.tipo === "adres") {
        try {
          let documentField = page.locator("#txtNumDoc:visible").first();
          if (await documentField.count() === 0) {
            documentField = page.locator("input[type='text']:visible").first();
          }
          await documentField.fill(String(args.documento), { timeout: 1500 });
          documentFilled = true;
        } catch (error) {
          console.warn("No se pudo completar el documento en ADRES:", error.message);
        }
        submitButton = await highlightSubmitButton(
          page,
          '#btnConsultar, input[type="submit"], input[value*="Consultar" i]',
          "ADRES"
        );
      } else if (selectedPortal.tipo === "procuraduria") {
        await selectCedulaType(page, "Procuraduría");
        documentFilled = await fillFirstVisibleText(page, args.documento, "Procuraduría");
        submitButton = await highlightSubmitButton(
          page,
          'input[type="submit"], button:has-text("Consultar")',
          "Procuraduría"
        );
      }

      if (requestTask.cancelled || queuePosition(req.sessionId) !== 1) {
        await browser.close();
        return res.status(409).json({ error: "La solicitud se canceló al salir de la cola." });
      }
      const isAdres = args.url_portal.includes("adres.gov.co");
      const screenshot = isAdres
        ? await captureAdresCaptcha(page)
        : (await page.screenshot({ type: "jpeg", quality: 65 })).toString("base64");
      activeSession = {
        browser,
        page,
        submitButton,
        isAdres,
        step: isAdres ? "enter_captcha" : "confirm_submit",
        profileCedula: profile.cedula,
      };
      activeSessionId = req.sessionId;
      lastPreviewData = args;
      return res.json({
        type: "preview",
        ...(isAdres ? { step: "enter_captcha" } : {}),
        reply: isAdres
          ? "Escribe el código de la imagen para continuar."
          : documentFilled
            ? `He preparado tu consulta en ${args.entidad}. Verifica los datos en pantalla y completa manualmente cualquier CAPTCHA antes de pulsar Aceptar y enviar.`
            : `Abrí el portal oficial de ${args.entidad}, pero no pude completar la casilla de documento. Verifica los datos en pantalla y completa manualmente cualquier CAPTCHA antes de pulsar Aceptar y enviar.`,
        screenshot,
        datos: args,
      });
    } catch (error) {
      await browser.close().catch((closeError) => {
        console.error("No se pudo cerrar Chromium tras fallar la preparación:", closeError);
      });
      throw error;
    }
  } catch (error) {
    console.error("Error en /api/chat:", error);
    if (error.status === 429) {
      return res.status(200).json({ reply: GROQ_RATE_LIMIT_REPLY });
    }
    return res.status(500).json({ error: error.message || "No fue posible preparar la previsualización." });
  } finally {
    if (chatInProgress === requestTask) chatInProgress = null;
    if (sessionTasks.get(req.sessionId) === requestTask) sessionTasks.delete(req.sessionId);
  }
});

app.post("/api/captcha", requireAgentToken, requireQueueFirst, async (req, res) => {
  const { captcha } = req.body || {};
  if (confirmationInProgress) {
    return res.status(409).json({ error: "La confirmación ya está en curso." });
  }
  const captchaText = captcha === undefined || captcha === null ? "" : String(captcha).trim();
  if (!captchaText) return res.status(400).json({ error: "Escribe el código de la imagen." });
  if (!activeSession || activeSessionId !== req.sessionId || !activeSession.isAdres || activeSession.step !== "enter_captcha") {
    return res.status(409).json({ error: "No hay una consulta ADRES esperando un código CAPTCHA." });
  }

  const session = activeSession;
  try {
    await fillAdresCaptcha(session.page, captchaText);

    session.submitButton = await highlightSubmitButton(
      session.page,
      "#btnConsultar, input[type='submit'], input[value*='Consultar' i]",
      "ADRES"
    );
    if (!session.submitButton) {
      return res.status(409).json({ error: "No se encontró el botón Consultar en ADRES." });
    }
    await session.page.waitForTimeout(400);
    const screenshot = (await session.page.screenshot({ type: "jpeg", quality: 75 })).toString("base64");
    session.step = "confirm_submit";
    return res.json({
      type: "preview",
      step: "confirm_submit",
      reply: "Revisa si el código quedó bien escrito. Puedes confirmar o restablecerlo.",
      screenshot,
      datos: lastPreviewData,
    });
  } catch (error) {
    console.error("Error al ingresar el código CAPTCHA de ADRES:", error);
    return res.status(500).json({ error: error.message || "No fue posible ingresar el código CAPTCHA." });
  }
});

app.post("/api/captcha/reset", requireAgentToken, requireQueueFirst, async (req, res) => {
  if (confirmationInProgress) return res.status(409).json({ error: "La confirmación ya está en curso." });
  if (!activeSession || activeSessionId !== req.sessionId || !activeSession.isAdres
    || activeSession.step !== "confirm_submit") {
    return res.status(409).json({ error: "No hay un código ADRES para restablecer." });
  }
  try {
    await fillAdresCaptcha(activeSession.page, "");
    activeSession.step = "enter_captcha";
    return res.json({
      type: "preview",
      step: "enter_captcha",
      reply: "Escribe el código de la imagen para continuar.",
      screenshot: await captureAdresCaptcha(activeSession.page),
      datos: lastPreviewData,
    });
  } catch (error) {
    console.error("No se pudo restablecer el código CAPTCHA de ADRES:", error.message);
    return res.status(500).json({ error: "No fue posible restablecer el código CAPTCHA." });
  }
});

app.post("/api/confirm", requireAgentToken, requireQueueFirst, async (req, res) => {
  const captchaCode = String((req.body && (req.body.captcha || req.body.code)) || "").trim();
  if (confirmationInProgress) return res.status(409).json({ error: "La confirmación ya está en curso." });
  if (!activeSession || activeSessionId !== req.sessionId) return res.status(409).json({ error: "No hay una previsualización activa para confirmar." });
  if (activeSession.isAdres && activeSession.step !== "confirm_submit") {
    return res.status(409).json({ error: "Primero ingresa el código CAPTCHA desde la previsualización." });
  }
  confirmationInProgress = true;
  const session = activeSession;
  const consultationData = lastPreviewData;
  try {
    if (session.isAdres) {
      if (captchaCode) {
        await fillAdresCaptcha(session.page, captchaCode);
      }

      const popupPromise = session.page.waitForEvent("popup", { timeout: 5500 }).catch(() => null);
      const consultaButton = session.page.locator(
        '#btnConsultar:visible, input[type="submit"]:visible, input[value*="Consultar" i]:visible'
      ).first();
      const submitButton = await consultaButton.count() > 0 ? consultaButton : session.submitButton;
      if (submitButton) {
        try {
          await submitButton.click({ timeout: 2000 });
        } catch (error) {
          console.warn("No se pudo pulsar Consultar en ADRES:", error.message);
        }
      } else {
        console.warn("No se encontró el botón Consultar en ADRES.");
      }

      const popupPage = await popupPromise;
      if (popupPage) {
        await popupPage.waitForLoadState("domcontentloaded").catch(() => {});
        await popupPage.waitForTimeout(1500);
        const screenshot = (await popupPage.screenshot({
          type: "jpeg",
          quality: 90,
          fullPage: true,
        })).toString("base64");
        const radicado = `COL360-${Date.now().toString().slice(-6)}`;
        saveConsultation(session.profileCedula, consultationData, radicado, screenshot);
        await session.browser.close();
        activeSession = null;
        activeSessionId = null;
        lastPreviewData = null;
        return res.json({ ok: true, step: "done", reply: "Consulta finalizada.", screenshot, radicado });
      }

      await fillAdresCaptcha(session.page, "");
      session.step = "enter_captcha";
      return res.json({
        ok: false,
        type: "preview",
        step: "enter_captcha",
        reply: "El código no coincidió. Escribe el nuevo código de la imagen.",
        screenshot: await captureAdresCaptcha(session.page),
        datos: lastPreviewData,
      });
    }

    let submitError = null;
    const submitButton = session.submitButton;
    if (submitButton) {
      try {
        await submitButton.click({ timeout: 2000 });
      } catch (error) {
        submitError = error;
        console.warn("No se pudo enviar la consulta desde el portal:", error.message);
      }
    } else {
      submitError = new Error("No se encontró un botón de consulta resaltado.");
    }
    await session.page.waitForTimeout(3500);
    const browserPages = session.page.context().pages().filter((page) => !page.isClosed());
    const finalPage = browserPages[browserPages.length - 1] || session.page;
    const screenshot = (await finalPage.screenshot({ type: "jpeg", quality: 70 })).toString("base64");
    if (submitError) {
      await session.browser.close();
      activeSession = null;
      activeSessionId = null;
      lastPreviewData = null;
      return res.json({
        ok: false,
        error: "No se pudo enviar la consulta. Comprueba el CAPTCHA y el estado del portal; no se generó una referencia.",
        screenshot,
      });
    }
    const radicado = `COL360-${Date.now().toString().slice(-6)}`;
    saveConsultation(session.profileCedula, consultationData, radicado, screenshot);
    await session.browser.close();
    activeSession = null;
    activeSessionId = null;
    lastPreviewData = null;
    return res.json({ ok: true, step: "done", screenshot, radicado });
  } catch (error) {
    if (session.isAdres && !session.page.isClosed()) {
      activeSession = session;
    } else {
      await session.browser.close().catch((closeError) => {
        console.error("No se pudo cerrar Chromium tras fallar la confirmación:", closeError);
      });
      activeSession = null;
      activeSessionId = null;
      lastPreviewData = null;
    }
    console.error("Error en /api/confirm:", error);
    return res.status(500).json({ error: error.message || "No fue posible confirmar el formulario." });
  } finally {
    confirmationInProgress = false;
  }
});

app.post("/api/cancel", requireAgentToken, requireQueueFirst, async (req, res) => {
  if (sessionTasks.has(req.sessionId)) sessionTasks.get(req.sessionId).cancelled = true;
  await closeActiveSession(req.sessionId);
  return res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("Error no controlado en Express:", err.message);
  return res.status(500).json({ error: err.message || "Error interno del servidor." });
});

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT debe ser un número entre 1 y 65535.");
  process.exitCode = 1;
} else {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Servidor Col360 listo en http://127.0.0.1:${PORT}`);
    console.log("Las rutas requieren un Bearer válido (API_SECRET_TOKEN, COL360_AGENT_TOKEN o token demo).");
  });
}
