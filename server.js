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
    entidad: "Contraloría General de la República",
    tramite: "Certificado de Antecedentes Fiscales",
    url_portal: "https://cfiscal.contraloria.gov.co/Certificados/CertificadoPersonaNatural.aspx",
    tipo: "contraloria",
  },
  {
    entidad: "Procuraduría General de la Nación",
    tramite: "Certificado de Antecedentes Disciplinarios",
    url_portal: "https://apps.procuraduria.gov.co/webcert/inicio.aspx",
    tipo: "procuraduria",
  },
];
const REQUIRED_FIELDS = ["entidad", "tramite", "documento", "url_portal"];
const SUPPORTED_SERVICES_REPLY = "En esta demo solo puedo realizar estas cuatro consultas oficiales: estado de cuenta de comparendos (SIMIT), afiliación en salud (ADRES), antecedentes fiscales (Contraloría) y antecedentes disciplinarios (Procuraduría).";

const SYSTEM_PROMPT = `Eres el Agente Oficial de Col360 en Colombia. Atiendes EXCLUSIVAMENTE estas cuatro consultas oficiales reales, sin inventar URLs ni mezclar entidades o trámites:
1. SIMIT (Multas / Comparendos) -> entidad: "SIMIT - Federación Colombiana de Municipios", tramite: "Estado de Cuenta Comparendos", url_portal: "https://www.fcm.org.co/simit/#/home-public"
2. ADRES (Salud / EPS) -> entidad: "ADRES - Ministerio de Salud", tramite: "Consulta de Afiliados BDUA", url_portal: "https://aplicaciones.adres.gov.co/bdua_internet/Pages/ConsultarAfiliadoWeb.aspx"
3. Contraloría (Antecedentes Fiscales) -> entidad: "Contraloría General de la República", tramite: "Certificado de Antecedentes Fiscales", url_portal: "https://cfiscal.contraloria.gov.co/Certificados/CertificadoPersonaNatural.aspx"
4. Procuraduría (Antecedentes Disciplinarios) -> entidad: "Procuraduría General de la Nación", tramite: "Certificado de Antecedentes Disciplinarios", url_portal: "https://apps.procuraduria.gov.co/webcert/inicio.aspx"
Si el ciudadano pide algo fuera de estos cuatro trámites, responde amablemente enumerando las cuatro opciones y NO llames a la herramienta. Antes de llamarla, verifica que tienes el trámite y el número de documento o la placa, según corresponda. Si falta alguno, pide solo el dato faltante. Llama a 'ejecutar_tramite_web' únicamente con la entidad, trámite y URL exactos de la misma opción. No resuelvas CAPTCHA automáticamente; deja la verificación para la persona usuaria en Chrome y solo envía después de su confirmación explícita.`;

const tool = {
  type: "function",
  function: {
    name: "ejecutar_tramite_web",
    description: "Abre únicamente uno de los cuatro portales oficiales permitidos, rellena el documento o placa y espera la confirmación humana.",
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
let chatInProgress = false;
let confirmationInProgress = false;
const app = express();
const corsOptions = {
  origin: [
    "https://col360.site",
    "https://www.col360.site",
  ],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"],
  methods: ["GET", "POST", "OPTIONS"],
};
app.use(cors(corsOptions));
// Express 5 rejects "*" as a route pattern; this regex matches every OPTIONS path.
app.options(/.*/, cors(corsOptions));
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
      const missing = parsed.missing.map((field) =>
        field === "tramite" ? "trámite" : "número de documento o placa");
      return res.json({
        type: "text",
        reply: `Para continuar, indícame el ${missing.join(" y el ")}.`,
      });
    }

    const selectedPortal = SUPPORTED_PORTALS.find((portal) => portal.tramite === parsed.args.tramite);
    if (!selectedPortal) {
      return res.json({ type: "text", reply: SUPPORTED_SERVICES_REPLY });
    }
    const args = {
      entidad: selectedPortal.entidad,
      tramite: selectedPortal.tramite,
      documento: parsed.args.documento,
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
      await page.waitForTimeout(1500);
      let documentFilled = false;
      let submitButton = null;
      if (selectedPortal.tipo === "simit") {
        try {
          await page.keyboard.press("Escape");
        } catch (error) {
          console.warn("No se pudo cerrar el anuncio de SIMIT con Escape:", error.message);
        }
        try {
          await page.locator(
            'button.close, .modal .close, button:has-text("Cerrar"), button:has-text("Entendido"), [aria-label="Close"], .btn-close'
          ).first().click({ timeout: 1200 });
        } catch (error) {
          if (error.name !== "TimeoutError") {
            console.warn("No se pudo cerrar el anuncio emergente de SIMIT:", error.message);
          }
        }
        documentFilled = await fillFirstVisibleText(page, args.documento, "SIMIT");
        submitButton = await highlightSubmitButton(
          page,
          'button[type="submit"], button:has(svg), button.btn-primary',
          "SIMIT"
        );
      } else if (selectedPortal.tipo === "adres") {
        documentFilled = await fillFirstVisibleText(page, args.documento, "ADRES");
        submitButton = await highlightSubmitButton(
          page,
          'input[type="submit"], input[value*="Consultar" i]',
          "ADRES"
        );
      } else if (selectedPortal.tipo === "contraloria") {
        await selectCedulaType(page, "Contraloría");
        documentFilled = await fillFirstVisibleText(page, args.documento, "Contraloría");
        submitButton = await highlightSubmitButton(
          page,
          'input[type="submit"], button:has-text("Buscar")',
          "Contraloría"
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

      const screenshot = (await page.screenshot({ type: "jpeg", quality: 65 })).toString("base64");
      activeSession = { browser, page, submitButton };
      return res.json({
        type: "preview",
        reply: documentFilled
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
    let submitError = null;
    if (session.submitButton) {
      try {
        await session.submitButton.click({ timeout: 2000 });
      } catch (error) {
        submitError = error;
        console.warn("No se pudo enviar la consulta desde el portal:", error.message);
      }
    } else {
      submitError = new Error("No se encontró un botón de consulta resaltado.");
    }
    await session.page.waitForTimeout(2500);
    const screenshot = (await session.page.screenshot({ type: "jpeg", quality: 65 })).toString("base64");
    await session.browser.close();
    if (submitError) {
      return res.json({
        ok: false,
        error: "No se pudo enviar la consulta. Comprueba el CAPTCHA y el estado del portal; no se generó una referencia.",
        screenshot,
      });
    }
    const radicado = `COL360-${Date.now().toString().slice(-6)}`;
    return res.json({ ok: true, screenshot, radicado });
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
