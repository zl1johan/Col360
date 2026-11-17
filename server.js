"use strict";

process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { chromium } = require("playwright");
const { promisify } = require("node:util");

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
const PASSWORD_MIN_LENGTH = 8;
const db = loadDatabase();
const pendingOtps = new Map();
const pendingResetOtps = new Map();
const pendingServerRequesters = db.pendingServerRequesters;
const completedServerWakeRequestIds = db.completedServerWakeRequestIds;
const queue = [];
const sessionTasks = new Map();
const scrypt = promisify(crypto.scrypt);
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
const SUPPORTED_SERVICES_REPLY = "Puedo darte orientación general paso a paso sobre trámites y servicios públicos en Colombia. La automatización de portales está disponible para SIMIT, ADRES y antecedentes disciplinarios de Procuraduría.";

const SYSTEM_PROMPT = `Eres el Agente Oficial de Col360 en Colombia. Puedes responder preguntas generales y explicar paso a paso cómo realizar trámites, solicitar citas o acceder a servicios públicos en Colombia, indicando la entidad oficial correspondiente. No inventes requisitos ni URLs; aclara cuándo un requisito debe verificarse con la entidad.
La automatización directa está limitada a estas tres consultas oficiales:
1. SIMIT (Multas / Comparendos) -> entidad: "SIMIT - Federación Colombiana de Municipios", tramite: "Estado de Cuenta Comparendos", url_portal: "https://www.fcm.org.co/simit/#/home-public"
2. ADRES (Salud / EPS) -> entidad: "ADRES - Ministerio de Salud", tramite: "Consulta de Afiliados BDUA", url_portal: "https://aplicaciones.adres.gov.co/bdua_internet/Pages/ConsultarAfiliadoWeb.aspx"
3. Procuraduría (Antecedentes Disciplinarios) -> entidad: "Procuraduría General de la Nación", tramite: "Certificado de Antecedentes Disciplinarios", url_portal: "https://apps.procuraduria.gov.co/webcert/inicio.aspx"
Menciona que la automatización está limitada a esos tres portales únicamente si la persona pide explícitamente automatizar otro portal. Una solicitud de información o guía sobre otro trámite debe recibir una respuesta útil y paso a paso sin mencionar esa limitación.
El ciudadano ya inició sesión y su perfil está registrado localmente. Nunca pidas nombre, cédula ni correo. Para SIMIT exige la placa del vehículo y nunca la sustituyas por la cédula; si no aparece una placa, pide específicamente la placa. Cuando se elija uno de los tres trámites y estén disponibles los datos requeridos, llama directamente a 'ejecutar_tramite_web' sin pedir confirmación textual repetida. La persona confirma la acción en la interfaz después de revisar la previsualización. No resuelvas CAPTCHA automáticamente; solicita que la persona lo complete.`;

const tool = {
  type: "function",
  function: {
    name: "ejecutar_tramite_web",
    description: "Abre uno de los tres portales oficiales permitidos, completa el dato registrado y espera la confirmación humana.",
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
          description: "Uno de los tres trámites oficiales permitidos.",
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
  origin(origin, callback) {
    const allowedOrigins = ["https://col360.site", "https://www.col360.site"];
    const isLocalBrowser = origin === "null"
      || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin || "");
    callback(null, !origin || isLocalBrowser || allowedOrigins.includes(origin));
  },
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning", "x-session-id"],
  methods: ["GET", "POST", "OPTIONS"],
};
app.use(cors(corsOptions));
// Express 5 rejects "*" as a route pattern; this regex matches every OPTIONS path.
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: "256kb" }));
const healthHandler = (req, res) => {
  notifyPendingServerRequesters().catch((error) => {
    console.error("No se pudieron procesar las solicitudes de encendido pendientes:", error.message);
  });
  return res.json({ status: "online", agent: "Col360" });
};
app.get("/", healthHandler);
app.get("/health", healthHandler);
async function requestServerWake(req, res) {
  const isReadyNotification = req.path === "/api/notify-server-ready";
  const body = req.body || {};
  const nombre = typeof body.nombre === "string" ? body.nombre.trim().slice(0, 160) : "";
  const correo = typeof body.correo === "string" ? body.correo.trim().toLowerCase().slice(0, 254) : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.trim().slice(0, 128) : "";
  if (!nombre || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return res.status(400).json({ ok: false, error: "Ingresa un nombre y un correo válido." });
  }
  if (requestId && completedServerWakeRequestIds.includes(requestId)) return res.json({ ok: true });
  const existing = pendingServerRequesters.find((requester) =>
    String(requester.correo || "").toLowerCase() === correo);
  if (existing) {
    existing.requestIds = Array.isArray(existing.requestIds) ? existing.requestIds : [];
    if (requestId && !existing.requestIds.includes(requestId)) existing.requestIds.push(requestId);
  } else {
    pendingServerRequesters.push({
      nombre,
      correo,
      fecha: new Date().toISOString(),
      requestIds: requestId ? [requestId] : [],
    });
  }
  try {
    saveDatabase();
  } catch (error) {
    if (!existing) pendingServerRequesters.pop();
    console.error("No se pudo guardar la solicitud de encendido:", error.message);
    return res.status(500).json({ ok: false, error: "No se pudo guardar la solicitud." });
  }
  if (!isReadyNotification) fetch("https://ntfy.sh/col360-johan-2026", {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8", Title: "Solicitud de encendido Col360" },
      body: "Hay una nueva solicitud de encendido de Server Col360.",
      signal: AbortSignal.timeout(5000),
    })
    .then((notification) => {
      if (!notification.ok) console.warn("ntfy respondió con estado", notification.status);
    })
    .catch((error) => console.warn("No se pudo enviar el aviso genérico de encendido a ntfy:", error.message));
  if (isReadyNotification) {
    try {
      await notifyPendingServerRequesters();
      const emailPending = pendingServerRequesters.some((requester) =>
        String(requester.correo || "").toLowerCase() === correo);
      if (emailPending) {
        return res.status(502).json({ ok: false, error: "No se pudo enviar el correo de aviso." });
      }
    } catch (error) {
      console.error("No se pudo procesar la solicitud de aviso de encendido:", error.message);
      return res.status(500).json({ ok: false, error: "No se pudo enviar el correo de aviso." });
    }
  } else {
    notifyPendingServerRequesters().catch((error) => {
      console.error("No se pudo procesar la solicitud de aviso de encendido:", error.message);
    });
  }
  return res.json({ ok: true });
}
app.post("/api/request-server-wake", requestServerWake);
app.post("/api/server-request", requestServerWake);
app.post("/api/notify-server-ready", requestServerWake);

