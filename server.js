"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
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
const OFFICIAL_PORTAL_DOMAINS = [
  "gov.co",
  "saludtotal.com.co",
  "nuevaeps.com.co",
  "epssanitas.com",
  "epssura.com",
];
const VISIBLE_TEXT_INPUTS = [
  'input[type="text"]:visible',
  'input[type="number"]:visible',
  'input[type="email"]:visible',
  'input:not([type]):visible',
].join(", ");
let cachedGroqApiKey = "";
let cachedGroqModel = "";
const REQUIRED_FIELDS = [
  "nombre_completo",
  "documento",
  "correo",
  "ciudad",
  "entidad",
  "servicio",
  "fecha",
  "hora",
  "url_portal",
];
const FIELD_LABELS = {
  nombre_completo: "nombre completo",
  documento: "número de documento/cédula",
  correo: "correo electrónico",
  ciudad: "ciudad",
  entidad: "entidad",
  servicio: "tipo de servicio",
  fecha: "fecha",
  hora: "hora",
  url_portal: "URL oficial del portal",
};

const SYSTEM_PROMPT = `Eres el Agente Oficial de Col360 en Colombia. Ayudas a los ciudadanos a resolver dudas de trámites y a agendar citas. REGLA OBLIGATORIA: Antes de ejecutar la herramienta 'ejecutar_tramite_web', verifica que tengas TODOS los datos obligatorios del ciudadano: nombre completo, número de documento/cédula, correo electrónico, ciudad, entidad, tipo de servicio, fecha y hora. Revisa primero los datos de sesión del usuario que te llegan en el contexto; si falta alguno de esos datos, NO llames todavía a la herramienta y pídele al usuario de forma amable y directa en una sola respuesta los datos exactos que faltan. Solo cuando tengas los 8 datos del ciudadano y la URL oficial real de la entidad, invoca 'ejecutar_tramite_web'. En url_portal prioriza la URL directa de citas o atención virtual si la conoces; por ejemplo Salud Total https://www.saludtotal.com.co/, Registraduría https://wsp.registraduria.gov.co/citas/asignacion-cita/, DIAN https://muisca.dian.gov.co/, Nueva EPS https://www.nuevaeps.com.co/, EPS Sanitas https://www.epssanitas.com/, EPS Sura https://www.epssura.com/ y MinSalud https://www.minsalud.gov.co/. Si no conoces la URL directa, usa la URL oficial de la entidad. No inventes dominios; el navegador solo acepta dominios oficiales gubernamentales o EPS permitidas.`;

const tool = {
  type: "function",
  function: {
    name: "ejecutar_tramite_web",
    description: "Abre el portal oficial indicado, diligencia los campos visibles coincidentes y lo deja listo para revisión, sin enviarlo.",
    parameters: {
      type: "object",
      properties: {
        nombre_completo: { type: "string", description: "Nombre completo del ciudadano." },
        documento: { type: "string", description: "Cédula o tarjeta de identidad." },
        correo: { type: "string", description: "Correo electrónico del ciudadano." },
        ciudad: { type: "string", description: "Ciudad del trámite." },
        entidad: { type: "string", description: "Entidad pública, por ejemplo MinSalud o DIAN." },
        servicio: { type: "string", description: "Servicio o trámite solicitado." },
        fecha: { type: "string", description: "Fecha solicitada." },
        hora: { type: "string", description: "Hora solicitada." },
        observaciones: { type: "string", description: "Observaciones opcionales." },
        url_portal: { type: "string", description: "URL HTTPS oficial del portal colombiano de la entidad." },
      },
      required: REQUIRED_FIELDS,
    },
  },
};

let activeSession = null;
let chatInProgress = false;
let confirmationInProgress = false;
const app = express();
const corsOptions = {
  origin: "*",
  allowedHeaders: ["Content-Type", "Authorization", "Bypass-Tunnel-Reminder"],
  methods: ["GET", "POST", "OPTIONS"],
};
app.use(cors(corsOptions));
// Express 5 rejects "*" as a route pattern; this regex matches every OPTIONS path.
app.options(/.*/, cors());
app.use(express.json({ limit: "256kb" }));
const healthHandler = (req, res) => res.json({ status: "online", agent: "Col360" });
app.get("/", healthHandler);
app.get("/health", healthHandler);

