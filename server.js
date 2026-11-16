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
const TARGET_URL = process.env.TARGET_URL || "https://httpbin.org/forms/post";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const REQUIRED_FIELDS = [
  "nombre_completo",
  "documento",
  "correo",
  "ciudad",
  "entidad",
  "servicio",
  "fecha",
  "hora",
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
};

const SYSTEM_PROMPT = `Eres el Agente Oficial de Col360 en Colombia. Ayudas a los ciudadanos a resolver dudas de trámites y a agendar citas. REGLA OBLIGATORIA: Antes de ejecutar la herramienta 'ejecutar_tramite_web', verifica que tengas TODOS los datos obligatorios del ciudadano: nombre completo, número de documento/cédula, correo electrónico, ciudad, entidad, tipo de servicio, fecha y hora. Revisa primero los datos de sesión del usuario que te llegan en el contexto; si falta alguno de esos datos, NO llames todavía a la herramienta y pídele al usuario de forma amable y directa en una sola respuesta los datos exactos que faltan. Solo cuando tengas los 8 datos completos, invoca 'ejecutar_tramite_web'.`;

const tool = {
  type: "function",
  function: {
    name: "ejecutar_tramite_web",
    description: "Diligencia un formulario web y lo deja listo para revisión, sin enviarlo.",
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
      },
      required: REQUIRED_FIELDS,
    },
  },
};

let activeSession = null;
let chatInProgress = false;
let confirmationInProgress = false;
const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

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
  return value.slice(-100).flatMap((entry) => {
    if (!entry || !["user", "assistant"].includes(entry.role) || typeof entry.content !== "string") return [];
    return [{ role: entry.role, content: entry.content.slice(0, 12000) }];
  });
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

function validateTargetUrl() {
  let target;
  try {
    target = new URL(TARGET_URL);
  } catch {
    throw new Error("TARGET_URL debe ser una URL absoluta válida.");
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("TARGET_URL debe usar HTTP o HTTPS y no puede contener credenciales.");
  }
  return target.toString();
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
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.2,
        tools: [tool],
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(60000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload && payload.error && payload.error.message;
      return res.status(502).json({ error: detail || `Groq respondió con estado ${response.status}.` });
    }

    const choice = payload && payload.choices && payload.choices[0];
    const assistantMessage = choice && choice.message;
    const calls = assistantMessage && assistantMessage.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) {
      const reply = assistantMessage && typeof assistantMessage.content === "string"
        ? assistantMessage.content.trim()
        : "";
      if (!reply) return res.status(502).json({ error: "Groq no devolvió texto ni una acción válida." });
      return res.json({ type: "text", reply });
    }

    if (calls.length !== 1 || calls[0].function.name !== "ejecutar_tramite_web") {
      return res.status(502).json({ error: "Groq devolvió una acción no reconocida." });
    }
    const parsed = parseToolArguments(calls[0].function.arguments);
    if (parsed.missing.length) {
      const missing = parsed.missing.map((field) => FIELD_LABELS[field]);
      return res.json({
        type: "text",
        reply: `Para continuar, indícame estos datos que faltan: ${missing.join(", ")}.`,
      });
    }

    const targetUrl = validateTargetUrl();
    const browser = await chromium.launch({ headless: false, slowMo: 300 });
    try {
      const page = await browser.newPage();
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.locator('[name="custname"]').fill(`${parsed.args.nombre_completo} - CC: ${parsed.args.documento}`);
      await page.locator('[name="custtel"]').fill(`${parsed.args.entidad} (${parsed.args.ciudad})`);
      await page.locator('[name="custemail"]').fill(parsed.args.correo);
      await page.locator('[name="delivery"]').fill(`${parsed.args.fecha} ${parsed.args.hora}`);
      await page.locator('[name="comments"]').fill(`${parsed.args.servicio} | ${parsed.args.observaciones}`);

      const submit = page.locator('button[type="submit"], input[type="submit"]').first();
      await submit.waitFor({ state: "visible", timeout: 10000 });
      await submit.evaluate((button) => {
        button.style.outline = "4px solid #dc2626";
        button.style.outlineOffset = "3px";
      });
      const screenshot = (await page.screenshot({ fullPage: true })).toString("base64");
      activeSession = { browser, page, args: parsed.args };
      return res.json({
        type: "preview",
        reply: "He ingresado al portal externo y diligenciado tus datos. Me he detenido antes de enviar para que confirmes:",
        screenshot,
        datos: parsed.args,
      });
    } catch (error) {
      await browser.close();
      throw error;
    }
  } catch (error) {
    console.error("Error en /api/chat:", error);
    return res.status(502).json({ error: error.message || "No fue posible preparar la previsualización." });
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
    const submit = session.page.locator('button[type="submit"], input[type="submit"]').first();
    await submit.click({ timeout: 10000 });
    await session.page.waitForTimeout(1000);
    const screenshot = (await session.page.screenshot({ fullPage: true })).toString("base64");
    const radicado = `COL360-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    await session.browser.close();
    return res.json({ ok: true, screenshot, radicado });
  } catch (error) {
    await session.browser.close().catch((closeError) => {
      console.error("No se pudo cerrar Chromium tras fallar la confirmación:", closeError);
    });
    console.error("Error en /api/confirm:", error);
    return res.status(502).json({ error: error.message || "No fue posible confirmar el formulario." });
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