function loadDatabase() {
  try {
    const stored = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!stored || !stored.users || typeof stored.users !== "object") {
      return { users: {}, pendingServerRequesters: [], completedServerWakeRequestIds: [] };
    }
    stored.pendingServerRequesters = Array.isArray(stored.pendingServerRequesters)
      ? stored.pendingServerRequesters
      : [];
    stored.completedServerWakeRequestIds = Array.isArray(stored.completedServerWakeRequestIds)
      ? stored.completedServerWakeRequestIds
      : [];
    return stored;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("No se pudo leer db.json; se iniciará una base vacía:", error.message);
    } else {
      fs.writeFileSync(DB_FILE, JSON.stringify({
        users: {},
        pendingServerRequesters: [],
        completedServerWakeRequestIds: [],
      }, null, 2), { mode: 0o600 });
    }
    return { users: {}, pendingServerRequesters: [], completedServerWakeRequestIds: [] };
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
  const correo = typeof profile.correo === "string" ? profile.correo.trim().slice(0, 254).toLowerCase() : "";
  const ciudad = typeof profile.ciudad === "string" ? profile.ciudad.trim().slice(0, 120) : "";
  if (!nombre || !/^\d{5,20}$/.test(cedula) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return null;
  }
  return { nombre, cedula, correo, ciudad };
}

function findUserByEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return Object.values(db.users).find((user) =>
    user && String(user.correo || "").trim().toLowerCase() === normalized) || null;
}

function publicUser(user) {
  const { password, ...profile } = user;
  return profile;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedHex] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !salt || !/^[a-f0-9]{128}$/i.test(expectedHex || "")) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = await scrypt(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function emailTemplate(title, message, highlighted) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const emphasis = highlighted
    ? `<p style="margin:22px 0;padding:16px;border-radius:12px;background:#edf4ff;color:#1649a5;text-align:center;font-size:30px;font-weight:700;letter-spacing:7px">${escape(highlighted)}</p>`
    : "";
  const safeMessage = escape(message);
  return {
    text: `${title}\n\n${message}${highlighted ? `\n\n${highlighted}` : ""}\n\nCol360 te conecta con información y servicios públicos. Ingresa de forma segura en https://col360.site y nunca compartas tus códigos.`,
    html: `<!doctype html><html lang="es"><body style="margin:0;padding:24px;background:#f4f7fb;font-family:Inter,Segoe UI,Arial,sans-serif;color:#17243b"><main style="max-width:520px;margin:0 auto;padding:24px;border:1px solid #e1e7f0;border-radius:18px;background:#fff"><header style="display:flex;align-items:center;gap:10px;margin-bottom:24px"><img src="https://col360.site/star.png" alt="Col360" width="36" height="36" style="display:block"><strong style="color:#102f67;font-size:20px">Col360</strong></header><h1 style="margin:0 0 12px;color:#102f67;font-size:22px">${escape(title)}</h1><p style="margin:0;color:#46546b;line-height:1.6">${safeMessage}</p>${emphasis}<footer style="margin-top:24px;padding-top:16px;border-top:1px solid #e1e7f0;color:#64728a;font-size:12px;line-height:1.6">Col360 te conecta con información y servicios públicos. Ingresa de forma segura en <a href="https://col360.site" style="color:#1649a5">col360.site</a> y nunca compartas tus códigos.</footer></main></body></html>`,
  };
}