function requireAgentToken(req, res, next) {
  const authorization = req.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expected = process.env.COL360_AGENT_TOKEN || "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (!expected || suppliedBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
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
  for (const field of [...REQUIRED_FIELDS, "observaciones"]) {
    normalized[field] = typeof args[field] === "string" ? args[field].trim().slice(0, 1000) : "";
  }
  const missing = REQUIRED_FIELDS.filter((field) => !normalized[field]);
  if (missing.length) {
    return {
      missing,
      args: normalized,
    };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.correo)) {
    throw new Error("El correo electrónico del trámite no tiene un formato válido.");
  }
  return { missing: [], args: normalized };
}

function validatePortalUrl(value) {
  let portal;
  try {
    portal = new URL(value);
  } catch {
    throw new Error("url_portal debe ser una URL absoluta válida.");
  }
  const hostname = portal.hostname.toLowerCase().replace(/\.$/, "");
  const isOfficialDomain = OFFICIAL_PORTAL_DOMAINS.some((domain) =>
    hostname === domain || hostname.endsWith(`.${domain}`));
  if (portal.protocol !== "https:" || portal.username || portal.password || portal.port || !isOfficialDomain) {
    throw new Error("url_portal debe usar HTTPS y pertenecer a un dominio gubernamental o EPS oficial permitido.");
  }
  return portal.toString();
}

function normalizeFieldDescription(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

async function fillVisibleFields(page, args) {
  const fields = page.locator(VISIBLE_TEXT_INPUTS);
  const count = await fields.count();
  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index);
    try {
      const metadata = await field.evaluate((element) => {
        return [element.placeholder, element.name, element.id, element.getAttribute("aria-label")]
          .filter(Boolean).join(" ");
      });
      const description = normalizeFieldDescription(metadata);
      const key = /(document|cedula|identificacion|identity|usuario)/.test(description)
        ? "documento"
        : /(nombre|full.?name|first.?name|last.?name|(^|[_\s-])name($|[_\s-]))/.test(description)
          ? "nombre_completo"
          : /(correo|e.?mail)/.test(description)
            ? "correo"
            : /(ciudad|city|municipio|localidad)/.test(description)
              ? "ciudad"
              : "";
      if (!key || !args[key]) continue;
      await field.fill(args[key], { timeout: 1000 });
    } catch (error) {
      if (error.name !== "TimeoutError") {
        console.warn("No se pudo completar un campo visible del portal:", error.message);
      }
    }
  }
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

app.post("/api/chat", requireAgentToken, async (req, res) => {
  const { message, userContext, history } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "El mensaje es obligatorio." });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: "Configura GROQ_API_KEY en el archivo .env del servidor." });
  }
  if (activeSession || chatInProgress) {
    return res.status(409).json({ error: "Ya hay una solicitud o previsualización activa. Confírmala o cancélala primero." });
  }
  chatInProgress = true;

  const context = normalizeContext(userContext);
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
    if (parsed.missing.length) {
      const missing = parsed.missing.map((field) => FIELD_LABELS[field]);
      return res.json({
        type: "text",
        reply: `Para continuar, indícame estos datos que faltan: ${missing.join(", ")}.`,
      });
    }

    const portalUrl = validatePortalUrl(parsed.args.url_portal);
    const browser = await chromium.launch({ headless: false, slowMo: 250 });
    try {
      let page = await browser.newPage();
      page.setDefaultTimeout(1000);
      await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2000);

      try {
        await page.locator(
          'button:visible:has-text("Aceptar todo"), button:visible:has-text("Aceptar"), button:visible:has-text("Entendido")'
        ).first().click({ timeout: 1500 });
      } catch (error) {
        if (error.name !== "TimeoutError") {
          console.warn("No se pudo cerrar el aviso de cookies:", error.message);
        }
      }

      if (await page.locator(VISIBLE_TEXT_INPUTS).count() === 0) {
        const context = page.context();
        const originalPages = new Set(context.pages());
        try {
          await page.locator(
            'a:visible:has-text("Oficina Virtual"), a:visible:has-text("Citas"), a:visible:has-text("Agendar"), a:visible:has-text("Trámites"), a:visible:has-text("Ingresar"), button:visible:has-text("Oficina Virtual"), button:visible:has-text("Citas"), button:visible:has-text("Agendar"), button:visible:has-text("Trámites"), button:visible:has-text("Ingresar")'
          ).first().click({ timeout: 2500 });
        } catch (error) {
          if (error.name !== "TimeoutError") {
            console.warn("No se pudo abrir la sección de citas o trámites:", error.message);
          }
        }
        await page.waitForTimeout(2500);
        const newPage = context.pages().find((candidate) => !originalPages.has(candidate));
        if (newPage) {
          page = newPage;
          await page.bringToFront();
          page.setDefaultTimeout(1000);
        }
      }

      await fillVisibleFields(page, parsed.args);

      let submitButton = null;
      try {
        const candidate = page.locator(
          'button[type="submit"]:visible, input[type="submit"]:visible, button:visible:has-text("Ingresar"), button:visible:has-text("Continuar"), button:visible:has-text("Agendar"), button:visible:has-text("Consultar"), button:visible:has-text("Enviar")'
        ).first();
        await candidate.waitFor({ state: "visible", timeout: 2000 });
        await candidate.scrollIntoViewIfNeeded({ timeout: 2000 });
        await candidate.evaluate((button) => {
          button.style.outline = "4px solid #dc2626";
          button.style.outlineOffset = "3px";
        });
        submitButton = candidate;
      } catch (error) {
        console.warn("No se encontró un botón principal visible en el portal:", error.message);
      }

      const screenshot = (await page.screenshot({ type: "jpeg", quality: 60 })).toString("base64");
      activeSession = { browser, page, args: parsed.args, submitButton };
      return res.json({
        type: "preview",
        reply: `He ingresado al portal oficial de ${parsed.args.entidad} y me he detenido antes de continuar/enviar. Revisa la captura:`,
        screenshot,
        datos: parsed.args,
      });
    } catch (error) {
      await browser.close();
      throw error;
    }
  } catch (error) {
    console.error("Error en /api/chat:", error);
    if (error.status === 429) {
      return res.status(200).json({ reply: GROQ_RATE_LIMIT_REPLY });
    }
    return res.status(500).json({ error: error.message || "No fue posible preparar la previsualización." });
  } finally {
    chatInProgress = false;
  }
});