async function sendCol360Email({ to, subject, title, message, code }) {
  const info = await mailTransport.sendMail({
    from: `"Col360" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject,
    ...emailTemplate(title, message, code),
  });
  if (Array.isArray(info.accepted)
    && !info.accepted.some((address) => String(address).toLowerCase() === to.toLowerCase())) {
    throw new Error(info.response || "El servidor SMTP rechazó el correo.");
  }
  return info;
}

let pendingEmailFlush = null;
async function notifyPendingServerRequesters() {
  if (!pendingServerRequesters.length) return;
  if (pendingEmailFlush) return pendingEmailFlush;
  pendingEmailFlush = (async () => {
    const sent = new Set();
    const completedSnapshot = completedServerWakeRequestIds.slice();
    for (const requester of pendingServerRequesters.slice()) {
      try {
        await sendCol360Email({
          to: requester.correo,
          subject: "El Server de Col360 ya está encendido",
          title: "El Server ya está encendido",
          message: `Hola ${requester.nombre}, Col360 está listo. Ya puedes iniciar sesión en https://col360.site.`,
        });
        sent.add(requester);
        for (const requestId of requester.requestIds || []) {
          if (!completedServerWakeRequestIds.includes(requestId)) {
            completedServerWakeRequestIds.push(requestId);
          }
        }
      } catch (error) {
        console.error(`No se pudo notificar el encendido a ${requester.correo}:`, error.message);
      }
    }
    if (sent.size) {
      const remaining = pendingServerRequesters.filter((requester) => !sent.has(requester));
      if (completedServerWakeRequestIds.length > 1000) {
        completedServerWakeRequestIds.splice(0, completedServerWakeRequestIds.length - 1000);
      }
      pendingServerRequesters.splice(0, pendingServerRequesters.length, ...remaining);
      try {
        saveDatabase();
      } catch (error) {
        console.error("No se pudieron guardar las solicitudes de encendido pendientes:", error.message);
        pendingServerRequesters.push(...Array.from(sent));
        completedServerWakeRequestIds.splice(0, completedServerWakeRequestIds.length, ...completedSnapshot);
      }
    }
  })().finally(() => { pendingEmailFlush = null; });
  return pendingEmailFlush;
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
      total: queue.length,
      reply: "Estás en espera en la fila. Podrás hablar con el agente en cuanto seas el puesto #1.",
    });
  }
  req.sessionId = sessionId;
  next();
}