app.post("/api/confirm", requireAgentToken, async (req, res) => {
  if (confirmationInProgress) return res.status(409).json({ error: "La confirmación ya está en curso." });
  if (!activeSession) return res.status(409).json({ error: "No hay una previsualización activa para confirmar." });
  confirmationInProgress = true;
  const session = activeSession;
  activeSession = null;
  try {
    let radicado = "";
    if (session.submitButton) {
      try {
        await session.submitButton.click({ timeout: 2000 });
        radicado = `COL360-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      } catch (error) {
        console.warn("No se pudo activar el botón principal del portal:", error.message);
      }
    }
    await session.page.waitForTimeout(1500);
    const screenshot = (await session.page.screenshot({ type: "jpeg", quality: 60 })).toString("base64");
    await session.browser.close();
    return res.json({ ok: true, screenshot, radicado, sent: Boolean(radicado) });
  } catch (error) {
    await session.browser.close().catch((closeError) => {
      console.error("No se pudo cerrar Chromium tras fallar la confirmación:", closeError);
    });
    console.error("Error en /api/confirm:", error);
    return res.status(500).json({ error: error.message || "No fue posible confirmar el formulario." });
  } finally {
    confirmationInProgress = false;
  }
});

app.post("/api/cancel", requireAgentToken, async (req, res) => {
  if (confirmationInProgress) {
    return res.status(409).json({ error: "La confirmación ya está en curso y no se puede cancelar." });
  }
  if (chatInProgress) {
    return res.status(409).json({ error: "La previsualización todavía se está preparando." });
  }
  if (activeSession) {
    const session = activeSession;
    activeSession = null;
    try {
      await session.browser.close();
    } catch (error) {
      console.error("Error al cerrar Chromium durante la cancelación:", error);
      return res.status(500).json({ error: "No fue posible cerrar la sesión de navegador." });
    }
  }
  return res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("Error no controlado en Express:", err.message);
  return res.status(500).json({ error: err.message || "Error interno del servidor." });
});

if (!process.env.COL360_AGENT_TOKEN) {
  console.error("Falta COL360_AGENT_TOKEN. Configura un token aleatorio en .env antes de iniciar el servidor.");
  process.exitCode = 1;
} else if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT debe ser un número entre 1 y 65535.");
  process.exitCode = 1;
} else {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Servidor Col360 listo en http://127.0.0.1:${PORT}`);
    console.log("Las rutas requieren Authorization: Bearer <COL360_AGENT_TOKEN>.");
  });
}