app.post("/api/request-otp", async (req, res) => {
  const profile = normalizeProfile(req.body);
  if (!profile) return res.status(400).json({ ok: false, message: "Completa nombre, cédula y un correo válido." });
  if (!profile.ciudad) return res.status(400).json({ ok: false, message: "Selecciona una ciudad." });
  if (db.users[profile.cedula] || findUserByEmail(profile.correo)) {
    return res.status(409).json({ ok: false, message: "Ya existe una cuenta con esa cédula o correo. Inicia sesión o recupera tu contraseña." });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  pendingOtps.set(profile.cedula, {
    code,
    expiresAt: Date.now() + OTP_LIFETIME_MS,
    profile,
  });
  try {
    const info = await sendCol360Email({
      to: profile.correo,
      subject: "Tu código de acceso Col360",
      title: "Tu código de verificación",
      message: "Ingresa este código para completar tu registro. Vence en 10 minutos.",
      code,
    });
    const accepted = Array.isArray(info.accepted)
      && info.accepted.some((address) => String(address).toLowerCase() === profile.correo);
    if (!accepted) throw new Error(info.response || "Brevo rechazó la dirección de correo.");
    console.log("Respuesta SMTP Brevo:", info.messageId, info.accepted);
  } catch (error) {
    pendingOtps.delete(profile.cedula);
    console.error("No se pudo enviar el código de registro:", error.message);
    return res.status(500).json({ ok: false, message: "No se pudo enviar el código por correo." });
  }
  return res.json({ ok: true, message: "Código enviado. Revisa tu bandeja principal o spam." });
});

app.post("/api/register", async (req, res) => {
  const profile = normalizeProfile(req.body);
  const code = req.body && String(req.body.code || "").trim();
  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (!profile || !profile.ciudad) return res.status(400).json({ ok: false, error: "Completa los datos de registro y selecciona una ciudad." });
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 200) {
    return res.status(400).json({ ok: false, error: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.` });
  }
  if (db.users[profile.cedula] || findUserByEmail(profile.correo)) {
    return res.status(409).json({ ok: false, error: "Ya existe una cuenta con esa cédula o correo." });
  }
  const pending = profile && pendingOtps.get(profile.cedula);
  if (!pending || pending.expiresAt < Date.now() || pending.code !== code
    || pending.profile.correo !== profile.correo || pending.profile.nombre !== profile.nombre
    || pending.profile.ciudad !== profile.ciudad) {
    return res.status(400).json({ ok: false, error: "El código es inválido o venció. Solicita uno nuevo." });
  }
  const user = { ...profile, password: await hashPassword(password), history: [] };
  db.users[profile.cedula] = user;
  pendingOtps.delete(profile.cedula);
  try {
    saveDatabase();
  } catch (error) {
    delete db.users[profile.cedula];
    console.error("No se pudo guardar el perfil:", error.message);
    return res.status(500).json({ ok: false, error: "No se pudo guardar el perfil del usuario." });
  }
  return res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/login", async (req, res) => {
  const correo = typeof (req.body && req.body.correo) === "string"
    ? req.body.correo.trim().toLowerCase()
    : "";
  const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
  const user = findUserByEmail(correo);
  if (!user || !(await verifyPassword(password, user.password))) {
    return res.status(401).json({ ok: false, error: "El correo o la contraseña no coinciden." });
  }
  return res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/update-profile", (req, res) => {
  const body = req.body || {};
  const currentCedula = typeof body.currentCedula === "string"
    ? body.currentCedula.replace(/\D/g, "").slice(0, 20)
    : "";
  const nombre = typeof body.nombre === "string" ? body.nombre.trim().slice(0, 160) : "";
  const cedula = typeof body.cedula === "string" || typeof body.cedula === "number"
    ? String(body.cedula).replace(/\D/g, "").slice(0, 20)
    : "";
  const correo = typeof body.correo === "string" ? body.correo.trim().toLowerCase().slice(0, 254) : "";
  const user = db.users[currentCedula];
  if (!user || !correo || String(user.correo || "").trim().toLowerCase() !== correo) {
    return res.status(401).json({ ok: false, error: "No se pudo validar el perfil actual." });
  }
  if (!nombre || !/^\d{5,20}$/.test(cedula)) {
    return res.status(400).json({ ok: false, error: "Ingresa un nombre y una cédula válida." });
  }
  if (cedula !== currentCedula && db.users[cedula]) {
    return res.status(409).json({ ok: false, error: "Ya existe una cuenta con esa cédula." });
  }

  const previousName = user.nombre;
  const previousCedula = user.cedula;
  user.nombre = nombre;
  user.cedula = cedula;
  if (cedula !== currentCedula) {
    delete db.users[currentCedula];
    db.users[cedula] = user;
  }
  try {
    saveDatabase();
  } catch (error) {
    if (cedula !== currentCedula) {
      delete db.users[cedula];
      db.users[currentCedula] = user;
    }
    user.nombre = previousName;
    user.cedula = previousCedula;
    console.error("No se pudo actualizar el perfil:", error.message);
    return res.status(500).json({ ok: false, error: "No se pudieron guardar los cambios del perfil." });
  }
  return res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/forgot-password", async (req, res) => {
  const correo = typeof (req.body && req.body.correo) === "string"
    ? req.body.correo.trim().toLowerCase()
    : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return res.status(400).json({ ok: false, error: "Ingresa un correo válido." });
  }
  const user = findUserByEmail(correo);
  if (user) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    pendingResetOtps.set(correo, { code, expiresAt: Date.now() + OTP_LIFETIME_MS });
    try {
      await sendCol360Email({
        to: correo,
        subject: "Recuperación de contraseña Col360",
        title: "Recupera tu contraseña",
        message: "Ingresa este código para crear una nueva contraseña. Vence en 10 minutos.",
        code,
      });
    } catch (error) {
      pendingResetOtps.delete(correo);
      console.error("No se pudo enviar el código de recuperación:", error.message);
      return res.status(500).json({ ok: false, error: "No se pudo enviar el correo de recuperación." });
    }
  }
  return res.json({ ok: true, message: "Si el correo está registrado, recibirás un código de recuperación." });
});

app.post("/api/reset-password", async (req, res) => {
  const correo = typeof (req.body && req.body.correo) === "string"
    ? req.body.correo.trim().toLowerCase()
    : "";
  const code = String((req.body && req.body.code) || "").trim();
  const newPassword = req.body && typeof req.body.newPassword === "string" ? req.body.newPassword : "";
  const user = findUserByEmail(correo);
  const pending = pendingResetOtps.get(correo);
  if (!user || !pending || pending.expiresAt < Date.now() || pending.code !== code) {
    return res.status(400).json({ ok: false, error: "El código es inválido o venció. Solicita uno nuevo." });
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > 200) {
    return res.status(400).json({ ok: false, error: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.` });
  }
  const previousPassword = user.password;
  user.password = await hashPassword(newPassword);
  try {
    saveDatabase();
  } catch (error) {
    user.password = previousPassword;
    console.error("No se pudo guardar la nueva contraseña:", error.message);
    return res.status(500).json({ ok: false, error: "No se pudo actualizar la contraseña." });
  }
  pendingResetOtps.delete(correo);
  return res.json({ ok: true });
});

app.get("/api/user/:cedula", requireAgentToken, (req, res) => {
  const cedula = String(req.params.cedula || "").replace(/\D/g, "").slice(0, 20);
  const user = db.users[cedula];
  return res.json({ ok: true, user: user ? publicUser(user) : null });
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
    throw new Error("El portal no coincide exactamente con una de las URLs oficiales permitidas.");
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

async function fillProcuraduriaCaptcha(page, answer) {
  const selectors = [
    'input[id*="captcha" i]:visible',
    'input[name*="captcha" i]:visible',
    'input[id*="respuesta" i]:visible',
    'input[name*="respuesta" i]:visible',
    'input[placeholder*="respuesta" i]:visible',
  ];
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if (await field.count()) {
      await field.fill(String(answer).trim(), { timeout: 1500 });
      return;
    }
  }
  const textField = page.locator('input[type="text"]:visible').last();
  await textField.fill(String(answer).trim(), { timeout: 1500 });
}

async function captureCaptcha(page, portalType) {
  const image = page.locator(
    'img[id*="captcha" i], img[id*="capcha" i], img[src*="captcha" i], img[src*="capcha" i], img[alt*="captcha" i], img[alt*="capcha" i]'
  ).first();
  const hasCaptchaImage = await image.count() > 0;
  let target = image;
  if (!hasCaptchaImage && portalType === "procuraduria") {
    target = page.getByText(/(?:cu[aá]nto|resuelve|operaci[oó]n)\s*(?:es)?\s*\d+\s*[-+x×÷*]\s*\d+/i).first();
    if (!(await target.count())) {
      return (await page.screenshot({ type: "jpeg", quality: 90, fullPage: true })).toString("base64");
    }
  }
  await target.waitFor({ state: "visible", timeout: 3000 });
  await target.scrollIntoViewIfNeeded();
  let cropTarget = target;
  if (portalType === "procuraduria" && !hasCaptchaImage) {
    const parent = target.locator("xpath=..");
    if (await parent.count()) cropTarget = parent;
  }
  const box = await cropTarget.boundingBox();
  if (!box || box.width < 1 || box.height < 1) {
    throw new Error(`No se pudo localizar el CAPTCHA de ${portalType}.`);
  }
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("No se pudo determinar el tamaño de la ventana del portal.");
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const width = Math.min(box.width, viewport.width - x);
  const height = Math.min(box.height, viewport.height - y);
  if (width < 1 || height < 1) throw new Error("El CAPTCHA está fuera del área visible del portal.");
  return (await page.screenshot({
    type: "jpeg",
    quality: 92,
    clip: { x, y, width, height },
  })).toString("base64");
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

async function highlightProcuraduriaSubmitButton(page) {
  const specific = 'button:has-text("Consultar"):visible, input[value*="Consultar" i]:visible';
  if (await page.locator(specific).count() > 0) {
    return highlightSubmitButton(page, specific, "Procuraduría");
  }
  return highlightSubmitButton(page, 'input[type="submit"]:visible', "Procuraduría");
}

async function reloadProcuraduriaChallenge(session) {
  await session.page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  await session.page.waitForTimeout(900);
  await selectCedulaType(session.page, "Procuraduría");
  if (!lastPreviewData || !await fillFirstVisibleText(session.page, lastPreviewData.documento, "Procuraduría")) {
    throw new Error("No se pudo volver a completar el documento en Procuraduría.");
  }
  session.submitButton = await highlightProcuraduriaSubmitButton(session.page);
  if (!session.submitButton) throw new Error("No se encontró el botón Consultar en Procuraduría.");
  session.step = "enter_captcha";
}

function saveConsultation(cedula, data, radicado, screenshot) {
  const user = db.users[cedula];
  if (!user) throw new Error("No se encontró el perfil para guardar la consulta.");
  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    fecha: new Date().toISOString(),
    portal: data.entidad,
    radicado: radicado || "",
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
  const normalizedHistory = normalizeHistory(history);
  const plateMatch = message.match(/\b(?:[A-Z]{3}[\s-]?\d{3}|\d{3}[\s-]?[A-Z]{3}|[A-Z]{3}[\s-]?\d{2}[A-Z])\b/i);
  const simitIntent = /(?:simit|comparendos?|multas?|infracciones?)/i.test(message)
    || Boolean(plateMatch && normalizedHistory.some((entry) => /(?:simit|comparendos?|multas?|infracciones?)/i.test(entry.content)));
  const context = {
    profileRegistered: true,
  };
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: `Contexto de sesión del usuario (puede estar incompleto): ${JSON.stringify(context)}`,
    },
    ...normalizedHistory,
    { role: "user", content: message.trim().slice(0, 12000) },
  ];

  try {
    let calls;
    if (simitIntent) {
      if (!plateMatch) {
        return res.json({
          type: "text",
          reply: "Para consultar SIMIT necesito la placa del vehículo. Escríbela tal como aparece en la placa; no envíes tu cédula.",
        });
      }
      const simitPortal = SUPPORTED_PORTALS.find((portal) => portal.tipo === "simit");
      calls = [{
        function: {
          name: "ejecutar_tramite_web",
          arguments: JSON.stringify({
            entidad: simitPortal.entidad,
            tramite: simitPortal.tramite,
            documento: plateMatch[0],
            url_portal: simitPortal.url_portal,
          }),
        },
      }];
    } else {
      if (!process.env.GROQ_API_KEY) {
        return res.status(503).json({ error: "Configura GROQ_API_KEY en el archivo .env del servidor." });
      }
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
      calls = assistantMessage && assistantMessage.tool_calls;
      if (!Array.isArray(calls) || calls.length === 0) {
        const reply = assistantMessage && typeof assistantMessage.content === "string"
          ? assistantMessage.content.trim()
          : "";
        if (!reply) return res.status(500).json({ error: "Groq no devolvió texto ni una acción válida." });
        return res.json({ type: "text", reply });
      }
    }

    if (calls.length !== 1 || calls[0].function.name !== "ejecutar_tramite_web") {
      return res.status(500).json({ error: "Groq devolvió una acción no reconocida." });
    }
    const parsed = parseToolArguments(calls[0].function.arguments);
    const requestedPortal = SUPPORTED_PORTALS.find((portal) => portal.tramite === parsed.args.tramite);
    if (parsed.missing.includes("documento") && requestedPortal && requestedPortal.tipo !== "simit") {
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
    const documentValue = selectedPortal.tipo === "simit"
      ? (plateMatch ? plateMatch[0] : "")
      : profile.cedula;
    if (selectedPortal.tipo === "simit" && !documentValue) {
      return res.json({
        type: "text",
        reply: "Para consultar SIMIT necesito la placa del vehículo. Escríbela tal como aparece en la placa; no envíes tu cédula.",
      });
    }
    const args = {
      entidad: selectedPortal.entidad,
      tramite: selectedPortal.tramite,
      documento: documentValue,
      url_portal: validatePortalUrl(selectedPortal.url_portal),
      portal_corto: selectedPortal.tipo === "simit"
        ? "fcm.org.co/simit"
        : selectedPortal.tipo === "adres"
          ? "aplicaciones.adres.gov.co/bdua_internet"
          : "apps.procuraduria.gov.co/webcert",
      valor: documentValue,
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
          let field = page.locator('input[placeholder*="placa" i]:visible').first();
          if (await field.count() === 0) {
            field = page.locator('input[placeholder*="identificación" i]:visible').first();
          }
          if (await field.count() === 0) field = page.locator("input[type='text']:visible").first();
          await field.click({ timeout: 1500 });
          await field.fill(String(args.documento), { timeout: 1500 });
          documentFilled = true;
        } catch (error) {
          console.warn("No se pudo completar el documento o placa en SIMIT:", error.message);
        }
        if (!documentFilled) throw new Error("No se pudo completar en SIMIT la placa indicada por el usuario.");
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
        submitButton = await highlightProcuraduriaSubmitButton(page);
      }

      if (requestTask.cancelled || queuePosition(req.sessionId) !== 1) {
        await browser.close();
        return res.status(409).json({ error: "La solicitud se canceló al salir de la cola." });
      }
      const needsCaptcha = selectedPortal.tipo === "adres" || selectedPortal.tipo === "procuraduria";
      const screenshot = needsCaptcha
        ? await captureCaptcha(page, selectedPortal.tipo)
        : (await page.screenshot({ type: "jpeg", quality: 65 })).toString("base64");
      activeSession = {
        browser,
        page,
        submitButton,
        portalType: selectedPortal.tipo,
        isCaptchaPortal: needsCaptcha,
        step: needsCaptcha ? "enter_captcha" : "confirm_submit",
        profileCedula: profile.cedula,
      };
      activeSessionId = req.sessionId;
      lastPreviewData = args;
      return res.json({
        type: "preview",
        step: needsCaptcha ? "enter_captcha" : "confirm_simit",
        reply: selectedPortal.tipo === "simit"
          ? "He preparado tu consulta en SIMIT - Federación Colombiana de Municipios."
          : "",
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
  if (!activeSession || activeSessionId !== req.sessionId || !activeSession.isCaptchaPortal || activeSession.step !== "enter_captcha") {
    return res.status(409).json({ error: "No hay una consulta esperando un código CAPTCHA." });
  }

  const session = activeSession;
  try {
    if (session.portalType === "adres") await fillAdresCaptcha(session.page, captchaText);
    else await fillProcuraduriaCaptcha(session.page, captchaText);

    session.submitButton = session.portalType === "adres"
      ? await highlightSubmitButton(
        session.page,
        "#btnConsultar, input[type='submit'], input[value*='Consultar' i]",
        "ADRES"
      )
      : await highlightProcuraduriaSubmitButton(session.page);
    if (!session.submitButton) {
      return res.status(409).json({ error: `No se encontró el botón Consultar en ${session.portalType}.` });
    }
    await session.page.waitForTimeout(400);
    const screenshot = (await session.page.screenshot({ type: "jpeg", quality: 75 })).toString("base64");
    session.step = "confirm_submit";
    return res.json({
      type: "preview",
      step: "confirm_submit",
      reply: "",
      screenshot,
      datos: lastPreviewData,
      codigoIngresado: captchaText,
    });
  } catch (error) {
    console.error(`Error al ingresar el código CAPTCHA de ${session.portalType}:`, error);
    return res.status(500).json({ error: error.message || "No fue posible ingresar el código CAPTCHA." });
  }
});

app.post("/api/captcha/reset", requireAgentToken, requireQueueFirst, async (req, res) => {
  if (confirmationInProgress) return res.status(409).json({ error: "La confirmación ya está en curso." });
  if (!activeSession || activeSessionId !== req.sessionId || !activeSession.isCaptchaPortal
    || activeSession.step !== "confirm_submit") {
    return res.status(409).json({ error: "No hay un código para restablecer." });
  }
  try {
    if (activeSession.portalType === "adres") {
      await fillAdresCaptcha(activeSession.page, "");
      activeSession.step = "enter_captcha";
    } else {
      await reloadProcuraduriaChallenge(activeSession);
    }
    return res.json({
      type: "preview",
      step: "enter_captcha",
      reply: "",
      screenshot: await captureCaptcha(activeSession.page, activeSession.portalType),
      datos: lastPreviewData,
    });
  } catch (error) {
    console.error(`No se pudo restablecer el código CAPTCHA de ${activeSession.portalType}:`, error.message);
    return res.status(500).json({ error: "No fue posible restablecer el código CAPTCHA." });
  }
});

app.post("/api/confirm", requireAgentToken, requireQueueFirst, async (req, res) => {
  if (confirmationInProgress) return res.status(409).json({ error: "La confirmación ya está en curso." });
  if (!activeSession || activeSessionId !== req.sessionId) return res.status(409).json({ error: "No hay una previsualización activa para confirmar." });
  if (activeSession.isCaptchaPortal && activeSession.step !== "confirm_submit") {
    return res.status(409).json({ error: "Primero ingresa el código CAPTCHA desde la previsualización." });
  }
  confirmationInProgress = true;
  const session = activeSession;
  const consultationData = lastPreviewData;
  const getOpenPage = (page, fallback) => {
    if (page && !page.isClosed()) return page;
    if (fallback && !fallback.isClosed()) return fallback;
    throw new Error("El portal cerró la ventana de resultados.");
  };
  const closeBrowser = async (message) => {
    try {
      if (session.browser) await session.browser.close();
    } catch (closeError) {
      console.error(message, closeError);
    }
  };
  try {
    const isCaptchaPortal = session.isCaptchaPortal;
    let page = getOpenPage(session.page);
    const selector = session.portalType === "adres"
      ? '#btnConsultar:visible, input[type="submit"]:visible, input[value*="Consultar" i]:visible'
      : 'button:has-text("Consultar"):visible, input[value*="Consultar" i]:visible';
    const consultaButton = page.locator(selector).first();
    const submitButton = await consultaButton.count() > 0
      ? consultaButton
      : session.submitButton;
    if (!submitButton) throw new Error(`No se encontró el botón Consultar en ${session.portalType}.`);
    const popupPromise = isCaptchaPortal
      ? page.waitForEvent("popup", { timeout: 5500 }).catch(() => null)
      : Promise.resolve(null);
    page = getOpenPage(page);
    await submitButton.click({ timeout: 2500 });
    if (session.portalType === "simit") {
      page = getOpenPage(page);
      await page.waitForTimeout(3500);
      page = getOpenPage(page);
      const screenshot = (await page.screenshot({ type: "jpeg", quality: 75 })).toString("base64");
      saveConsultation(session.profileCedula, consultationData, "", screenshot);
      await closeBrowser("No se pudo cerrar Chromium tras la consulta:");
      activeSession = null;
      activeSessionId = null;
      lastPreviewData = null;
      return res.json({ ok: true, step: "done", screenshot });
    }

    const popupPage = await popupPromise;
    let finalPage = getOpenPage(popupPage, page);
    if (popupPage && !popupPage.isClosed()) {
      await popupPage.waitForLoadState("domcontentloaded").catch(() => {});
    }
    finalPage = getOpenPage(finalPage, page);
    let citizenSectionLoaded = false;
    if (session.portalType === "procuraduria") {
      finalPage = getOpenPage(finalPage, page);
      citizenSectionLoaded = await finalPage.getByText(/Datos del ciudadano/i).first()
        .waitFor({ state: "visible", timeout: 7000 })
        .then(() => true)
        .catch(() => false);
      if (citizenSectionLoaded) {
        finalPage = getOpenPage(finalPage, page);
        await finalPage.mouse.wheel(0, 380);
      }
    } else {
      finalPage = getOpenPage(finalPage, page);
      await finalPage.waitForTimeout(1800);
    }
    finalPage = getOpenPage(finalPage, page);
    const validationText = await finalPage.locator(
      '[role="alert"], .validation-summary-errors, .field-validation-error, .text-danger, .error, .mensaje-error'
    ).allInnerTexts().then((items) => items.join(" "));
    const captchaField = session.portalType === "adres"
      ? '#Capcha_txtCapcha:visible, input[id*="Capcha" i]:visible, input[id*="Captcha" i]:visible'
      : 'input[id*="captcha" i]:visible, input[name*="captcha" i]:visible, input[id*="respuesta" i]:visible';
    page = getOpenPage(session.page);
    const stillWaitingForCaptcha = !popupPage && await page.locator(captchaField).count() > 0;
    const challengeStillVisible = session.portalType === "procuraduria"
      && !citizenSectionLoaded
      && await getOpenPage(finalPage, page)
        .getByText(/(?:cu[aá]nto|resuelve|operaci[oó]n)\s*(?:es)?\s*\d+\s*[-+x×÷*]\s*\d+/i).count() > 0;
    const validationFailed = /incorrect|inv[aá]lid|no coincide|error/i.test(validationText);
    if (!citizenSectionLoaded && (validationFailed || stillWaitingForCaptcha || challengeStillVisible)) {
      if (session.portalType === "adres") {
        page = getOpenPage(session.page);
        await fillAdresCaptcha(page, "");
        session.step = "enter_captcha";
      } else {
        await reloadProcuraduriaChallenge(session);
      }
      return res.json({
        ok: false,
        type: "preview",
        step: "enter_captcha",
        reply: session.portalType === "adres"
          ? "El código no coincidió."
          : "La respuesta no coincidió.",
        transientReply: true,
        screenshot: await captureCaptcha(getOpenPage(session.page), session.portalType),
        datos: consultationData,
      });
    }
    if (session.portalType === "procuraduria" && !citizenSectionLoaded) {
      throw new Error("El portal no mostró la sección Datos del ciudadano después de consultar.");
    }
    finalPage = getOpenPage(finalPage, page);
    const screenshot = (await finalPage.screenshot({
      type: "jpeg",
      quality: 90,
      fullPage: true,
    })).toString("base64");
    saveConsultation(session.profileCedula, consultationData, "", screenshot);
    await closeBrowser("No se pudo cerrar Chromium tras la consulta:");
    activeSession = null;
    activeSessionId = null;
    lastPreviewData = null;
    return res.json({ ok: true, step: "done", screenshot });
  } catch (error) {
    if (session.isCaptchaPortal && session.page && !session.page.isClosed()) {
      activeSession = session;
    } else {
      await closeBrowser("No se pudo cerrar Chromium tras fallar la confirmación:");
      activeSession = null;
      activeSessionId = null;
      lastPreviewData = null;
    }
    console.error("Error en /api/confirm:", error);
    const message = error && error.message || "No fue posible confirmar el formulario.";
    if (session.portalType === "adres") {
      return res.status(200).json({ ok: false, error: message });
    }
    return res.status(500).json({ error: message });
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
    notifyPendingServerRequesters().catch((error) => {
      console.error("No se pudieron procesar las solicitudes de encendido pendientes:", error.message);
    });
  });
}
